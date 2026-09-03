import type { SupabaseClient } from '@supabase/supabase-js';

import type { DealStatus } from '@/types';

/**
 * Escritas de negócio, SEM despacho de automação.
 *
 * Este módulo é deliberadamente cego ao motor: não importa nada de
 * `@/lib/automations/engine`. É o que permite que o próprio motor o
 * use sem criar um ciclo de importação — exatamente o arranjo que
 * `src/lib/contacts/tag-write.ts` já tem para etiquetas, onde o
 * escritor puro fica separado do despachante `tag-events.ts`.
 *
 * Quem quiser a escrita COM o gatilho usa `./stage-events`.
 */

// ------------------------------------------------------------
// Posse
// ------------------------------------------------------------

/**
 * `pipeline_stages` não tem `account_id` — a migration 017 deixou a
 * isolação por junção com `pipelines`. E o motor roda com
 * service_role, que atravessa RLS. Então a posse tem de ser
 * verificada à mão, em duas leituras: a etapa dá o funil, o funil dá
 * a conta. Sem isto, um `stage_id` vindo da configuração de uma
 * automação poderia apontar para o funil de outro inquilino.
 */
export async function stageBelongsToAccount(
  db: SupabaseClient,
  accountId: string,
  pipelineId: string,
  stageId: string
): Promise<boolean> {
  const { data: stage, error: stageErr } = await db
    .from('pipeline_stages')
    .select('id, pipeline_id')
    .eq('id', stageId)
    .maybeSingle();
  if (stageErr || !stage) return false;
  if (stage.pipeline_id !== pipelineId) return false;

  const { data: pipeline, error: pipeErr } = await db
    .from('pipelines')
    .select('id')
    .eq('id', pipelineId)
    .eq('account_id', accountId)
    .maybeSingle();
  return !pipeErr && Boolean(pipeline);
}

// ------------------------------------------------------------
// Mover de etapa
// ------------------------------------------------------------

export interface MoveDealStageWriteInput {
  db: SupabaseClient;
  accountId: string;
  dealId: string;
  toStageId: string;
  /** Funil de destino. Ausente = o funil em que o negócio já está. */
  toPipelineId?: string;
  setStatus?: DealStatus;
}

export type MoveDealStageFailure =
  'not_found' | 'same_stage' | 'stage_not_in_account' | 'write_failed';

export type MoveDealStageWriteResult =
  | {
      ok: true;
      /**
       * Falso quando a escrita valeu mas a etapa em si não mudou —
       * o caso de uma chamada que só encerrou o negócio. Quem
       * despacha usa isto para não anunciar uma passagem que não
       * houve.
       */
      stageChanged: boolean;
      fromStageId: string;
      toStageId: string;
      pipelineId: string;
      contactId: string | null;
      practiceArea: string | null;
    }
  | {
      ok: false;
      reason: MoveDealStageFailure;
      error?: string;
      fromStageId?: string;
    };

export async function moveDealStage(
  input: MoveDealStageWriteInput
): Promise<MoveDealStageWriteResult> {
  const { db, accountId, dealId, toStageId } = input;

  // Isolação de inquilino: o filtro por account_id é o que impede um
  // id de negócio forjado de alcançar outra conta quando quem chama é
  // o cliente de service_role.
  const { data: deal, error: readErr } = await db
    .from('deals')
    .select('id, pipeline_id, stage_id, contact_id, practice_area, status')
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (readErr)
    return { ok: false, reason: 'write_failed', error: readErr.message };
  if (!deal) return { ok: false, reason: 'not_found' };

  const fromStageId = deal.stage_id as string;
  const fromPipelineId = deal.pipeline_id as string;
  const toPipelineId = input.toPipelineId ?? fromPipelineId;

  // Nada a fazer. Sair aqui é o que impede um salvamento de
  // formulário de se passar por uma passagem de etapa.
  const statusUnchanged =
    input.setStatus === undefined || input.setStatus === deal.status;
  if (
    fromStageId === toStageId &&
    toPipelineId === fromPipelineId &&
    statusUnchanged
  ) {
    return { ok: false, reason: 'same_stage', fromStageId };
  }

  if (!(await stageBelongsToAccount(db, accountId, toPipelineId, toStageId))) {
    return { ok: false, reason: 'stage_not_in_account' };
  }

  const patch: Record<string, unknown> = { stage_id: toStageId };
  if (toPipelineId !== fromPipelineId) patch.pipeline_id = toPipelineId;
  if (input.setStatus) patch.status = input.setStatus;

  // Trava otimista: a escrita só vale se a etapa ainda for a que foi
  // lida acima.
  //
  // Entre a leitura e este update, outra escrita pode ter movido o
  // negócio — um agente arrastando o cartão enquanto uma automação
  // dispara sobre ele. Sem esta condição, o update venceria mesmo
  // assim e o evento `deal_stage_changed` seria anunciado com um
  // `from_stage_id` que já não era verdade, fazendo automações
  // encadeadas reagirem a uma transição que nunca existiu. Com ela, o
  // perdedor da corrida simplesmente não escreve.
  const { data: updated, error: writeErr } = await db
    .from('deals')
    .update(patch)
    .eq('id', dealId)
    .eq('account_id', accountId)
    .eq('stage_id', fromStageId)
    .select('id');

  if (writeErr)
    return { ok: false, reason: 'write_failed', error: writeErr.message };

  // Zero linhas: alguém chegou primeiro. Não é erro de escrita — é
  // uma corrida perdida, e o estado final já é o que o outro escritor
  // quis. Reportar como `same_stage` faz quem chama tratar isso como
  // "não havia o que fazer", que é a leitura correta.
  if (!updated || updated.length === 0) {
    return { ok: false, reason: 'same_stage', fromStageId };
  }

  return {
    ok: true,
    stageChanged: fromStageId !== toStageId,
    fromStageId,
    toStageId,
    pipelineId: toPipelineId,
    contactId: (deal.contact_id as string | null) ?? null,
    practiceArea: (deal.practice_area as string | null) ?? null,
  };
}

