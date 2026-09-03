import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { moveDealStageAndDispatch } from '@/lib/deals/stage-events'
import type { DealStatus } from '@/types'

/**
 * Mover um negócio de etapa.
 *
 * Esta rota existe porque antes dela NÃO HAVIA servidor nenhum no
 * caminho: o quadro kanban gravava `deals.stage_id` direto do
 * navegador, com o cliente Supabase do usuário. Sem um ponto de
 * servidor, não havia onde pendurar a reação — e era por isso que
 * mover um cartão não podia acionar automação alguma.
 *
 * A escrita usa o cliente do PRÓPRIO usuário (o que `requireRole`
 * devolve), não o de service_role, por dois motivos:
 *
 *   1. o RLS de `deals` continua sendo o portão, como em qualquer
 *      outra escrita feita pela interface;
 *   2. `auth.uid()` fica definido, então o gatilho de banco registra
 *      em `deal_stage_events.changed_by` QUEM moveu. Movimento de
 *      automação grava nulo ali, e é assim que o relatório distingue
 *      o que a equipe fez do que o sistema fez.
 *
 * O despacho da automação lá dentro abre o seu próprio cliente
 * administrativo, como todo o resto do motor.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Mover negócio é escrita: `agent` no mínimo. Um `viewer` não pode
  // rearranjar o funil de ninguém.
  let ctx: Awaited<ReturnType<typeof requireRole>>
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  const stageId = typeof body?.stage_id === 'string' ? body.stage_id : ''
  if (!stageId) {
    return NextResponse.json({ error: 'stage_id required' }, { status: 400 })
  }

  const status = body?.status as DealStatus | undefined
  if (status !== undefined && !['open', 'won', 'lost'].includes(status)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 })
  }

  const result = await moveDealStageAndDispatch({
    db: ctx.supabase,
    accountId: ctx.accountId,
    dealId: id,
    toStageId: stageId,
    toPipelineId: typeof body?.pipeline_id === 'string' ? body.pipeline_id : undefined,
    setStatus: status,
  })

  if (!result.moved) {
    switch (result.reason) {
      // Já estava lá. Do ponto de vista de quem chamou, o objetivo
      // foi atingido — devolver erro faria a interface reverter uma
      // animação que estava certa.
      case 'same_stage':
        return NextResponse.json({ ok: true, moved: false, reason: 'same_stage' })
      case 'not_found':
        return NextResponse.json({ error: 'deal not found' }, { status: 404 })
      case 'stage_not_in_account':
        return NextResponse.json(
          { error: 'stage does not belong to this pipeline' },
          { status: 400 },
        )
      default:
        return NextResponse.json(
          { error: result.error ?? 'move failed' },
          { status: 500 },
        )
    }
  }

  return NextResponse.json({
    ok: true,
    moved: true,
    dispatched: result.dispatched,
    from_stage_id: result.fromStageId,
    to_stage_id: result.toStageId,
  })
}
