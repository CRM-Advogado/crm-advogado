import type { BuilderStepNode } from './steps-tree'
import { CUSTOM_FIELD_PREFIX } from './contact-fields'
import {
  IMPORT_FORMAT_VERSION,
  type CatalogEntry,
  type ReferenceCatalog,
} from './import'

// ------------------------------------------------------------
// Export de automações para o mesmo documento JSON que o import lê.
//
// É o produtor do formato, e é o que torna o arquivo autorável: em
// vez de escrever o primeiro JSON às cegas contra um schema, monta-se
// UMA automação no builder, exporta-se, e o resultado vira o molde
// das outras.
//
// A transformação é a inversa de `import.ts`: todo UUID com um nome
// legível vira nome. A ressalva importante está em `symbolize` — nome
// ambíguo volta como id, porque um export bonito que não reimporta
// seria pior que um id feio.
// ------------------------------------------------------------

export interface ExportedStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes: ExportedStep[]; no: ExportedStep[] }
}

export interface ExportedAutomation {
  name: string
  description?: string
  trigger_type: string
  trigger_config: Record<string, unknown>
  is_active: boolean
  steps: ExportedStep[]
}

export interface ExportDocument {
  version: number
  exported_at: string
  automations: ExportedAutomation[]
}

export interface ExportableAutomation {
  name: string
  description?: string | null
  trigger_type: string
  trigger_config: Record<string, unknown> | null
  is_active: boolean
  steps: BuilderStepNode[]
}

/**
 * Converte um UUID no nome correspondente — mas só quando esse nome
 * reimporta sem ambiguidade.
 *
 * Como `tags.name` e `pipelines.name` não têm UNIQUE (migration 001),
 * uma conta pode ter duas tags "Lead". Exportar o nome nesse caso
 * geraria um arquivo que o import recusa com `ambiguous_reference` —
 * um round-trip quebrado pelo próprio produtor. Nesses casos o id cru
 * é mantido: menos legível, sempre reimportável.
 */
function symbolize(entries: readonly CatalogEntry[], id: unknown): string | null {
  if (typeof id !== 'string' || id.trim() === '') return null
  const entry = entries.find((e) => e.id === id)
  if (!entry) return null

  const key = entry.name.trim().toLowerCase()
  const homonyms = entries.filter((e) => e.name.trim().toLowerCase() === key)
  if (homonyms.length > 1) return null

  return entry.name
}

function swap(
  config: Record<string, unknown>,
  idKey: string,
  symbolicKey: string,
  entries: readonly CatalogEntry[],
): void {
  const name = symbolize(entries, config[idKey])
  if (name === null) return
  delete config[idKey]
  config[symbolicKey] = name
}

/** Etapas só resolvem dentro do funil ao qual pertencem. */
function swapStage(
  config: Record<string, unknown>,
  idKey: string,
  symbolicKey: string,
  catalog: ReferenceCatalog,
): void {
  const pipelineId = config.pipeline_id
  if (typeof pipelineId !== 'string') return
  const scoped = catalog.stages.filter((s) => s.pipeline_id === pipelineId)
  swap(config, idKey, symbolicKey, scoped)
}

function exportTriggerConfig(
  triggerType: string,
  raw: Record<string, unknown> | null,
  catalog: ReferenceCatalog,
): Record<string, unknown> {
  const config = { ...(raw ?? {}) }

  switch (triggerType) {
    case 'tag_added':
      swap(config, 'tag_id', 'tag', catalog.tags)
      break
    case 'deal_created':
      swap(config, 'pipeline_id', 'pipeline', catalog.pipelines)
      break
    case 'deal_stage_changed':
      // A etapa vira nome ANTES do funil: `swapStage` ainda precisa
      // do `pipeline_id` cru para restringir o escopo.
      swapStage(config, 'to_stage_id', 'to_stage', catalog)
      swapStage(config, 'from_stage_id', 'from_stage', catalog)
      swap(config, 'pipeline_id', 'pipeline', catalog.pipelines)
      break
    case 'deal_stalled':
      swapStage(config, 'stage_id', 'stage', catalog)
      swap(config, 'pipeline_id', 'pipeline', catalog.pipelines)
      break
  }

  return config
}

function exportStepConfig(
  stepType: string,
  raw: Record<string, unknown>,
  catalog: ReferenceCatalog,
): Record<string, unknown> {
  const config = { ...raw }

  switch (stepType) {
    case 'add_tag':
    case 'remove_tag':
      swap(config, 'tag_id', 'tag', catalog.tags)
      break

    case 'assign_conversation':
      if (config.mode === 'specific') swap(config, 'agent_id', 'agent', catalog.agents)
      break

    case 'create_deal':
    case 'move_deal_stage':
      swapStage(config, 'stage_id', 'stage', catalog)
      swap(config, 'pipeline_id', 'pipeline', catalog.pipelines)
      break

    case 'update_contact_field': {
      const field = typeof config.field === 'string' ? config.field : ''
      if (field.startsWith(CUSTOM_FIELD_PREFIX)) {
        const name = symbolize(catalog.customFields, field.slice(CUSTOM_FIELD_PREFIX.length))
        if (name !== null) config.field = `${CUSTOM_FIELD_PREFIX}${name}`
      }
      break
    }

    case 'condition':
      // Espelha o caso especial do import: em `tag_presence`, e só
      // nele, `operand` carrega o id de uma tag.
      if (config.subject === 'tag_presence') {
        swap(config, 'operand', 'tag', catalog.tags)
      }
      break
  }

  return config
}

function exportSteps(
  nodes: readonly BuilderStepNode[],
  catalog: ReferenceCatalog,
): ExportedStep[] {
  return nodes.map((node) => {
    const step: ExportedStep = {
      step_type: node.step_type,
      step_config: exportStepConfig(node.step_type, node.step_config ?? {}, catalog),
    }
    // `branches` só é emitido quando há algo dentro: dois arrays
    // vazios em todo `condition` poluem o arquivo que alguém vai
    // editar à mão.
    const yes = node.branches?.yes ?? []
    const no = node.branches?.no ?? []
    if (yes.length > 0 || no.length > 0) {
      step.branches = { yes: exportSteps(yes, catalog), no: exportSteps(no, catalog) }
    }
    return step
  })
}

/**
 * Monta o documento exportado. `now` é injetado para o teste poder
 * fixar `exported_at`.
 */
export function buildExportDocument(
  automations: readonly ExportableAutomation[],
  catalog: ReferenceCatalog,
  now: Date = new Date(),
): ExportDocument {
  return {
    version: IMPORT_FORMAT_VERSION,
    exported_at: now.toISOString(),
    automations: automations.map((a) => {
      const out: ExportedAutomation = {
        name: a.name,
        trigger_type: a.trigger_type,
        trigger_config: exportTriggerConfig(a.trigger_type, a.trigger_config, catalog),
        is_active: a.is_active,
        steps: exportSteps(a.steps, catalog),
      }
      if (a.description) out.description = a.description
      return out
    }),
  }
}