// ------------------------------------------------------------
// Criar negócio
// ------------------------------------------------------------

export interface CreateDealWriteInput {
  db: SupabaseClient;
  accountId: string;
  /** Autor de registro — `deals.user_id` é NOT NULL. */
  userId: string;
  pipelineId: string;
  stageId: string;
  contactId: string | null;
  title: string;
  value?: number;
  currency?: string;
  /** Ausente = copiada do contato. */
  practiceArea?: string | null;
  // Campos que só o formulário preenche. Ficam aqui para que criar um
  // negócio pela interface seja UMA escrita, e não um insert seguido
  // de um update — dois passos que poderiam falhar pela metade.
  notes?: string | null;
  expectedCloseDate?: string | null;
  assignedTo?: string | null;
  conversationId?: string | null;
}

export type CreateDealWriteResult =
  | { ok: true; dealId: string; practiceArea: string | null }
  | {
      ok: false;
      reason: 'stage_not_in_account' | 'write_failed';
      error?: string;
    };

export async function createDeal(
  input: CreateDealWriteInput
): Promise<CreateDealWriteResult> {
  const { db, accountId, pipelineId, stageId } = input;

  if (!(await stageBelongsToAccount(db, accountId, pipelineId, stageId))) {
    return { ok: false, reason: 'stage_not_in_account' };
  }

  // A tese vem do contato quando quem chama não a informou. É isto
  // que faz `deals.practice_area` deixar de nascer nula: a migration
  // 039 previa essa cópia ("normalmente copiada do contato na
  // criação") mas nenhum código jamais a executou, e sem ela o
  // casamento de negócio por tese não acharia nada.
  let practiceArea = input.practiceArea ?? null;
  if (practiceArea === null && input.contactId) {
    practiceArea = await contactPracticeArea(db, accountId, input.contactId);
  }

  const { data: created, error: writeErr } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: input.userId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      contact_id: input.contactId,
      title: input.title,
      value: input.value ?? 0,
      currency: input.currency ?? 'USD',
      practice_area: practiceArea,
      status: 'open',
      notes: input.notes ?? null,
      expected_close_date: input.expectedCloseDate ?? null,
      assigned_to: input.assignedTo ?? null,
      conversation_id: input.conversationId ?? null,
    })
    .select('id')
    .single();

  if (writeErr || !created) {
    return { ok: false, reason: 'write_failed', error: writeErr?.message };
  }

  return { ok: true, dealId: created.id as string, practiceArea };
}

// ------------------------------------------------------------
// Escolher QUAL negócio
// ------------------------------------------------------------

export async function contactPracticeArea(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<string | null> {
  const { data } = await db
    .from('contacts')
    .select('practice_area')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  return (data?.practice_area as string | null) ?? null;
}

export interface ResolvedDeal {
  id: string;
  practice_area: string | null;
}

/** O negócio aberto mais recente do contato num funil. */
export async function resolveLatestOpenDeal(
  db: SupabaseClient,
  accountId: string,
  contactId: string | null,
  pipelineId: string
): Promise<ResolvedDeal | null> {
  if (!contactId) return null;
  const { data } = await db
    .from('deals')
    .select('id, practice_area')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('pipeline_id', pipelineId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1);
  return (data?.[0] as ResolvedDeal | undefined) ?? null;
}

export interface ResolveDealInput {
  db: SupabaseClient;
  accountId: string;
  contactId: string | null;
  pipelineId: string;
  /** Tese a casar. Ausente = usa a tese do contato. */
  practiceArea?: string | null;
}

/**
 * Acha o negócio ABERTO do contato num funil, casando pela tese.
 *
 * Casar por tese é o que impede um caso de BPC e um de aposentadoria
 * do mesmo cliente de se atropelarem no funil: são processos
 * distintos e cada um anda no seu ritmo.
 *
 * A ordem de busca é: negócio da mesma tese; senão, negócio ainda sem
 * tese (o lead que abriu conversa antes da triagem e só depois foi
 * classificado — adotá-lo é melhor que abrir um segundo negócio para
 * a mesma pessoa e o mesmo caso); senão, nada. Quando nem o contexto
 * nem o contato têm tese, degrada para o negócio aberto mais recente,
 * que é o comportamento óbvio para quem trabalha um caso por pessoa.
 */
export async function resolveDealForContact(
  input: ResolveDealInput
): Promise<ResolvedDeal | null> {
  if (!input.contactId) return null;

  let practiceArea = input.practiceArea ?? null;
  if (practiceArea === null) {
    practiceArea = await contactPracticeArea(
      input.db,
      input.accountId,
      input.contactId
    );
  }

  if (!practiceArea) {
    return resolveLatestOpenDeal(
      input.db,
      input.accountId,
      input.contactId,
      input.pipelineId
    );
  }

  const { data: matched } = await input.db
    .from('deals')
    .select('id, practice_area')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .eq('pipeline_id', input.pipelineId)
    .eq('status', 'open')
    .eq('practice_area', practiceArea)
    .order('created_at', { ascending: false })
    .limit(1);
  const hit = matched?.[0] as ResolvedDeal | undefined;
  if (hit) return hit;

  const { data: untagged } = await input.db
    .from('deals')
    .select('id, practice_area')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .eq('pipeline_id', input.pipelineId)
    .eq('status', 'open')
    .is('practice_area', null)
    .order('created_at', { ascending: false })
    .limit(1);
  return (untagged?.[0] as ResolvedDeal | undefined) ?? null;
}
