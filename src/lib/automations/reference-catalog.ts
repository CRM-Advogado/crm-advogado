import type { SupabaseClient } from '@supabase/supabase-js'
import type { ReferenceCatalog } from './import'

// ------------------------------------------------------------
// Carrega tudo que um documento de import pode referenciar por nome.
//
// É a metade impura do import: `import.ts` recebe este catálogo
// pronto, e é isso que o torna testável sem banco.
//
// Cinco consultas em paralelo, não uma por referência. Um arquivo com
// 50 automações citando a mesma tag faria 50 idas ao banco no modelo
// ingênuo; aqui o custo é fixo e independe do tamanho do arquivo.
//
// Escopo: a migration 017 trocou o RLS por conta
// (`is_account_member(account_id)`), então o cliente SSR já limita as
// linhas ao inquilino do chamador. O `.eq('account_id', …)` explícito
// é redundante de propósito — se alguém trocar este cliente pelo
// service-role, que ignora RLS, o filtro continua de pé.
// ------------------------------------------------------------

export async function loadReferenceCatalog(
  supabase: SupabaseClient,
  accountId: string,
): Promise<ReferenceCatalog> {
  const [tags, pipelines, stages, members, customFields] = await Promise.all([
    supabase.from('tags').select('id, name').eq('account_id', accountId),
    supabase.from('pipelines').select('id, name').eq('account_id', accountId),
    // `pipeline_stages` não tem `account_id` — a migration 017 não a
    // incluiu na lista de tabelas que ganharam a coluna. O vínculo
    // com a conta existe só através de `pipelines`, e é por isso que
    // o filtro aqui é o join `!inner` em vez de um `.eq` direto.
    supabase
      .from('pipeline_stages')
      .select('id, name, pipeline_id, pipelines!inner(account_id)')
      .eq('pipelines.account_id', accountId),
    supabase
      .from('profiles')
      .select('user_id, full_name, email')
      .eq('account_id', accountId),
    supabase.from('custom_fields').select('id, field_name').eq('account_id', accountId),
  ])

  const firstError =
    tags.error ?? pipelines.error ?? stages.error ?? members.error ?? customFields.error
  if (firstError) throw new Error(firstError.message)

  return {
    tags: (tags.data ?? []).map((t) => ({ id: t.id as string, name: t.name as string })),
    pipelines: (pipelines.data ?? []).map((p) => ({
      id: p.id as string,
      name: p.name as string,
    })),
    stages: (stages.data ?? []).map((s) => ({
      id: s.id as string,
      name: s.name as string,
      pipeline_id: s.pipeline_id as string,
    })),
    // `agent_id` guarda `profiles.user_id`, não `profiles.id` — é o
    // que o motor grava em `conversations.assigned_agent_id` e o que
    // o modo round_robin lê (engine.ts).
    //
    // Cada pessoa entra DUAS vezes: pelo nome e pelo e-mail. Assim
    // "Ana Souza" e "ana@escritorio.com" resolvem para o mesmo id; e
    // quando duas pessoas têm o mesmo nome completo, o nome vira
    // ambíguo (correto) enquanto o e-mail continua resolvendo
    // (também correto). O nome vem primeiro porque o export usa a
    // primeira entrada que casa com o id, e "Ana Souza" se lê melhor
    // num arquivo que alguém vai editar à mão.
    agents: (members.data ?? []).flatMap((m) => {
      const id = m.user_id as string
      const entries = [{ id, name: (m.full_name as string) ?? '' }]
      const email = m.email as string | null
      if (email) entries.push({ id, name: email })
      return entries.filter((e) => e.name.trim() !== '')
    }),
    customFields: (customFields.data ?? []).map((f) => ({
      id: f.id as string,
      name: f.field_name as string,
    })),
  }
}
