import type { AutomationTriggerType } from '@/types';
import type { BuilderStepInput } from './steps-tree';

export const AUTOMATION_LIMITS = {
  maxBytes: 512 * 1024,
  maxAutomations: 50,
  maxStepsPerAutomation: 100,
  maxDepth: 10,
} as const;

const MAX_JSON_DEPTH = 64;

const TRIGGER_TYPES = new Set<string>([
  'new_message_received',
  'first_inbound_message',
  'keyword_match',
  'new_contact_created',
  'conversation_assigned',
  'tag_added',
  'time_based',
  'interactive_reply',
  'deal_created',
  'deal_stage_changed',
  'deal_stalled',
  'practice_area_set',
  // Migration 044. Anunciado pelo webhook de entrada do ZapSign; o
  // único campo de `trigger_config` é `template_token`, que é um token
  // do ZapSign e não uma referência a registro desta conta — por isso
  // não aparece em `resolveTriggerRefs`.
  'document_signed',
]);

const STEP_TYPES = new Set<string>([
  'send_message',
  'send_buttons',
  'send_list',
  'send_template',
  'add_tag',
  'remove_tag',
  'assign_conversation',
  'update_contact_field',
  'create_deal',
  'move_deal_stage',
  'wait',
  'condition',
  'send_webhook',
  'close_conversation',
  // Migration 044. `template_token` e as chaves de `variables` são do
  // ZapSign, não do catálogo da conta, então também não há referência a
  // resolver — `validate.ts` já cobra os campos obrigatórios.
  'send_signature_request',
]);

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Issue = {
  path: string;
  message: string;
  code: 'invalid_document' | 'limit_exceeded' | 'unknown_type';
};

type Parsed<T> = { ok: true; value: T } | { ok: false; issue: Issue };

function invalid(path: string, message: string, code: Issue['code'] = 'invalid_document'): Parsed<never> {
  return { ok: false, issue: { path, message, code } };
}

function hasBoundedJsonDepth(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (depth > MAX_JSON_DEPTH) return false;
  return Object.values(value).every(child => hasBoundedJsonDepth(child, depth + 1));
}

export async function readAutomationJson(request: Request): Promise<
  { ok: true; value: unknown } | { ok: false; status: 400 | 413; message: string }
> {
  const tooLarge = {
    ok: false, status: 413, message: 'Request body exceeds 512 KB',
  } as const;
  const malformed = { ok: false, status: 400, message: 'Invalid JSON' } as const;
  const reader = request.body?.getReader();
  if (!reader) return malformed;

  try {
    if (Number(request.headers.get('content-length')) > AUTOMATION_LIMITS.maxBytes) {
      void reader.cancel().catch(() => {});
      return tooLarge;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let raw = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > AUTOMATION_LIMITS.maxBytes) {
        void reader.cancel().catch(() => {});
        return tooLarge;
      }
      raw += decoder.decode(value, { stream: true });
    }
    const value: unknown = JSON.parse(raw + decoder.decode());
    return hasBoundedJsonDepth(value, 1)
      ? { ok: true, value }
      : { ok: false, status: 400, message: 'JSON nesting is too deep' };
  } catch {
    void reader.cancel().catch(() => {});
    return malformed;
  } finally {
    reader.releaseLock();
  }
}

interface AutomationFields {
  name?: string;
  description?: string | null;
  trigger_type?: AutomationTriggerType;
  trigger_config?: Record<string, unknown>;
  is_active?: boolean;
  steps?: BuilderStepInput[];
}

export function parseAutomationFields(
  body: unknown,
  path = '',
  allowFlat = false
): Parsed<AutomationFields> {
  if (!isObject(body)) return invalid(path, 'Automation must be an object');
  const key = (name: string) => path ? path + '.' + name : name;

  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim()))
    return invalid(key('name'), 'name must be a non-empty string');
  if (body.description != null && typeof body.description !== 'string')
    return invalid(key('description'), 'description must be a string or null');
  if (body.trigger_type !== undefined && (
    typeof body.trigger_type !== 'string' || !TRIGGER_TYPES.has(body.trigger_type)
  )) return invalid(key('trigger_type'), 'Unknown trigger type', 'unknown_type');
  if (body.trigger_config !== undefined && !isObject(body.trigger_config))
    return invalid(key('trigger_config'), 'trigger_config must be an object');
  if (body.is_active !== undefined && typeof body.is_active !== 'boolean')
    return invalid(key('is_active'), 'is_active must be a boolean');

  const steps = body.steps === undefined ? undefined : parseSteps(body.steps, key('steps'), allowFlat);
  if (steps && !steps.ok) return steps;

  return {
    ok: true,
    value: {
      name: body.name as string | undefined,
      description: body.description as string | null | undefined,
      trigger_type: body.trigger_type as AutomationTriggerType | undefined,
      trigger_config: body.trigger_config as Record<string, unknown> | undefined,
      is_active: body.is_active as boolean | undefined,
      steps: steps?.value,
    },
  };
}

