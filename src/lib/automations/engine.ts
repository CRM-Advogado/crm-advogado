import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  TagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  MoveDealStageStepConfig,
  DealStageChangedTriggerConfig,
  DealCreatedTriggerConfig,
  DealStalledTriggerConfig,
  PracticeAreaSetTriggerConfig,
  DocumentSignedTriggerConfig,
  AssignConversationStepConfig,
  SendSignatureRequestStepConfig,
} from '@/types';
import { supabaseAdmin } from './admin-client';
import { CUSTOM_FIELD_PREFIX, isWritableContactField } from './contact-fields';
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write';
import {
  MAX_TAG_CHAIN_DEPTH,
  getTagChainDepth,
} from '@/lib/contacts/tag-chain';
// Escritor puro de negócio. Importado daqui, e não de `deals/stage-events`,
// porque aquele módulo importa ESTE — o despacho fica inline abaixo,
// exatamente como já acontece com `add_tag`.
import {
  createDeal,
  moveDealStage,
  resolveDealForContact,
  resolveLatestOpenDeal,
} from '@/lib/deals/deal-write';
import {
  MAX_DEAL_CHAIN_DEPTH,
  getDealChainDepth,
} from '@/lib/deals/deal-chain';
import {
  engineSendText,
  engineSendTemplate,
  engineSendInteractive,
} from './meta-send';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { randomUUID } from 'node:crypto';
import { getZapsignCredentials } from '@/lib/zapsign/credentials';
import {
  attachExtraDocumentFromTemplate,
  createDocumentFromTemplate,
  ZapsignApiError,
  ZapsignTransportError,
  type CreatedZapsignDocument,
} from '@/lib/zapsign/client';
import { splitBrazilianPhone } from '@/lib/zapsign/phone';

/**
 * Token que o passo `send_signature_request` troca pelo link de
 * assinatura antes de `interpolate()` rodar. Tolera espaços porque é
 * assim que os demais campos do builder ensinam a escrever token
 * (`{{ vars.x }}`), e é global porque nada impede a mensagem de citar o
 * link duas vezes.
 */
const SIGNER_URL_TOKEN = /\{\{\s*signer_url\s*\}\}/g;

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string;
  /** Conversation the event belongs to, if any. */
  conversation_id?: string;
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>;
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string;
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string;
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string;
  /** Nome do contato dono da execução. O dispatch o preenche pegando
   *  carona na consulta de posse; é o que `{{ contact.name }}` e
   *  `{{ contact.first_name }}` resolvem nos textos de passo. */
  contact_name?: string;

  // ---- Contexto de funil (migration 042) --------------------
  // Preenchido pelos gatilhos deal_created / deal_stage_changed /
  // deal_stalled. É o que permite a um passo saber QUAL negócio
  // provocou a execução, em vez de ter de adivinhar pelo contato.
  /** Negócio que provocou o evento. */
  deal_id?: string;
  /** Funil do negócio. */
  pipeline_id?: string;
  /** Etapa de origem, em deal_stage_changed. */
  from_stage_id?: string;
  /** Etapa de destino / atual do negócio. */
  to_stage_id?: string;
  /** Tese do caso. Também preenchida por practice_area_set. */
  practice_area?: string;
  /** Dias parados na etapa, em deal_stalled. */
  stalled_days?: number;
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string;
  triggerType: AutomationTriggerType;
  contactId?: string | null;
  context?: AutomationContext;
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(
  input: DispatchInput
): Promise<void> {
  try {
    const db = supabaseAdmin();

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id, name')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle();
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr);
        return;
      }
      if (!owned) {
        console.warn(
          '[automations] contact not in account, refusing dispatch',
          input.contactId
        );
        return;
      }
      // O nome do contato entra no contexto aqui, pegando carona na
      // consulta de posse — sem leitura extra por execução. É serializado
      // junto com o resto do contexto nos passos de espera, então um
      // resume usa o nome de quando a execução começou.
      input = {
        ...input,
        context: {
          ...(input.context ?? {}),
          contact_name: (owned as { name?: string | null }).name ?? '',
        },
      };
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true);

    if (error) {
      console.error('[automations] fetch failed:', error);
      return;
    }
    if (!automations || automations.length === 0) return;

    for (const automation of automations as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue;
      try {
        await executeAutomation(automation, input);
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err);
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err);
  }
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string;
  automation_id: string;
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string;
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string;
  contact_id: string | null;
  log_id: string | null;
  parent_step_id: string | null;
  branch: 'yes' | 'no' | null;
  next_step_position: number;
  context: AutomationContext;
}): Promise<void> {
  const db = supabaseAdmin();
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .single();

  if (error || !automation) {
    console.error(
      '[automations] resume: missing automation',
      pending.automation_id,
      error
    );
    await markPending(pending.id, 'failed');
    return;
  }

  try {
    await executeStepsFrom({
      automation: automation as Automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    });
    await markPending(pending.id, 'done');
  } catch (err) {
    console.error('[automations] resume failed:', err);
    await markPending(pending.id, 'failed');
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const db = supabaseAdmin();

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      account_id: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      // Seeded pessimistically. The row is written BEFORE any step runs,
      // and every terminal path below overwrites it (`appendResults` at
      // the outermost scope, or `finalizeLog`). Seeding 'success' meant a
      // run that died mid-flight — the process frozen, the pod recycled —
      // left a permanent `status: 'success'` with `steps_executed: []`,
      // indistinguishable from an automation that genuinely had nothing
      // to do. 'failed' inverts that: the status only becomes success if
      // execution actually reached the end. See issue #409.
      status: 'failed',
    })
    .select()
    .single();

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr);
    return;
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  });

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc(
    'increment_automation_execution_count',
    {
      p_automation_id: automation.id,
    }
  );
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr);
  }
}

