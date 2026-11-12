import type { AutomationTriggerType } from '@/types';
import type { BuilderStepInput } from './steps-tree';
import { CUSTOM_FIELD_PREFIX } from './contact-fields';
import { AUTOMATION_LIMITS as IMPORT_LIMITS, isObject, parseAutomationFields } from './input';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from './validate';

// ------------------------------------------------------------
// Import de automações a partir de um documento JSON.
//
// O parser compartilhado valida a estrutura, os tipos e os limites.
// O import também resolve referências contra o catálogo da conta,
// verifica a configuração completa e mantém os caminhos do arquivo
// nos erros exibidos na prévia.
// O módulo é puro de propósito — recebe o catálogo pronto em vez de
// consultar o Supabase — para ser testável sem tocar o banco, como
// manda a convenção de `src/lib`. A parte impura vive em
// `reference-catalog.ts`; a checagem de SSRF, que resolve DNS, fica
// em `checkWebhookUrls`, com o resolvedor injetado.
// ------------------------------------------------------------

/** Versão do formato do arquivo. Mudança incompatível vira 2. */
export const IMPORT_FORMAT_VERSION = 1;

export { AUTOMATION_LIMITS as IMPORT_LIMITS } from './input';

export type ImportIssueCode =
  | 'invalid_document'
  | 'limit_exceeded'
  | 'unknown_type'
  | 'invalid_config'
  | 'unresolved_reference'
  | 'ambiguous_reference';

export interface ImportIssue {
  /** Caminho no documento, ex. `automations[0].steps[1].tag`. */
  path: string;
  message: string;
  code: ImportIssueCode;
}

/** Uma automação pronta para persistir, com os IDs já resolvidos. */
export interface ParsedAutomation {
  name: string;
  description: string | null;
  trigger_type: AutomationTriggerType;
  trigger_config: Record<string, unknown>;
  is_active: boolean;
  steps: BuilderStepInput[];
}

export interface ImportResult {
  automations: ParsedAutomation[];
  issues: ImportIssue[];
}

// ------------------------------------------------------------
// Catálogo de referências da conta
// ------------------------------------------------------------

export interface CatalogEntry {
  id: string;
  name: string;
}

export interface StageEntry extends CatalogEntry {
  pipeline_id: string;
}

/**
 * Tudo que o documento pode referenciar por nome, já filtrado por
 * `account_id`. O que não está aqui não pertence à conta — é assim
 * que a checagem de posse acontece, sem uma consulta por referência.
 */
export interface ReferenceCatalog {
  tags: CatalogEntry[];
  pipelines: CatalogEntry[];
  stages: StageEntry[];
  agents: CatalogEntry[];
  customFields: CatalogEntry[];
}

export const EMPTY_CATALOG: ReferenceCatalog = {
  tags: [],
  pipelines: [],
  stages: [],
  agents: [],
  customFields: [],
};

// ------------------------------------------------------------
// Resolução de uma referência
// ------------------------------------------------------------

type Resolution =
  | { ok: true; id: string }
  | {
      ok: false;
      code: 'unresolved_reference' | 'ambiguous_reference';
      message: string;
    };

/**
 * Aceita tanto o UUID quanto o nome, e nos dois casos o valor só
 * resolve se estiver no catálogo da conta.
 *
 * Nomes NÃO são únicos no banco: `tags.name`, `pipelines.name` e
 * `pipeline_stages.name` não têm constraint UNIQUE (migration 001).
 * Duas tags "Lead" tornam a intenção indecidível, e escolher a
 * primeira ligaria a automação na tag errada em silêncio — por isso
 * ambiguidade aqui é erro duro.
 *
 * Isso diverge de `lib/contacts/resolve-import-tags.ts`, que no
 * import de CSV fica com a primeira tag homônima. A diferença é
 * proposital: um contato com a tag errada se conserta na hora em que
 * alguém olha; uma automação ligada na tag errada dispara errado em
 * toda execução, indefinidamente.
 */
function resolve(
  entries: readonly CatalogEntry[],
  raw: unknown,
  label: string
): Resolution {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      code: 'unresolved_reference',
      message: `${label} is required`,
    };
  }
  const value = raw.trim();

  const byId = entries.find((e) => e.id === value);
  if (byId) return { ok: true, id: byId.id };

  const lower = value.toLowerCase();
  const byName = entries.filter((e) => e.name.trim().toLowerCase() === lower);
  if (byName.length === 1) return { ok: true, id: byName[0].id };
  if (byName.length > 1) {
    return {
      ok: false,
      code: 'ambiguous_reference',
      message: `${byName.length} ${label} entries are named '${value}' — rename one or reference it by id`,
    };
  }
  return {
    ok: false,
    code: 'unresolved_reference',
    message: `${label} '${value}' does not exist in this account`,
  };
}

