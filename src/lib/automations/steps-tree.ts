import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Builder payload → flat rows for automation_steps.
// Root steps arrive in order. A Condition step carries its children
// under `branches: { yes: [...], no: [...] }`. We walk the tree and
// generate UUIDs so parent_step_id references resolve in a
// single INSERT.
// ------------------------------------------------------------

export interface BuilderStepInput {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: BuilderStepInput[]; no?: BuilderStepInput[] }
}

interface StepRow {
  id: string
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  step_type: string
  step_config: Record<string, unknown>
  position: number
}

/** Generate IDs here so API callers cannot choose step primary keys. */
export function flattenSteps(input: BuilderStepInput[]): StepRow[] {
  const rows: StepRow[] = []
  function walk(
    steps: BuilderStepInput[],
    parentId: string | null,
    branch: 'yes' | 'no' | null
  ) {
    steps.forEach((step, position) => {
      const id = crypto.randomUUID()
      rows.push({
        id,
        parent_step_id: parentId,
        branch,
        step_type: step.step_type,
        step_config: step.step_config,
        position,
      })
      if (step.branches?.yes) walk(step.branches.yes, id, 'yes')
      if (step.branches?.no) walk(step.branches.no, id, 'no')
    })
  }
  walk(input, null, null)
  return rows
}

/**
 * Load the steps for an automation and rebuild the nested tree shape
 * the builder UI expects. One query, O(n) assembly.
 */
export interface BuilderStepNode extends BuilderStepInput {
  id: string
  branches: { yes: BuilderStepNode[]; no: BuilderStepNode[] }
}

interface DbStep {
  id: string
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  step_type: string
  step_config: Record<string, unknown>
  position: number
}

export async function loadStepsTree(automationId: string): Promise<BuilderStepNode[]> {
  const { data, error } = await supabaseAdmin()
    .from('automation_steps')
    .select('*')
    .eq('automation_id', automationId)
    .order('position', { ascending: true })

  if (error) throw new Error(error.message)
  const rows = (data ?? []) as DbStep[]

  const byId = new Map<string, BuilderStepNode>()
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      step_type: row.step_type,
      step_config: row.step_config ?? {},
      branches: { yes: [], no: [] },
    })
  }

  const roots: BuilderStepNode[] = []
  for (const row of rows) {
    const node = byId.get(row.id)!
    if (row.parent_step_id) {
      const parent = byId.get(row.parent_step_id)
      if (parent) {
        const bucket = (row.branch ?? 'yes') as 'yes' | 'no'
        parent.branches[bucket].push(node)
      }
    } else {
      roots.push(node)
    }
  }
  return roots
}