interface ExecuteArgs {
  automation: Automation;
  contactId: string | null;
  context: AutomationContext;
  parentStepId: string | null;
  branch: 'yes' | 'no' | null;
  startPosition: number;
  logId: string | null;
  triggerEvent: string;
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const db = supabaseAdmin();

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true });

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery
          .eq('parent_step_id', args.parentStepId)
          .eq('branch', args.branch ?? 'yes');

  const { data: steps, error: stepsErr } = await scoped;

  if (stepsErr) {
    await finalizeLog(args.logId, 'failed', stepsErr.message);
    return;
  }
  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null);
    }
    return;
  }

  const results: AutomationLogStepResult[] = [];
  let status: 'success' | 'partial' | 'failed' = 'success';
  let errorMessage: string | null = null;

  for (const step of steps as AutomationStep[]) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig;
      const ms = waitMs(cfg);
      await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: args.context,
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      });
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      });
      status = 'partial';
      await appendResults(args.logId, results, status, errorMessage);
      return;
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig;
        const taken = await evaluateCondition(cfg, args);
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        });
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        });
        continue;
      }

      const detail = await runStep(step, args);
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      });
      status = 'failed';
      errorMessage = msg;
      break;
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage);
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage);
  }
}

async function runStep(
  step: AutomationStep,
  args: ExecuteArgs
): Promise<string> {
  const db = supabaseAdmin();

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig;
      if (!args.contactId) throw new Error('send_message needs a contact');
      const text = interpolate(cfg.text, args);
      if (!text.trim()) throw new Error('send_message has empty text');
      const conversationId = await resolveConversationId(args);
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      });
      return `sent via Meta (${whatsapp_message_id})`;
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as
        SendButtonsStepConfig | SendListStepConfig;
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`);
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload);
      if (!check.ok) throw new Error(check.error);
      const conversationId = await resolveConversationId(args);
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      });
      return `interactive sent via Meta (${whatsapp_message_id})`;
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig;
      if (!args.contactId) throw new Error('send_template needs a contact');
      if (!cfg.template_name)
        throw new Error('send_template needs template_name');
      const conversationId = await resolveConversationId(args);
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a);
              const nb = Number(b);
              const aNum = Number.isFinite(na);
              const bNum = Number.isFinite(nb);
              if (aNum && bNum) return na - nb;
              if (aNum) return -1;
              if (bNum) return 1;
              return a.localeCompare(b);
            })
            .map((k) => String(cfg.variables![k]))
        : [];
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      });
      return `template sent via Meta (${whatsapp_message_id})`;
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig;
      if (!args.contactId || !cfg.tag_id)
        throw new Error('add_tag needs contact + tag_id');
      const added = await addContactTagIfAbsent(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        tagId: cfg.tag_id,
      });
      if (!added) return `tag ${cfg.tag_id} already present`;

      const depth = getTagChainDepth(args.context);
      if (depth >= MAX_TAG_CHAIN_DEPTH) {
        console.warn('[automations] tag_added chain depth limit reached', {
          automationId: args.automation.id,
          contactId: args.contactId,
          tagId: cfg.tag_id,
          depth,
        });
        return `tag ${cfg.tag_id} added; tag_added dispatch skipped at depth ${depth}`;
      }

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'tag_added',
        contactId: args.contactId,
        context: {
          ...args.context,
          tag_id: cfg.tag_id,
          vars: {
            ...(args.context.vars ?? {}),
            _tag_chain_depth: depth + 1,
          },
        },
      });
      return `tag ${cfg.tag_id} added and tag_added dispatched`;
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig;
      if (!args.contactId || !cfg.tag_id)
        throw new Error('remove_tag needs contact + tag_id');
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.tag_id);
      return `tag ${cfg.tag_id} removed`;
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig;
      if (!args.contactId)
        throw new Error('assign_conversation needs a contact');
      let agentId = cfg.agent_id;
      if (cfg.mode === 'round_robin') {
        // Pick any member of the account. The existing implementation
        // only ever returned the automation's author; preserving that
        // shape until a real round-robin algorithm replaces it.
        const { data: profiles } = await db
          .from('profiles')
          .select('user_id')
          .eq('account_id', args.automation.account_id)
          .limit(1);
        agentId = profiles?.[0]?.user_id;
      }
      if (!agentId) return 'no agent resolved';
      await db
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId);
      return `assigned to ${agentId}`;
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig;
      if (!args.contactId)
        throw new Error('update_contact_field needs a contact');
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args);

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith(CUSTOM_FIELD_PREFIX)) {
        const customFieldId = cfg.field.slice(CUSTOM_FIELD_PREFIX.length);
        if (!customFieldId) {
          // Throw, don't return: a returned string is logged as a
          // SUCCESSFUL step, so a misconfigured automation looked like it
          // had run while writing nothing. Throwing marks the step failed
          // and puts the reason in the execution log.
          throw new Error(`field ${cfg.field} not writable from automations`);
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle();
        if (!field) {
          throw new Error(`field ${cfg.field} not writable from automations`);
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        const { error: customErr } = await db
          .from('contact_custom_values')
          .upsert(
            {
              contact_id: args.contactId,
              custom_field_id: customFieldId,
              value,
            },
            { onConflict: 'contact_id,custom_field_id' }
          );
        if (customErr) {
          throw new Error(`custom field write failed: ${customErr.message}`);
        }
        return `custom field updated`;
      }

      // The writable set lives in ./contact-fields so the engine, the
      // validator and the builder UI cannot drift apart — that drift is
      // exactly what made `practice_area` (migration 039) unwritable
      // while the migration documented it as automation-filled.
      if (!isWritableContactField(cfg.field)) {
        throw new Error(`field ${cfg.field} not writable from automations`);
      }

      // A tese é o único campo de contato que move o funil, então é o
      // único cuja mudança precisa ser anunciada. Ler o valor anterior
      // ANTES da escrita é o que permite distinguir "classificou
      // agora" de "reescreveu o mesmo valor" — sem essa leitura, toda
      // reexecução da automação de triagem reempurraria o lead pelo
      // funil.
      const isPracticeArea = cfg.field === 'practice_area';
      let previousArea: string | null = null;
      if (isPracticeArea) {
        const { data: before } = await db
          .from('contacts')
          .select('practice_area')
          .eq('id', args.contactId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle();
        previousArea = (before?.practice_area as string | null) ?? null;
      }

      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      const { error: updateErr } = await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id);
      // Constrained columns (`practice_area` carries a CHECK) reject a
      // wrong value at the database. Unchecked, that rejection was
      // invisible and the automation reported success having written
      // nothing — a typo'd "bcp" would split reports in silence.
      if (updateErr) {
        throw new Error(`${cfg.field} write rejected: ${updateErr.message}`);
      }

      // Classificou a tese agora: anuncia, para que a automação de
      // triagem possa empurrar o negócio para a etapa seguinte.
      if (isPracticeArea && value && value !== previousArea) {
        const depth = getDealChainDepth(args.context);
        if (depth >= MAX_DEAL_CHAIN_DEPTH) {
          console.warn(
            '[automations] practice_area_set chain depth limit reached',
            {
              automationId: args.automation.id,
              contactId: args.contactId,
              depth,
            }
          );
          return `${cfg.field} updated; practice_area_set dispatch skipped at depth ${depth}`;
        }
        await runAutomationsForTrigger({
          accountId: args.automation.account_id,
          triggerType: 'practice_area_set',
          contactId: args.contactId,
          context: {
            ...args.context,
            practice_area: value,
            vars: {
              ...(args.context.vars ?? {}),
              _deal_chain_depth: depth + 1,
            },
          },
        });
        return `${cfg.field} updated and practice_area_set dispatched`;
      }

      return `${cfg.field} updated`;
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig;
      if (!cfg.pipeline_id || !cfg.stage_id)
        throw new Error('create_deal needs pipeline + stage');
      const created = await createDeal({
        db,
        // Tenancy + audit, same split as automation_logs above.
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        pipelineId: cfg.pipeline_id,
        stageId: cfg.stage_id,
        contactId: args.contactId,
        title: interpolate(cfg.title, args),
        value: cfg.value ?? 0,
        currency: await accountCurrency(args.automation.account_id),
        // Tese copiada do contato por `createDeal`. Antes disto o
        // negócio nascia sem tese e nada mais conseguia casá-lo.
      });
      if (!created.ok) throw new Error(`create_deal failed: ${created.reason}`);

      const cut = await dispatchDealEvent('deal_created', args, {
        deal_id: created.dealId,
        pipeline_id: cfg.pipeline_id,
        to_stage_id: cfg.stage_id,
        practice_area: created.practiceArea ?? undefined,
      });
      return `deal ${created.dealId} created${chainCutSuffix(cut)}`;
    }

    case 'move_deal_stage': {
      const cfg = step.step_config as MoveDealStageStepConfig;
      if (!cfg.pipeline_id || !cfg.stage_id) {
        throw new Error('move_deal_stage needs pipeline + stage');
      }

      const accountId = args.automation.account_id;
      const mode = cfg.match_by ?? 'auto';

      // Qual negócio mover. `auto` prefere o negócio que veio no
      // gatilho — quando um gatilho de funil disparou a execução, ele
      // já sabe exatamente de quem se trata, e adivinhar pelo contato
      // só criaria chance de errar o caso.
      let dealId: string | undefined;
      if (mode === 'context' || mode === 'auto') {
        dealId = args.context.deal_id;
      }
      if (!dealId && mode !== 'context') {
        const found =
          mode === 'latest_open'
            ? await resolveLatestOpenDeal(
                db,
                accountId,
                args.contactId,
                cfg.pipeline_id
              )
            : await resolveDealForContact({
                db,
                accountId,
                contactId: args.contactId,
                pipelineId: cfg.pipeline_id,
                practiceArea: args.context.practice_area ?? null,
              });
        dealId = found?.id;
      }

      // Nenhum negócio casou. Criar um já na etapa de destino é o que
      // impede um lead atendido de ficar fora do funil — que é
      // exatamente o buraco que esta automação existe para tapar.
      if (!dealId) {
        if (mode === 'context')
          return 'move_deal_stage: no deal in trigger context';
        if (!cfg.create_if_missing) return 'move_deal_stage: no matching deal';
        if (!args.contactId)
          return 'move_deal_stage: no contact to open a deal for';

        const created = await createDeal({
          db,
          accountId,
          userId: args.automation.user_id,
          pipelineId: cfg.pipeline_id,
          stageId: cfg.stage_id,
          contactId: args.contactId,
          title: interpolate(cfg.title ?? 'Lead', args),
          currency: await accountCurrency(accountId),
          practiceArea: args.context.practice_area ?? null,
        });
        if (!created.ok)
          throw new Error(`move_deal_stage create failed: ${created.reason}`);

        const cut = await dispatchDealEvent('deal_created', args, {
          deal_id: created.dealId,
          pipeline_id: cfg.pipeline_id,
          to_stage_id: cfg.stage_id,
          practice_area: created.practiceArea ?? undefined,
        });
        return `deal ${created.dealId} created at target stage${chainCutSuffix(cut)}`;
      }

      const moved = await moveDealStage({
        db,
        accountId,
        dealId,
        toStageId: cfg.stage_id,
        toPipelineId: cfg.pipeline_id,
        setStatus: cfg.set_status,
      });

      // Já estava lá. Não é falha: uma automação que reafirma a etapa
      // atual acertou o alvo, apenas não teve trabalho.
      if (!moved.ok && moved.reason === 'same_stage') {
        return `deal ${dealId} already at target stage`;
      }
      if (!moved.ok) throw new Error(`move_deal_stage failed: ${moved.reason}`);

      let cut: number | null = null;
      if (moved.stageChanged) {
        cut = await dispatchDealEvent('deal_stage_changed', args, {
          deal_id: dealId,
          pipeline_id: moved.pipelineId,
          from_stage_id: moved.fromStageId,
          to_stage_id: moved.toStageId,
          practice_area: moved.practiceArea ?? undefined,
        });
      }
      return `deal ${dealId} moved to stage ${cfg.stage_id}${chainCutSuffix(cut)}`;
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig;
      if (!cfg.url) throw new Error('send_webhook needs url');
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed');
      }
      const body = cfg.body_template
        ? interpolate(cfg.body_template, args)
        : JSON.stringify(args.context);
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      return `webhook ${res.status}`;
    }

    case 'send_signature_request': {
      const cfg = step.step_config as SendSignatureRequestStepConfig;
      // Ausente = LIGADO. O builder grava o campo sempre, mas um
      // payload importado pode omiti-lo, e o padrão do produto é
      // entregar o link pelo WhatsApp do escritório. Ler o campo em um
      // só lugar impede que motor, validador e UI discordem sobre o que
      // "ausente" significa.
      const sendViaWhatsapp = cfg.send_via_whatsapp !== false;
      if (!args.contactId)
        throw new Error('send_signature_request needs a contact');
      if (!cfg.template_token)
        throw new Error('send_signature_request needs template_token');
      const documentName = interpolate(cfg.document_name ?? '', args);
      if (!documentName.trim())
        throw new Error('send_signature_request has empty document_name');
      if (sendViaWhatsapp && !cfg.message_text?.trim()) {
        throw new Error(
          'send_signature_request needs message_text when send_via_whatsapp is on'
        );
      }

      const creds = await getZapsignCredentials(db, args.automation.account_id);
      if (!creds) {
        throw new Error('ZapSign is not configured for this account');
      }

      const { data: contact, error: contactErr } = await db
        .from('contacts')
        .select('name, email, phone')
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle();
      if (contactErr || !contact) {
        throw new Error('contact not found for this account');
      }
      if (!contact.name) {
        throw new Error(
          'send_signature_request needs the contact to have a name'
        );
      }

      // Resolvida ANTES da chamada externa. Este passo alcança contatos
      // que nunca conversaram (document_signed, tag_added,
      // deal_stage_changed), e resolver depois significava gerar o
      // documento — gastando cota do ZapSign e deixando uma linha
      // `pending` que ninguém fecha — para só então descobrir que não
      // há por onde mandar o link.
      const conversationId = sendViaWhatsapp
        ? await resolveConversationId(args)
        : null;

      const variables: Record<string, string> = {};
      for (const [key, value] of Object.entries(cfg.variables ?? {})) {
        variables[key] = interpolate(value, args);
      }
      const { country: phoneCountry, number: phoneNumber } =
        splitBrazilianPhone(contact.phone as string);

      // A linha nasce ANTES da chamada, com o token ainda em branco, e o
      // id dela viaja como `external_id`. É o que torna recuperável o
      // caso em que a resposta se perde: o documento existe no ZapSign,
      // o aviso dele chega com o nosso id dentro, e o webhook reencontra
      // esta linha mesmo sem nunca termos visto o token. Ver migration
      // 044.
      const documentRowId = randomUUID();
      const { error: insertErr } = await db.from('zapsign_documents').insert({
        id: documentRowId,
        account_id: args.automation.account_id,
        contact_id: args.contactId,
        deal_id: args.context.deal_id ?? null,
        automation_id: args.automation.id,
        zapsign_token: null,
        template_token: cfg.template_token,
        name: documentName,
        sign_url: null,
      });
      if (insertErr) {
        throw new Error(
          `could not record the document before sending: ${insertErr.message}`
        );
      }

      let doc: CreatedZapsignDocument;
      try {
        doc = await createDocumentFromTemplate({
          ...creds,
          externalId: documentRowId,
          templateToken: cfg.template_token,
          documentName,
          signer: {
            name: contact.name as string,
            email: (contact.email as string | null) ?? undefined,
            phoneCountry,
            phoneNumber,
          },
          variables,
          signerHasIncompleteFields: cfg.signer_has_incomplete_fields === true,
        });
      } catch (err) {
        // Duas falhas bem diferentes, e a diferença decide o que fazer
        // com a linha que acabamos de gravar.
        if (err instanceof ZapsignTransportError) {
          // Sem resposta: o ZapSign PODE ter criado o documento. A linha
          // FICA, com o token nulo — é o registro de que há uma dúvida
          // em aberto, e é por ela que o webhook fecha o caso sozinho se
          // o documento existir mesmo.
          throw new Error(
            `${err.message} — the document may still have been created at ZapSign; it is recorded here as unconfirmed and will resolve itself if the signature webhook arrives`
          );
        }
        // Resposta com status de erro: o ZapSign decidiu não criar. Não
        // há dúvida a registrar, então a linha sai.
        await db.from('zapsign_documents').delete().eq('id', documentRowId);
        // O motivo vem no corpo, e só o status chegava ao log — o que
        // fazia toda recusa virar o mesmo "returned 400" sem pista do
        // que consertar. Quem lê o log da automação não tem o corpo em
        // nenhum outro lugar.
        if (err instanceof ZapsignApiError) {
          const detail = err.body?.trim().slice(0, 300);
          throw new Error(
            `${err.message}${detail ? ` — ZapSign said: ${detail}` : ''}`
          );
        }
        throw err;
      }
      const signer = doc.signers[0];

      // Os anexos entram ANTES de o link sair daqui, e a ordem nao e
      // estetica: upload-extra-doc responde 400 depois que o principal
      // foi assinado, entao um envelope que chegou ao signatario sem a
      // procuracao e um envelope que nao da mais para completar.
      //
      // As MESMAS `variables` alimentam os anexos. Contrato e procuracao
      // se qualificam com os mesmos dados, e o formulario do modelo, se
      // ligado, e perguntado uma vez so para o envelope inteiro.
      const extraTemplates = (
        Array.isArray(cfg.extra_template_tokens)
          ? (cfg.extra_template_tokens as unknown[])
          : []
      ).filter(
        (tok): tok is string => typeof tok === 'string' && tok.trim().length > 0
      );
      for (const extraTemplate of extraTemplates) {
        try {
          await attachExtraDocumentFromTemplate({
            ...creds,
            documentToken: doc.token,
            templateToken: extraTemplate,
            variables,
          });
        } catch (err) {
          // Diferente da falha de CRIACAO, aqui o documento principal
          // existe e ja foi cobrado — apagar a linha orfanaria um
          // documento real. Ela fica com o token, para o documento ser
          // rastreavel na aba Documentos e cancelavel no painel, e SEM
          // `sign_url`, para que ninguem mande a mao um envelope
          // incompleto. Nao ha retentativa automatica: anexo nao pode
          // ser removido, entao uma segunda tentativa sobre um anexo
          // parcialmente aceito duplicaria o documento sem desfazer.
          await db
            .from('zapsign_documents')
            .update({ zapsign_token: doc.token })
            .eq('id', documentRowId);
          const detail =
            err instanceof ZapsignApiError ? err.body?.trim().slice(0, 300) : '';
          throw new Error(
            `document ${doc.token} was created but the extra document from template ${extraTemplate} could not be attached, so no link was sent — cancel it at ZapSign before running again${detail ? ` — ZapSign said: ${detail}` : ` (${(err as Error).message})`}`
          );
        }
      }
      const envelopeNote = extraTemplates.length
        ? ` (envelope with ${extraTemplates.length + 1} documents)`
        : '';

      const { error: confirmErr } = await db
        .from('zapsign_documents')
        .update({
          zapsign_token: doc.token,
          sign_url: signer?.sign_url ?? null,
        })
        .eq('id', documentRowId);
      if (confirmErr) {
        throw new Error(
          `document created in ZapSign but could not be linked here: ${confirmErr.message}`
        );
      }

      if (!sendViaWhatsapp) {
        return `signature request sent (zapsign ${doc.token})${envelopeNote}`;
      }
      if (!signer?.sign_url) {
        throw new Error('ZapSign did not return a sign_url for the signer');
      }
      // Substitui o token {{signer_url}} ANTES da passada geral de
      // interpolate() — interpolate() zera qualquer {{...}} que não
      // conheça (só message.* / vars.* sobrevivem), então rodá-lo antes
      // apagaria o link em silêncio. O padrão tolera espaços
      // (`{{ signer_url }}`), que é como os outros campos do builder
      // ensinam a escrever token, e casa todas as ocorrências. A
      // substituição por função evita que um `$&` na URL seja lido como
      // referência de captura.
      const signUrl = signer.sign_url;
      const text = interpolate(
        cfg.message_text!.replace(SIGNER_URL_TOKEN, () => signUrl),
        args
      );
      await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        // Não-nulo aqui por construção: só é null quando
        // sendViaWhatsapp é false, e esse caminho já retornou acima.
        conversationId: conversationId!,
        contactId: args.contactId,
        text,
      });
      return `signature request sent (zapsign ${doc.token})${envelopeNote}; link sent via WhatsApp`;
    }

    case 'close_conversation': {
      if (!args.contactId)
        throw new Error('close_conversation needs a contact');
      await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId);
      return 'conversation closed';
    }

    // Passo desconhecido é automação QUEBRADA, não passo sem efeito: ou
    // a configuração veio de um produtor que não é o builder, ou o dado
    // é mais novo que este código. Devolver uma string marcava a
    // execução como sucesso e seguia para os passos seguintes — o funil
    // simplesmente não mexia, sem erro e sem nada a investigar (ver
    // docs/dividas-conhecidas.md#7). Lançar é o que o laço de
    // executeStepsFrom espera para marcar `failed` e interromper.
    default:
      throw new Error(`unknown step: ${step.step_type}`);
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id;
  if (fromCtx) return fromCtx;
  if (!args.contactId)
    throw new Error('cannot resolve conversation: no contact');
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .maybeSingle();
  if (error) throw new Error(`conversation lookup failed: ${error.message}`);
  if (!data?.id) {
    // Gatilhos que não nascem de uma mensagem (etiqueta, funil,
    // varredura periódica) alcançam contatos que podem nunca ter
    // conversado. O prefixo nomeia o gatilho para que o log diga POR
    // QUE não havia conversa, em vez de um "cannot send" cego.
    const CONVERSATIONLESS_TRIGGERS = [
      'tag_added',
      'deal_created',
      'deal_stage_changed',
      'deal_stalled',
      'practice_area_set',
      // O documento pode voltar assinado de um contato que nunca
      // mandou mensagem — o link chega por e-mail ou é entregue à mão.
      'document_signed',
    ];
    const prefix = CONVERSATIONLESS_TRIGGERS.includes(args.triggerEvent)
      ? `${args.triggerEvent} automation cannot send`
      : 'cannot send';
    throw new Error(`${prefix}: contact has no existing conversation`);
  }
  return data.id as string;
}

/**
 * Moeda configurada da conta. Usada em vez do DEFAULT estático de
 * `deals.currency` para respeitar a regra de uma moeda por conta
 * (migration 021) — senão um negócio criado por automação sairia com
 * moeda diferente do resto do funil (issue #218). Cai para USD se a
 * linha não tiver o valor (forks anteriores à 021).
 */
async function accountCurrency(accountId: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle();
  return (data?.default_currency as string | undefined) ?? 'USD';
}

/**
 * Anuncia um evento de funil a partir de dentro de uma execução.
 *
 * O despacho é inline (e não via `lib/deals/stage-events`) para não
 * criar ciclo de importação — o mesmo motivo pelo qual `add_tag`
 * despacha `tag_added` daqui em vez de usar `lib/contacts/tag-events`.
 *
 * A guarda de profundidade é o que impede o ciclo óbvio: mover
 * dispara `deal_stage_changed`, que aciona uma automação que move de
 * novo. Ao estourar o teto a escrita permanece — só o anúncio para.
 *
 * Devolve a profundidade em que cortou, ou `null` quando despachou.
 * Quem chama põe isso no texto do passo, para que o corte apareça na
 * TELA DE LOGS da automação e não só no console do servidor — do
 * contrário o dono da conta veria "sucesso" enquanto o encadeamento
 * parou no meio, sem sinal nenhum. É o mesmo tratamento que `add_tag`
 * já dá ao seu próprio corte.
 */
async function dispatchDealEvent(
  triggerType: 'deal_created' | 'deal_stage_changed',
  args: ExecuteArgs,
  fields: {
    deal_id: string;
    pipeline_id: string;
    from_stage_id?: string;
    to_stage_id: string;
    practice_area?: string;
  }
): Promise<number | null> {
  const depth = getDealChainDepth(args.context);
  if (depth >= MAX_DEAL_CHAIN_DEPTH) {
    console.warn('[automations] deal chain depth limit reached', {
      automationId: args.automation.id,
      triggerType,
      dealId: fields.deal_id,
      depth,
    });
    return depth;
  }

  await runAutomationsForTrigger({
    accountId: args.automation.account_id,
    triggerType,
    contactId: args.contactId,
    context: {
      ...args.context,
      ...fields,
      vars: {
        ...(args.context.vars ?? {}),
        _deal_chain_depth: depth + 1,
      },
    },
  });
  return null;
}

/** Sufixo de log quando a cadeia foi cortada. Vazio quando despachou. */
function chainCutSuffix(cutAtDepth: number | null): string {
  return cutAtDepth === null
    ? ''
    : `; chain dispatch skipped at depth ${cutAtDepth}`;
}

export function triggerMatches(
  automation: Automation,
  ctx: AutomationContext | undefined
): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig;
    if (!cfg?.keywords || cfg.keywords.length === 0) return false;
    const text = (ctx?.message_text ?? '').toString();
    if (!text) return false;
    const haystack = cfg.case_sensitive ? text : text.toLowerCase();
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase();
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k);
    });
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig;
    const replyId = ctx?.interactive_reply_id;
    if (
      !replyId ||
      !Array.isArray(cfg?.reply_ids) ||
      cfg.reply_ids.length === 0
    ) {
      return false;
    }
    return cfg.reply_ids.includes(replyId);
  }

  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig;
    const tagId = ctx?.tag_id;
    return Boolean(tagId && cfg?.tag_id && cfg.tag_id === tagId);
  }

  // ---- Gatilhos de funil ------------------------------------
  // Atenção: esta função termina em `return true`, então um gatilho
  // sem ramo próprio casa com TUDO. Para eventos de funil isso seria
  // desastroso — uma automação de "entrou em Contrato Assinado"
  // dispararia em toda passagem de etapa do funil inteiro.
  //
  // A convenção dos filtros abaixo é: campo vazio significa
  // "qualquer", nunca "nenhum".

  if (automation.trigger_type === 'deal_stage_changed') {
    const cfg = (automation.trigger_config ??
      {}) as DealStageChangedTriggerConfig;
    if (!ctx?.to_stage_id) return false;
    if (cfg.pipeline_id && cfg.pipeline_id !== ctx.pipeline_id) return false;
    if (cfg.to_stage_id && cfg.to_stage_id !== ctx.to_stage_id) return false;
    if (cfg.from_stage_id && cfg.from_stage_id !== ctx.from_stage_id)
      return false;
    return true;
  }

  if (automation.trigger_type === 'deal_created') {
    const cfg = (automation.trigger_config ?? {}) as DealCreatedTriggerConfig;
    if (!ctx?.deal_id) return false;
    if (cfg.pipeline_id && cfg.pipeline_id !== ctx.pipeline_id) return false;
    return true;
  }

  if (automation.trigger_type === 'deal_stalled') {
    const cfg = (automation.trigger_config ?? {}) as DealStalledTriggerConfig;
    // A varredura periódica já consulta o banco por automação, então
    // o contexto chega dirigido. A conferência aqui é rede de
    // segurança contra um despacho manual pela rota /engine.
    if (!ctx?.deal_id) return false;
    if (!cfg?.stage_id) return false;
    // O filtro de funil é redundante na prática — uma etapa já
    // pertence a um único funil — mas o construtor mostra o campo, e
    // um filtro exibido que o motor ignorasse seria pior que um campo
    // ausente: quem configurou acharia estar restringindo algo.
    if (cfg.pipeline_id && cfg.pipeline_id !== ctx.pipeline_id) return false;
    return cfg.stage_id === ctx.to_stage_id;
  }

  if (automation.trigger_type === 'practice_area_set') {
    const cfg = (automation.trigger_config ??
      {}) as PracticeAreaSetTriggerConfig;
    const area = ctx?.practice_area;
    if (!area) return false;
    if (
      !Array.isArray(cfg?.practice_areas) ||
      cfg.practice_areas.length === 0
    ) {
      return true;
    }
    return cfg.practice_areas.includes(area);
  }

  // Anunciado pelo webhook de entrada do ZapSign (migration 044) quando
  // um documento enviado por send_signature_request volta assinado.
  // Mesma convenção de practice_area_set: filtro vazio = qualquer modelo.
  if (automation.trigger_type === 'document_signed') {
    const cfg = (automation.trigger_config ??
      {}) as DocumentSignedTriggerConfig;
    if (!cfg.template_token) return true;
    return cfg.template_token === ctx?.vars?.template_token;
  }

  return true;
}

async function evaluateCondition(
  cfg: ConditionStepConfig,
  args: ExecuteArgs
): Promise<boolean> {
  const db = supabaseAdmin();
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false;
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.operand);
      return (count ?? 0) > 0;
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false;
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle();
      const v = (data as Record<string, unknown> | null)?.[cfg.operand];
      return v != null && String(v) === String(cfg.value ?? '');
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString();
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase());
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-');
      if (!from || !to) return false;
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
      };
      const f = parse(from);
      const t = parse(to);
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t;
    }
    default:
      return false;
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs =
    cfg.unit === 'days'
      ? 86_400_000
      : cfg.unit === 'hours'
        ? 3_600_000
        : 60_000;
  return Math.max(1_000, cfg.amount * unitMs);
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.');
    if (ns === 'message' && prop === 'text')
      return String(args.context.message_text ?? '');
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '');
    if (ns === 'contact' && (prop === 'name' || prop === 'first_name')) {
      // Contato sem nome resolve para vazio, como os demais tokens —
      // quem escreve o texto decide se a saudação sobrevive sem ele.
      const name = (args.context.contact_name ?? '').trim();
      return prop === 'first_name' ? (name.split(/\s+/)[0] ?? '') : name;
    }
    return '';
  });
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null
) {
  if (!logId) return;
  const db = supabaseAdmin();
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single();
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ??
      []),
    ...newItems,
  ];
  const update: Record<string, unknown> = { steps_executed: merged };
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status;
  }
  if (errorMessage) update.error_message = errorMessage;
  await db.from('automation_logs').update(update).eq('id', logId);
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null
) {
  if (!logId) return;
  await supabaseAdmin()
    .from('automation_logs')
    .update({ status, error_message: errorMessage })
    .eq('id', logId);
}

async function markPending(id: string, status: 'done' | 'failed') {
  await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status })
    .eq('id', id);
}
