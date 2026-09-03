import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { createDealAndDispatch } from '@/lib/deals/stage-events';

/**
 * Criar um negócio.
 *
 * Existe pelo mesmo motivo que a rota de mudança de etapa: sem
 * servidor no caminho, o formulário inseria direto do navegador e
 * nada podia reagir. O gatilho `deal_created` prometia disparar "por
 * qualquer caminho" e, na prática, ignorava justamente o caminho mais
 * comum — alguém cadastrando o negócio à mão.
 *
 * Há um segundo ganho, de segurança. O RLS `deals_insert` da migration
 * 017 confere apenas `is_account_member(account_id, 'agent')` sobre a
 * linha inserida; ele não verifica se o `pipeline_id` e o `stage_id`
 * enviados pertencem à conta. Pela interface isso nunca acontece,
 * porque o formulário só oferece etapas do funil escolhido — mas uma
 * chamada direta ao Supabase com a mesma sessão poderia gravar um
 * negócio apontando para a etapa de outro inquilino, produzindo um
 * cartão órfão que o quadro não sabe onde desenhar.
 * `createDealAndDispatch` valida essa posse antes de escrever.
 */
export async function POST(request: Request) {
  let ctx: Awaited<ReturnType<typeof requireRole>>;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);

  const pipelineId =
    typeof body?.pipeline_id === 'string' ? body.pipeline_id : '';
  const stageId = typeof body?.stage_id === 'string' ? body.stage_id : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : '';

  if (!pipelineId || !stageId) {
    return NextResponse.json(
      { error: 'pipeline_id and stage_id required' },
      { status: 400 }
    );
  }
  if (!title) {
    return NextResponse.json({ error: 'title required' }, { status: 400 });
  }

  const result = await createDealAndDispatch({
    db: ctx.supabase,
    accountId: ctx.accountId,
    userId: ctx.userId,
    pipelineId,
    stageId,
    contactId: typeof body?.contact_id === 'string' ? body.contact_id : null,
    title,
    value: typeof body?.value === 'number' ? body.value : 0,
    currency: typeof body?.currency === 'string' ? body.currency : undefined,
    notes: typeof body?.notes === 'string' ? body.notes : null,
    expectedCloseDate:
      typeof body?.expected_close_date === 'string'
        ? body.expected_close_date
        : null,
    assignedTo: typeof body?.assigned_to === 'string' ? body.assigned_to : null,
  });

  if (!result.created) {
    if (result.reason === 'stage_not_in_account') {
      return NextResponse.json(
        { error: 'stage does not belong to this pipeline' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: result.error ?? 'create failed' },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { ok: true, id: result.dealId, dispatched: result.dispatched },
    { status: 201 }
  );
}
