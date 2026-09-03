import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { insertSteps } from '@/lib/automations/steps-tree'
import { loadReferenceCatalog } from '@/lib/automations/reference-catalog'
import {
  IMPORT_LIMITS,
  checkWebhookUrls,
  parseImportDocument,
  type ImportIssue,
} from '@/lib/automations/import'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

// ------------------------------------------------------------
// POST /api/automations/import              → importa (201)
// POST /api/automations/import?dry_run=true → só valida (200)
//
// A importação é TUDO OU NADA: o documento inteiro é validado antes
// de qualquer gravação. Sem isso, um arquivo de 20 automações com
// erro na 12ª deixaria 11 criadas e nenhuma forma óbvia de saber onde
// parou — e reenviar o arquivo corrigido duplicaria as 11.
//
// `dry_run` é o mesmo caminho sem o INSERT final. É o que a tela usa
// para mostrar a prévia antes de confirmar.
//
// Erros seguem `{ error: string, issues: [...] }`, a forma que a rota
// POST /api/automations já usa para recusar ativação: rotas de
// dashboard falam `{ error: string }`; o envelope `{ error: { code,
// message } }` é da API pública `/api/v1`.
// ------------------------------------------------------------

export async function POST(request: Request) {
  let ctx
  try {
    // Import cria automações — mesma escrita que POST /api/automations,
    // mesmo papel mínimo. A gravação usa o cliente service-role, que
    // ignora a política `automations_insert`, então o papel precisa
    // ser exigido aqui.
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'

  // Corpo lido como texto para medir ANTES do parse: `JSON.parse` de
  // um arquivo de centenas de MB trava o processo antes de qualquer
  // validação ter chance de recusá-lo.
  const raw = await request.text()
  if (raw.length > IMPORT_LIMITS.maxBytes) {
    return NextResponse.json(
      {
        error: `File is larger than ${Math.floor(IMPORT_LIMITS.maxBytes / 1024)} KB`,
        issues: [] as ImportIssue[],
      },
      { status: 413 },
    )
  }

  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return NextResponse.json(
      {
        error: 'File is not valid JSON',
        issues: [
          { path: '', message: 'could not parse the file', code: 'invalid_document' },
        ],
      },
      { status: 400 },
    )
  }

  let catalog
  try {
    catalog = await loadReferenceCatalog(ctx.supabase, ctx.accountId)
  } catch (err) {
    console.error('[POST /api/automations/import] catalog load failed:', err)
    return NextResponse.json({ error: 'Could not load account references' }, { status: 500 })
  }

  const { automations, issues } = parseImportDocument(doc, catalog)

  // SSRF: uma URL interna gravada passa despercebida para sempre — o
  // motor recusa entregar, mas em silêncio e só na primeira execução.
  // O cache evita repetir a resolução de DNS da mesma URL citada em
  // dezenas de automações.
  const seen = new Map<string, Promise<boolean>>()
  const webhookIssues = await checkWebhookUrls(automations, (url) => {
    const hit = seen.get(url)
    if (hit) return hit
    const p = isDeliverableUrl(url)
    seen.set(url, p)
    return p
  })
  issues.push(...webhookIssues)

  if (issues.length > 0) {
    return NextResponse.json(
      { error: 'The file has problems that must be fixed before importing', issues },
      { status: 422 },
    )
  }

  const preview = automations.map((a) => ({
    name: a.name,
    trigger_type: a.trigger_type,
    is_active: a.is_active,
    step_count: countSteps(a.steps),
  }))

  if (dryRun) {
    return NextResponse.json({ dry_run: true, automations: preview })
  }

  // ---- Gravação -------------------------------------------------
  // Uma única instrução para as automações (atômica no Postgres) e
  // depois os passos. Se os passos falharem, as automações recém
  // criadas são apagadas — `automation_steps.automation_id` é
  // ON DELETE CASCADE (migration 006), então isso não deixa resto.
  const admin = supabaseAdmin()

  const { data: created, error: insertErr } = await admin
    .from('automations')
    .insert(
      automations.map((a) => ({
        user_id: ctx.userId,
        account_id: ctx.accountId,
        name: a.name,
        description: a.description,
        trigger_type: a.trigger_type,
        trigger_config: a.trigger_config,
        is_active: a.is_active,
      })),
    )
    .select()

  if (insertErr || !created || created.length !== automations.length) {
    console.error('[POST /api/automations/import] insert failed:', insertErr)
    return NextResponse.json({ error: 'Could not create the automations' }, { status: 500 })
  }

  // A ordem do `.select()` acompanha a do `.insert()`, então índice a
  // índice cada linha criada corresponde à automação do documento.
  for (let i = 0; i < created.length; i++) {
    const stepErr = await insertSteps(created[i].id as string, automations[i].steps)
    if (!stepErr) continue

    console.error('[POST /api/automations/import] steps failed, rolling back:', stepErr)
    const ids = created.map((c) => c.id as string)
    const { error: cleanupErr } = await admin.from('automations').delete().in('id', ids)
    if (cleanupErr) {
      // Não é recuperável automaticamente; registrar os ids é o que
      // permite limpar à mão depois.
      console.error(
        '[POST /api/automations/import] rollback failed, orphaned automations:',
        ids,
        cleanupErr,
      )
    }
    return NextResponse.json(
      { error: 'Could not create the automation steps' },
      { status: 500 },
    )
  }

  return NextResponse.json({ imported: created.length, automations: preview }, { status: 201 })
}

function countSteps(steps: { branches?: { yes?: unknown[]; no?: unknown[] } }[]): number {
  let n = 0
  for (const s of steps) {
    n++
    const yes = (s.branches?.yes ?? []) as typeof steps
    const no = (s.branches?.no ?? []) as typeof steps
    n += countSteps(yes) + countSteps(no)
  }
  return n
}