// ------------------------------------------------------------
// Entrada principal
// ------------------------------------------------------------

/**
 * Valida e normaliza o documento inteiro. Nunca lança: tudo que
 * estiver errado volta em `issues`, com caminho, para a prévia
 * mostrar de uma vez em vez de um erro por tentativa.
 *
 * O chamador só deve gravar quando `issues` estiver vazio — a
 * importação é tudo-ou-nada.
 */
export function parseImportDocument(
  raw: unknown,
  catalog: ReferenceCatalog
): ImportResult {
  const issues: ImportIssue[] = [];
  const out: ParsedAutomation[] = [];

  if (!isObject(raw)) {
    issues.push({
      path: '',
      message: 'document must be a JSON object',
      code: 'invalid_document',
    });
    return { automations: out, issues };
  }

  if (raw.version !== undefined && raw.version !== IMPORT_FORMAT_VERSION) {
    issues.push({
      path: 'version',
      message: `unsupported format version ${String(raw.version)} (expected ${IMPORT_FORMAT_VERSION})`,
      code: 'invalid_document',
    });
    return { automations: out, issues };
  }

  const list = raw.automations;
  if (!Array.isArray(list)) {
    issues.push({
      path: 'automations',
      message: 'automations must be an array',
      code: 'invalid_document',
    });
    return { automations: out, issues };
  }
  if (list.length === 0) {
    issues.push({
      path: 'automations',
      message: 'file contains no automations',
      code: 'invalid_document',
    });
    return { automations: out, issues };
  }
  if (list.length > IMPORT_LIMITS.maxAutomations) {
    issues.push({
      path: 'automations',
      message: `file has ${list.length} automations (limit is ${IMPORT_LIMITS.maxAutomations})`,
      code: 'limit_exceeded',
    });
    return { automations: out, issues };
  }

  // Nomes repetidos DENTRO do arquivo. Não é erro no banco — não há
  // unique em `automations.name` — mas duas automações homônimas na
  // lista são indistinguíveis para quem for editá-las depois, e o
  // caso quase sempre é copiar-colar sem trocar o nome.
  const seen = new Map<string, number>();

  list.forEach((entry, i) => {
    const path = `automations[${i}]`;
    const parsed = parseOne(entry, path, catalog, issues);
    if (!parsed) return;

    const key = parsed.name.trim().toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      issues.push({
        path: `${path}.name`,
        message: `duplicate name '${parsed.name}' (already used by automations[${first}])`,
        code: 'invalid_document',
      });
    } else {
      seen.set(key, i);
    }
    out.push(parsed);
  });

  return { automations: out, issues };
}

function parseOne(
  entry: unknown,
  path: string,
  catalog: ReferenceCatalog,
  issues: ImportIssue[]
): ParsedAutomation | null {
  if (!isObject(entry)) {
    issues.push({
      path,
      message: 'automation must be an object',
      code: 'invalid_document',
    });
    return null;
  }

  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!name) {
    issues.push({
      path: `${path}.name`,
      message: 'name is required',
      code: 'invalid_document',
    });
  }

  const fields = parseAutomationFields(entry, path);
  if (!fields.ok) {
    issues.push(fields.issue);
    return null;
  }

  const { trigger_type: triggerType } = fields.value;
  if (!triggerType) {
    issues.push({
      path: path + '.trigger_type',
      message: 'trigger_type is required',
      code: 'unknown_type',
    });
    return null;
  }

  // Caminhos cujo erro de `validate.ts` seria só o eco de uma
  // referência que já falhou. Ver `RefTarget.validateBase`.
  const suppress = new Set<string>();

  const triggerConfig = { ...fields.value.trigger_config };
  resolveTriggerRefs(
    triggerType,
    triggerConfig,
    `${path}.trigger_config`,
    // `validate.ts` reporta gatilho como `trigger.<campo>`, não
    // `trigger_config.<campo>`.
    `${path}.trigger`,
    catalog,
    issues,
    suppress
  );

  const steps = fields.value.steps ?? [];
  resolveStepTree(steps, path + '.steps', path + '.', catalog, issues, suppress);

  // `is_active` ausente vale falso. Importar dezenas de automações já
  // ligadas dispararia mensagens reais no WhatsApp de clientes no
  // instante do upload; ligar é uma escolha que o arquivo precisa
  // declarar, e que a prévia mostra antes de qualquer gravação.
  const isActive = fields.value.is_active ?? false;

  // A prévia de importação continua exigindo configuração completa,
  // mesmo quando o arquivo pede para manter a automação desativada.
  const validated = [
    ...validateTriggerForActivation(triggerType, triggerConfig),
    ...validateStepsForActivation(steps),
  ];
  for (const issue of validated) {
    const full = `${path}.${issue.path}`;
    // Quando a referência já foi reportada, o "campo obrigatório
    // ausente" que sobra é consequência dela — e aponta para uma
    // chave (`tag_id`) que nem aparece no arquivo de quem escreveu
    // `tag`. Mostrar os dois dobra a lista de erros sem acrescentar
    // uma informação acionável.
    if (suppress.has(full)) continue;
    issues.push({ path: full, message: issue.message, code: 'invalid_config' });
  }

  return {
    name,
    description: fields.value.description?.trim() || null,
    trigger_type: triggerType,
    trigger_config: triggerConfig,
    is_active: isActive,
    steps,
  };
}

