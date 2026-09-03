import type { SupabaseClient } from '@supabase/supabase-js';

import {
  runAutomationsForTrigger,
  type AutomationContext,
} from '@/lib/automations/engine';
import type { DealStatus } from '@/types';
import { MAX_DEAL_CHAIN_DEPTH, getDealChainDepth } from './deal-chain';
import {
  createDeal,
  moveDealStage,
  type MoveDealStageFailure,
} from './deal-write';

export { MAX_DEAL_CHAIN_DEPTH, getDealChainDepth } from './deal-chain';

/**
 * Escrita de negócio COM despacho de automação.
 *
 * A escrita crua mora em `./deal-write`, que é cego ao motor para não
 * criar ciclo de importação. Aqui em cima fica a única coisa que ele
 * não faz: anunciar que algo aconteceu.
 *
 * Espelha `src/lib/contacts/tag-events.ts`, a mesma divisão aplicada
 * a etiquetas. O motor de automações NÃO usa este módulo — ele faz o
 * despacho inline, pelo mesmo motivo que já faz com `add_tag`.
 * Quem usa é o mundo autenticado: a rota de API do quadro kanban e a
 * varredura periódica.
 */

export interface MoveDealStageAndDispatchInput {
  db: SupabaseClient;
  accountId: string;
  dealId: string;
  toStageId: string;
  toPipelineId?: string;
  setStatus?: DealStatus;
  context?: AutomationContext;
}

export interface MoveDealStageResult {
  moved: boolean;
  dispatched: boolean;
  fromStageId?: string | null;
  toStageId?: string;
  reason?: MoveDealStageFailure | 'max_depth';
  error?: string;
}

export async function moveDealStageAndDispatch(
  input: MoveDealStageAndDispatchInput
): Promise<MoveDealStageResult> {
  const written = await moveDealStage({
    db: input.db,
    accountId: input.accountId,
    dealId: input.dealId,
    toStageId: input.toStageId,
    toPipelineId: input.toPipelineId,
    setStatus: input.setStatus,
  });

  if (!written.ok) {
    return {
      moved: false,
      dispatched: false,
      fromStageId: written.fromStageId ?? null,
      reason: written.reason,
      error: written.error,
    };
  }

  const base = {
    moved: true,
    fromStageId: written.fromStageId,
    toStageId: written.toStageId,
  };

  // A escrita valeu mas a etapa não mudou — foi uma chamada que só
  // encerrou o negócio. Não há passagem de etapa para anunciar.
  if (!written.stageChanged) {
    return { ...base, dispatched: false, reason: 'same_stage' };
  }

  const depth = getDealChainDepth(input.context);
  if (depth >= MAX_DEAL_CHAIN_DEPTH) {
    console.warn('[automations] deal_stage_changed chain depth limit reached', {
      accountId: input.accountId,
      dealId: input.dealId,
      toStageId: written.toStageId,
      depth,
    });
    return { ...base, dispatched: false, reason: 'max_depth' };
  }

  await runAutomationsForTrigger({
    accountId: input.accountId,
    triggerType: 'deal_stage_changed',
    contactId: written.contactId,
    context: {
      ...input.context,
      deal_id: input.dealId,
      pipeline_id: written.pipelineId,
      from_stage_id: written.fromStageId,
      to_stage_id: written.toStageId,
      practice_area: written.practiceArea ?? undefined,
      vars: {
        ...(input.context?.vars ?? {}),
        _deal_chain_depth: depth + 1,
      },
    },
  });

  return { ...base, dispatched: true };
}

export interface CreateDealAndDispatchInput {
  db: SupabaseClient;
  accountId: string;
  userId: string;
  pipelineId: string;
  stageId: string;
  contactId: string | null;
  title: string;
  value?: number;
  currency?: string;
  practiceArea?: string | null;
  notes?: string | null;
  expectedCloseDate?: string | null;
  assignedTo?: string | null;
  conversationId?: string | null;
  context?: AutomationContext;
}

export interface CreateDealResult {
  created: boolean;
  dealId?: string;
  dispatched: boolean;
  reason?: 'stage_not_in_account' | 'write_failed' | 'max_depth';
  error?: string;
}

export async function createDealAndDispatch(
  input: CreateDealAndDispatchInput
): Promise<CreateDealResult> {
  const written = await createDeal({
    db: input.db,
    accountId: input.accountId,
    userId: input.userId,
    pipelineId: input.pipelineId,
    stageId: input.stageId,
    contactId: input.contactId,
    title: input.title,
    value: input.value,
    currency: input.currency,
    practiceArea: input.practiceArea,
    notes: input.notes,
    expectedCloseDate: input.expectedCloseDate,
    assignedTo: input.assignedTo,
    conversationId: input.conversationId,
  });

  if (!written.ok) {
    return {
      created: false,
      dispatched: false,
      reason: written.reason,
      error: written.error,
    };
  }

  const depth = getDealChainDepth(input.context);
  if (depth >= MAX_DEAL_CHAIN_DEPTH) {
    console.warn('[automations] deal_created chain depth limit reached', {
      accountId: input.accountId,
      dealId: written.dealId,
      depth,
    });
    return {
      created: true,
      dealId: written.dealId,
      dispatched: false,
      reason: 'max_depth',
    };
  }

  await runAutomationsForTrigger({
    accountId: input.accountId,
    triggerType: 'deal_created',
    contactId: input.contactId,
    context: {
      ...input.context,
      deal_id: written.dealId,
      pipeline_id: input.pipelineId,
      to_stage_id: input.stageId,
      practice_area: written.practiceArea ?? undefined,
      vars: {
        ...(input.context?.vars ?? {}),
        _deal_chain_depth: depth + 1,
      },
    },
  });

  return { created: true, dealId: written.dealId, dispatched: true };
}
