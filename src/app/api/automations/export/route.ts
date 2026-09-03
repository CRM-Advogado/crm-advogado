import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadStepsTree } from '@/lib/automations/steps-tree'
import { loadReferenceCatalog } from '@/lib/automations/reference-catalog'
import { buildExportDocument, type ExportableAutomation } from '@/lib/automations/export'

// ------------------------------------------------------------
// GET /api/automations/export            → todas as automações
// GET /api/automations/export?ids=a,b    → só essas
//
// Produz exatamente o documento que POST /api/automations/import lê.
// É o que torna o formato autorável: monta-se UMA automação no
// builder, exporta-se, e o arquivo vira o molde das outras — em vez
// de escrever o primeiro JSON às cegas contra um schema.
//
// Exige `agent`, não `viewer`, apesar de ser leitura: o documento
// carrega `send_webhook.headers` na íntegra, que costuma guardar
// token de autenticação do sistema de destino. Concentrar isso num
// arquivo baixável é uma exposição diferente de ler a automação na
// tela, uma de cada vez.
// ------------------------------------------------------------

export async function GET(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const idsParam = new URL(request.url).searchParams.get('ids')
  const ids = idsParam
    ? idsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null

  // `ctx.supabase` roda sob RLS (`automations_select` sobre
  // `is_account_member`), então o `.eq('account_id')` é redundante —
  // e mantido de propósito, para o filtro sobreviver a uma eventual
  // troca deste cliente pelo service-role.
  let query = ctx.supabase
    .from('automations')
    .select('id, name, description, trigger_type, trigger_config, is_active')
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: true })

  if (ids) query = query.in('id', ids)

  const { data, error } = await query
  if (error) {
    console.error('[GET /api/automations/export] fetch failed:', error)
    return NextResponse.json({ error: 'Could not load automations' }, { status: 500 })
  }

  const rows = data ?? []
  if (rows.length === 0) {
    return NextResponse.json({ error: 'No automations to export' }, { status: 404 })
  }

  let catalog
  let automations: ExportableAutomation[]
  try {
    // O catálogo e as árvores de passos não dependem uns dos outros;
    // buscar em paralelo evita somar as latências.
    const [loadedCatalog, trees] = await Promise.all([
      loadReferenceCatalog(ctx.supabase, ctx.accountId),
      Promise.all(rows.map((r) => loadStepsTree(r.id as string))),
    ])
    catalog = loadedCatalog
    automations = rows.map((r, i) => ({
      name: r.name as string,
      description: r.description as string | null,
      trigger_type: r.trigger_type as string,
      trigger_config: r.trigger_config as Record<string, unknown> | null,
      is_active: r.is_active as boolean,
      steps: trees[i],
    }))
  } catch (err) {
    console.error('[GET /api/automations/export] assembly failed:', err)
    return NextResponse.json({ error: 'Could not load automation steps' }, { status: 500 })
  }

  const doc = buildExportDocument(automations, catalog)
  const stamp = doc.exported_at.slice(0, 10)

  return new NextResponse(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="wacrm-automations-${stamp}.json"`,
      // Um export é um retrato do estado atual; servir de cache
      // devolveria automações que já mudaram.
      'cache-control': 'no-store',
    },
  })
}