export function parseSteps(raw: unknown, path: string, allowFlat = false): Parsed<BuilderStepInput[]> {
  if (!Array.isArray(raw)) return invalid(path, 'steps must be an array');
  if (raw.length > AUTOMATION_LIMITS.maxStepsPerAutomation)
    return invalid(path, 'Automation has more than 100 steps', 'limit_exceeded');

  // Some legacy template seeds use positional parent references.
  // Normalize them before checking tree depth or calling activation validators.
  const flat = allowFlat && raw.some(step => isObject(step) && (
    step.parent_index !== undefined || step.branch !== undefined
  ));
  if (flat) {
    const nodes = raw.map(step => isObject(step) ? {
      step_type: step.step_type,
      step_config: step.step_config,
      branches: undefined as { yes: unknown[]; no: unknown[] } | undefined,
    } : step);
    const roots = [];
    for (let index = 0; index < raw.length; index++) {
      const step = raw[index];
      const stepPath = path + '[' + index + ']';
      if (!isObject(step) || step.branches !== undefined)
        return invalid(stepPath, 'Invalid flat step');
      if (step.parent_index == null) {
        if (step.branch != null) return invalid(stepPath, 'Root steps cannot have a branch');
        roots.push(nodes[index]);
        continue;
      }
      const parentIndex = step.parent_index;
      const branch = step.branch ?? 'yes';
      if (typeof parentIndex !== 'number' || !Number.isInteger(parentIndex) ||
        parentIndex < 0 || parentIndex >= raw.length || (branch !== 'yes' && branch !== 'no'))
        return invalid(stepPath, 'Invalid parent index or branch');
      const parent = nodes[parentIndex];
      if (!parent || parent.step_type !== 'condition')
        return invalid(stepPath, 'Parent step must be a condition');
      parent.branches ??= { yes: [], no: [] };
      parent.branches[branch].push(nodes[index]);
    }
    const tree = parseSteps(roots, path);
    if (!tree.ok) return tree;
    if (countTreeNodes(tree.value) !== raw.length) return invalid(path, 'Step parent references contain a cycle');
    return tree;
  }

  let total = 0;
  function walk(steps: unknown[], prefix: string, depth: number): Parsed<BuilderStepInput[]> {
    if (steps.length > 0 && depth > AUTOMATION_LIMITS.maxDepth)
      return invalid(prefix, 'Nesting is deeper than 10 levels', 'limit_exceeded');
    const parsed: BuilderStepInput[] = [];
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const stepPath = prefix + '[' + index + ']';
      if (++total > AUTOMATION_LIMITS.maxStepsPerAutomation)
        return invalid(stepPath, 'Automation has more than 100 steps', 'limit_exceeded');
      if (!isObject(step)) return invalid(stepPath, 'step must be an object');
      if (step.branch !== undefined || step.parent_index !== undefined)
        return invalid(stepPath, 'Use nested branches for steps in this format');
      if (typeof step.step_type !== 'string' || !STEP_TYPES.has(step.step_type))
        return invalid(stepPath + '.step_type', 'Unknown step type', 'unknown_type');
      if (step.step_config !== undefined && !isObject(step.step_config))
        return invalid(stepPath + '.step_config', 'step_config must be an object');
      const node: BuilderStepInput = {
        step_type: step.step_type,
        step_config: { ...step.step_config as Record<string, unknown> | undefined },
      };
      if (step.branches !== undefined) {
        if (step.step_type !== 'condition' || !isObject(step.branches))
          return invalid(stepPath + '.branches', 'Only condition steps can have a branches object');
        if (Object.keys(step.branches).some(branch => branch !== 'yes' && branch !== 'no'))
          return invalid(stepPath + '.branches', 'Condition branches must be yes or no');
        node.branches = {};
        for (const branch of ['yes', 'no'] as const) {
          const children = step.branches[branch];
          if (children === undefined) continue;
          const branchPath = stepPath + '.branches.' + branch;
          if (!Array.isArray(children)) return invalid(branchPath, 'Branch must be an array');
          const result = walk(children, branchPath, depth + 1);
          if (!result.ok) return result;
          node.branches[branch] = result.value;
        }
      }
      parsed.push(node);
    }
    return { ok: true, value: parsed };
  }

  return walk(raw, path, 1);
}

function countTreeNodes(steps: BuilderStepInput[]): number {
  return steps.reduce((count, step) => count + 1 +
    countTreeNodes(step.branches?.yes ?? []) + countTreeNodes(step.branches?.no ?? []), 0);
}