function resolveStepTree(
  steps: BuilderStepInput[],
  path: string,
  validatePrefix: string,
  catalog: ReferenceCatalog,
  issues: ImportIssue[],
  suppress: Set<string>
): void {
  steps.forEach((step, index) => {
    const stepPath = path + '[' + index + ']';
    const validatePath = validatePrefix + 'steps[' + index + ']';
    resolveStepRefs(
      step.step_type,
      step.step_config,
      stepPath + '.step_config',
      validatePath,
      catalog,
      issues,
      suppress
    );
    for (const branch of ['yes', 'no'] as const) {
      const children = step.branches?.[branch];
      if (children) resolveStepTree(
        children, stepPath + '.branches.' + branch, validatePath + '.' + branch + '.',
        catalog, issues, suppress
      );
    }
  });
}


// ------------------------------------------------------------
// Mapa simbólico → UUID
//
// No arquivo escreve-se `"tag": "Lead BPC"`; no banco vai `tag_id`.
// A forma com UUID continua aceita — é o que um config copiado do
// builder tem — mas passa pelo mesmo caminho: se não está no
// catálogo da conta, não resolve.
// ------------------------------------------------------------

/**
 * Onde uma referência mora e como reportá-la.
 *
 * `validateBase` existe por um motivo específico: quando uma
 * referência não resolve, o id é removido do config, e aí
 * `validate.ts` — que roda depois e não sabe de nada disso — reclama
 * que o campo obrigatório está faltando. O usuário veria dois erros
 * para o mesmo problema, e o segundo apontando para um caminho
 * (`steps[1].tag_id`) que nem existe no arquivo dele, que escreveu
 * `tag`. Guardar o caminho que `validate.ts` VAI usar permite
 * descartar esse eco.
 */
interface RefTarget {
  config: Record<string, unknown>;
  /** Chave legível no arquivo (`tag`). */
  symbolicKey: string;
  /** Chave gravada no banco (`tag_id`). */
  idKey: string;
  entries: readonly CatalogEntry[];
  label: string;
  /** Caminho do config no documento, para a mensagem. */
  path: string;
  /** Prefixo dos caminhos que `validate.ts` produz para este passo. */
  validateBase: string;
  required: boolean;
}

function resolveInto(
  target: RefTarget,
  issues: ImportIssue[],
  suppress: Set<string>
): void {
  const { config, symbolicKey, idKey, label, path, validateBase, required } =
    target;

  const raw = config[symbolicKey] ?? config[idKey];
  delete config[symbolicKey];

  if (raw === undefined || raw === null || raw === '') {
    if (required) {
      issues.push({
        path: `${path}.${symbolicKey}`,
        message: `${label} is required`,
        code: 'unresolved_reference',
      });
      suppress.add(`${validateBase}.${idKey}`);
    }
    delete config[idKey];
    return;
  }

  const res = resolve(target.entries, raw, label);
  if (res.ok) {
    config[idKey] = res.id;
    return;
  }

  // O id que não resolve é removido: gravá-lo produziria exatamente
  // o passo que falha em toda execução que este módulo existe para
  // impedir. O eco de `validate.ts` sobre o campo agora ausente é
  // suprimido — o erro útil já está na lista.
  delete config[idKey];
  issues.push({
    path: `${path}.${symbolicKey}`,
    message: res.message,
    code: res.code,
  });
  suppress.add(`${validateBase}.${idKey}`);
}

/** Havia alguma referência a funil no config, resolvida ou não? */
function pipelineWasDeclared(config: Record<string, unknown>): boolean {
  const raw = config.pipeline ?? config.pipeline_id;
  return raw !== undefined && raw !== null && raw !== '';
}

