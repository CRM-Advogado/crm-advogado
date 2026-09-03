import type { AutomationTriggerType } from '@/types';
import { MAX_EXTRA_DOCS } from '@/lib/zapsign/client';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import {
  AUTOMATION_WRITABLE_CONTACT_FIELDS,
  CUSTOM_FIELD_PREFIX,
  isWritableContactField,
} from './contact-fields';
import {
  PRACTICE_AREAS,
  isPracticeAreaKey,
} from '@/lib/contacts/practice-areas';

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string;
  message: string;
}

interface StepLike {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: StepLike[]; no?: StepLike[] };
}

export function validateStepsForActivation(
  steps: StepLike[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
    });
    return issues;
  }
  walk(steps, '', issues);
  return issues;
}

function walk(
  steps: StepLike[],
  prefix: string,
  issues: ValidationIssue[]
): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`;
    validateOne(s, path, issues);
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes) walk(s.branches.yes, `${path}.yes.`, issues);
      if (s.branches.no) walk(s.branches.no, `${path}.no.`, issues);
    }
  });
}

function validateOne(
  step: StepLike,
  path: string,
  issues: ValidationIssue[]
): void {
  const c = step.step_config ?? {};
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({
          path: `${path}.text`,
          message: 'message text is required',
        });
      }
      break;
    case 'send_buttons':
    case 'send_list': {
      // The whole step_config IS the interactive payload; validate it
      // against Meta's limits (same check the engine runs before send).
      const result = validateInteractivePayload(c);
      if (!result.ok) {
        issues.push({ path: `${path}.interactive`, message: result.error });
      }
      break;
    }
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({
          path: `${path}.template_name`,
          message: 'template name is required',
        });
      }
      break;
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required' });
      }
      break;
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
        });
      }
      break;
    case 'update_contact_field': {
      const field = typeof c.field === 'string' ? c.field : '';
      if (!nonEmpty(c.field)) {
        issues.push({
          path: `${path}.field`,
          message: 'field name is required',
        });
      } else if (
        !field.startsWith(CUSTOM_FIELD_PREFIX) &&
        !isWritableContactField(field)
      ) {
        // Same list the engine enforces. Caught here, the user sees it at
        // save time instead of discovering a step that fails on every run.
        issues.push({
          path: `${path}.field`,
          message: `'${field}' is not writable from automations (allowed: ${AUTOMATION_WRITABLE_CONTACT_FIELDS.join(', ')}, or custom:<id>)`,
        });
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({
          path: `${path}.value`,
          message: 'field value is required',
        });
      } else if (field === 'practice_area' && typeof c.value === 'string') {
        // `practice_area` carries a CHECK constraint (migration 039), so a
        // typo is rejected by the database at run time. Catch it now —
        // unless the value is a template resolved from the run context.
        const value = c.value.trim();
        if (!value.includes('{{') && !isPracticeAreaKey(value)) {
          issues.push({
            path: `${path}.value`,
            message: `'${value}' is not a known practice area (${PRACTICE_AREAS.map((a) => a.key).join(', ')})`,
          });
        }
      }
      break;
    }
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({
          path: `${path}.pipeline_id`,
          message: 'pipeline is required',
        });
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' });
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required' });
      }
      break;

    case 'move_deal_stage':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({
          path: `${path}.pipeline_id`,
          message: 'pipeline is required',
        });
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' });
      }
      // `match_by` ausente vale `auto` no motor, então só um valor
      // explícito e desconhecido é erro — mesma regra já aplicada ao
      // `match_type` do gatilho de palavra-chave.
      if (
        c.match_by != null &&
        !['auto', 'practice_area', 'latest_open', 'context'].includes(
          String(c.match_by)
        )
      ) {
        issues.push({
          path: `${path}.match_by`,
          message:
            'match mode must be "auto", "practice_area", "latest_open" or "context"',
        });
      }
      // Criar o negócio exige um título: `deals.title` é NOT NULL, e
      // deixar o motor inventar um rótulo produziria cartões
      // indistinguíveis no quadro.
      if (c.create_if_missing === true && !nonEmpty(c.title)) {
        issues.push({
          path: `${path}.title`,
          message: 'title is required when creating a deal',
        });
      }
      // Combinação impossível: `context` só move o negócio que
      // disparou o gatilho e nunca cria nada. Marcar as duas coisas
      // significa que quem configurou entendeu uma delas errado.
      if (c.create_if_missing === true && c.match_by === 'context') {
        issues.push({
          path: `${path}.create_if_missing`,
          message: 'cannot create a deal when matching by trigger context',
        });
      }
      if (
        c.set_status != null &&
        !['open', 'won', 'lost'].includes(String(c.set_status))
      ) {
        issues.push({
          path: `${path}.set_status`,
          message: 'status must be "open", "won" or "lost"',
        });
      }
      break;
    case 'wait':
      if (
        typeof c.amount !== 'number' ||
        !Number.isFinite(c.amount) ||
        c.amount <= 0
      ) {
        issues.push({
          path: `${path}.amount`,
          message: 'wait amount must be greater than 0',
        });
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be minutes, hours, or days',
        });
      }
      break;
    case 'condition':
      if (!nonEmpty(c.subject)) {
        issues.push({
          path: `${path}.subject`,
          message: 'condition subject is required',
        });
      }
      if (!nonEmpty(c.operand)) {
        issues.push({
          path: `${path}.operand`,
          message: 'condition operand is required',
        });
      }
      break;
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({
          path: `${path}.url`,
          message: 'webhook URL is required',
        });
        break;
      }
      try {
        const u = new URL(String(c.url));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
          });
        }
      } catch {
        issues.push({
          path: `${path}.url`,
          message: 'webhook URL is not a valid URL',
        });
      }
      break;
    case 'close_conversation':
      // No config required.
      break;
    case 'send_signature_request':
      if (!nonEmpty(c.template_token)) {
        issues.push({
          path: `${path}.template_token`,
          message: 'ZapSign template is required',
        });
      }
      if (!nonEmpty(c.document_name)) {
        issues.push({
          path: `${path}.document_name`,
          message: 'document name is required',
        });
      }
      // Os anexos sao cobrados no save, e nao em tempo de execucao,
      // porque anexo NAO pode ser removido depois de criado: um
      // envelope montado errado nao tem desfazer, so cancelar e refazer
      // — gastando credito de novo.
      const extras = c.extra_template_tokens;
      if (extras !== undefined) {
        if (!Array.isArray(extras) || extras.some((tok) => !nonEmpty(tok))) {
          issues.push({
            path: `${path}.extra_template_tokens`,
            message: "extra templates must be a list of ZapSign template tokens",
          });
        } else {
          const list = extras as string[];
          if (list.length > MAX_EXTRA_DOCS) {
            issues.push({
              path: `${path}.extra_template_tokens`,
              message: `at most ${MAX_EXTRA_DOCS} extra documents per envelope`,
            });
          }
          if (new Set(list).size !== list.length) {
            issues.push({
              path: `${path}.extra_template_tokens`,
              message: "the same template is attached more than once",
            });
          }
          if (typeof c.template_token === "string" && list.includes(c.template_token)) {
            issues.push({
              path: `${path}.extra_template_tokens`,
              message: "the main template is also attached as an extra document",
            });
          }
        }
      }
      // Same discipline as send_message.text: this text goes straight to
      // the lead over WhatsApp, so a blank template would silently send
      // nothing (or throw at run time) instead of failing at save time.
      //
      // `!== false` e não `=== true`: ausente vale LIGADO, igual ao
      // motor e ao builder. Com `=== true`, um payload importado sem o
      // campo passava aqui sem texto e o motor mandava mensagem vazia.
      if (c.send_via_whatsapp !== false && !nonEmpty(c.message_text)) {
        issues.push({
          path: `${path}.message_text`,
          message:
            'message text is required when sending the link via WhatsApp',
        });
      }
      break;
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}` });
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>;

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords;
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({
        path: 'trigger.keywords',
        message: 'at least one keyword is required',
      });
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.keywords',
        message: 'keywords cannot be empty strings',
      });
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (
      cfg.match_type != null &&
      cfg.match_type !== 'exact' &&
      cfg.match_type !== 'contains'
    ) {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact" or "contains"',
      });
    }
  } else if (triggerType === 'time_based') {
    if (!nonEmpty(cfg.schedule)) {
      issues.push({
        path: 'trigger.schedule',
        message: 'schedule is required',
      });
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required' });
    }
  } else if (triggerType === 'interactive_reply') {
    const ids = cfg.reply_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'at least one reply id is required',
      });
    } else if (ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'reply ids cannot be empty strings',
      });
    }
  } else if (triggerType === 'deal_stalled') {
    // Único gatilho de funil com campos obrigatórios. A varredura
    // periódica pergunta ao banco "quem está parado NESTA etapa há
    // mais de N dias" — sem etapa não há consulta, e sem prazo não há
    // significado. Nenhum dos dois tem padrão razoável: um `days`
    // implícito faria a automação disparar num prazo que ninguém
    // escolheu.
    if (!nonEmpty(cfg.stage_id)) {
      issues.push({ path: 'trigger.stage_id', message: 'stage is required' });
    }
    const days = cfg.days;
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
      issues.push({
        path: 'trigger.days',
        message: 'days must be a number greater than zero',
      });
    }
  } else if (triggerType === 'practice_area_set') {
    // Lista vazia = qualquer tese. Só entradas inválidas são erro.
    const areas = cfg.practice_areas;
    if (areas != null && !Array.isArray(areas)) {
      issues.push({
        path: 'trigger.practice_areas',
        message: 'practice areas must be a list',
      });
    } else if (
      Array.isArray(areas) &&
      areas.some((v) => typeof v !== 'string' || v.trim() === '')
    ) {
      issues.push({
        path: 'trigger.practice_areas',
        message: 'practice areas cannot be empty strings',
      });
    }
  }
  // `deal_created`, `deal_stage_changed` e `document_signed` não
  // aparecem aqui de propósito: todos os seus campos são filtros
  // opcionais, e vazio significa "qualquer". Não há configuração
  // inválida a barrar.

  return issues;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}