function resolveTriggerRefs(
  triggerType: string,
  config: Record<string, unknown>,
  path: string,
  validateBase: string,
  catalog: ReferenceCatalog,
  issues: ImportIssue[],
  suppress: Set<string>
): void {
  const base = { config, path, validateBase };
  const pipeline = (required: boolean) => ({
    ...base,
    symbolicKey: 'pipeline',
    idKey: 'pipeline_id',
    entries: catalog.pipelines,
    label: 'pipeline',
    required,
  });

  switch (triggerType) {
    case 'tag_added':
      resolveInto(
        {
          ...base,
          symbolicKey: 'tag',
          idKey: 'tag_id',
          entries: catalog.tags,
          label: 'tag',
          required: true,
        },
        issues,
        suppress
      );
      break;
    case 'deal_created':
      resolveInto(pipeline(false), issues, suppress);
      break;
    case 'deal_stage_changed': {
      const declared = pipelineWasDeclared(config);
      resolveInto(pipeline(false), issues, suppress);
      resolveStage(
        base,
        'to_stage',
        'to_stage_id',
        catalog,
        issues,
        suppress,
        false,
        declared
      );
      resolveStage(
        base,
        'from_stage',
        'from_stage_id',
        catalog,
        issues,
        suppress,
        false,
        declared
      );
      break;
    }
    case 'deal_stalled': {
      const declared = pipelineWasDeclared(config);
      resolveInto(pipeline(false), issues, suppress);
      resolveStage(
        base,
        'stage',
        'stage_id',
        catalog,
        issues,
        suppress,
        true,
        declared
      );
      break;
    }
  }
}

function resolveStepRefs(
  stepType: string,
  config: Record<string, unknown>,
  path: string,
  validateBase: string,
  catalog: ReferenceCatalog,
  issues: ImportIssue[],
  suppress: Set<string>
): void {
  const base = { config, path, validateBase };
  const tag = (idKey: string) => ({
    ...base,
    symbolicKey: 'tag',
    idKey,
    entries: catalog.tags,
    label: 'tag',
    required: true,
  });

  switch (stepType) {
    case 'add_tag':
    case 'remove_tag':
      resolveInto(tag('tag_id'), issues, suppress);
      break;

    case 'assign_conversation':
      // Só o modo `specific` aponta para alguém; `round_robin`
      // distribui e não tem destinatário a resolver.
      if (config.mode === 'specific') {
        resolveInto(
          {
            ...base,
            symbolicKey: 'agent',
            idKey: 'agent_id',
            entries: catalog.agents,
            label: 'agent',
            required: true,
          },
          issues,
          suppress
        );
      } else {
        delete config.agent;
      }
      break;

    case 'create_deal':
    case 'move_deal_stage': {
      const declared = pipelineWasDeclared(config);
      resolveInto(
        {
          ...base,
          symbolicKey: 'pipeline',
          idKey: 'pipeline_id',
          entries: catalog.pipelines,
          label: 'pipeline',
          required: true,
        },
        issues,
        suppress
      );
      resolveStage(
        base,
        'stage',
        'stage_id',
        catalog,
        issues,
        suppress,
        true,
        declared
      );
      break;
    }

    case 'update_contact_field':
      resolveCustomField(config, path, validateBase, catalog, issues, suppress);
      break;

    case 'condition':
      // `tag_presence` guarda o id da tag em `operand` — o mesmo
      // campo que, para os outros sujeitos, é nome de coluna, trecho
      // de texto ou faixa de horário. Só neste caso é referência.
      if (config.subject === 'tag_presence') {
        resolveInto(tag('operand'), issues, suppress);
      }
      break;
  }
}

/**
 * Etapas resolvem DENTRO do funil já resolvido, por duas razões:
 * `pipeline_stages` não tem `account_id` — a migration 017 não a
 * incluiu, e o vínculo com a conta existe só via `pipelines` — e
 * nomes como "Novo" ou "Fechado" se repetem entre funis, então
 * resolver globalmente seria ambíguo quase sempre.
 */
function resolveStage(
  base: { config: Record<string, unknown>; path: string; validateBase: string },
  symbolicKey: string,
  idKey: string,
  catalog: ReferenceCatalog,
  issues: ImportIssue[],
  suppress: Set<string>,
  required: boolean,
  pipelineDeclared: boolean
): void {
  const { config, path, validateBase } = base;
  const pipelineId =
    typeof config.pipeline_id === 'string' ? config.pipeline_id : null;

  if (!pipelineId) {
    const stageDeclared = declaredValue(config, symbolicKey, idKey) !== null;
    delete config[symbolicKey];
    delete config[idKey];
    // Em qualquer saída por aqui a etapa fica sem id, então o eco de
    // `validate.ts` é sempre ruído derivado.
    suppress.add(`${validateBase}.${idKey}`);

    if (pipelineDeclared) {
      // O funil foi declarado e não resolveu; o erro dele já está na
      // lista. Apontar a etapa também só produziria ruído derivado.
      return;
    }
    if (stageDeclared) {
      // Etapa órfã. Descartá-la em silêncio faria o filtro que a
      // pessoa escreveu desaparecer sem explicação — que é o tipo de
      // falha muda que este módulo existe para impedir.
      issues.push({
        path: `${path}.${symbolicKey}`,
        message: 'a pipeline is required to resolve a stage by name',
        code: 'unresolved_reference',
      });
    } else if (required) {
      issues.push({
        path: `${path}.${symbolicKey}`,
        message: 'stage is required',
        code: 'unresolved_reference',
      });
    }
    return;
  }

  const scoped = catalog.stages.filter((s) => s.pipeline_id === pipelineId);
  resolveInto(
    { ...base, symbolicKey, idKey, entries: scoped, label: 'stage', required },
    issues,
    suppress
  );
}

function declaredValue(
  config: Record<string, unknown>,
  symbolicKey: string,
  idKey: string
): unknown {
  const raw = config[symbolicKey] ?? config[idKey];
  return raw === undefined || raw === null || raw === '' ? null : raw;
}

/**
 * `update_contact_field.field` é ou uma coluna de `contacts`
 * (validada em validate.ts) ou `custom:<uuid>`. No arquivo escreve-se
 * `custom:Número do Processo`; aqui vira o id.
 */
function resolveCustomField(
  config: Record<string, unknown>,
  path: string,
  validateBase: string,
  catalog: ReferenceCatalog,
  issues: ImportIssue[],
  suppress: Set<string>
): void {
  const field = typeof config.field === 'string' ? config.field : '';
  if (!field.startsWith(CUSTOM_FIELD_PREFIX)) return;

  const ref = field.slice(CUSTOM_FIELD_PREFIX.length).trim();
  const res = resolve(catalog.customFields, ref, 'custom field');
  if (res.ok) {
    config.field = `${CUSTOM_FIELD_PREFIX}${res.id}`;
  } else {
    // Melhor um erro que nomeia o campo personalizado do que deixar
    // validate.ts reclamar de uma coluna desconhecida.
    issues.push({
      path: `${path}.field`,
      message: res.message,
      code: res.code,
    });
    config.field = '';
    suppress.add(`${validateBase}.field`);
  }
}

// ------------------------------------------------------------
// SSRF nos passos de webhook
// ------------------------------------------------------------

/** Toda URL de `send_webhook` do documento, com seu caminho. */
export function collectWebhookUrls(
  automations: readonly ParsedAutomation[]
): { path: string; url: string }[] {
  const found: { path: string; url: string }[] = [];

  function walk(steps: readonly BuilderStepInput[], path: string): void {
    steps.forEach((s, i) => {
      const p = `${path}[${i}]`;
      if (s.step_type === 'send_webhook') {
        const url = s.step_config?.url;
        if (typeof url === 'string' && url.trim() !== '') {
          found.push({ path: `${p}.step_config.url`, url: url.trim() });
        }
      }
      if (s.branches?.yes) walk(s.branches.yes, `${p}.branches.yes`);
      if (s.branches?.no) walk(s.branches.no, `${p}.branches.no`);
    });
  }

  automations.forEach((a, i) => walk(a.steps, `automations[${i}].steps`));
  return found;
}

/**
 * Recusa URL de webhook apontada para dentro da rede.
 *
 * O motor já barra isso na hora de entregar (engine.ts chama
 * `isDeliverableUrl`), então nada vaza em execução — mas sem esta
 * checagem o endereço interno fica GRAVADO, passa na prévia como
 * válido e só falha, em silêncio, meses depois. Barrar no import é o
 * que torna a prévia honesta.
 *
 * O resolvedor é injetado para o teste não depender de DNS.
 */
export async function checkWebhookUrls(
  automations: readonly ParsedAutomation[],
  isDeliverable: (url: string) => Promise<boolean>
): Promise<ImportIssue[]> {
  const targets = collectWebhookUrls(automations);
  const results = await Promise.all(
    targets.map(async (t) => ({ ...t, ok: await isDeliverable(t.url) }))
  );
  return results
    .filter((r) => !r.ok)
    .map((r) => ({
      path: r.path,
      message: `webhook URL '${r.url}' is not publicly routable`,
      code: 'invalid_config' as const,
    }));
}

// ------------------------------------------------------------
