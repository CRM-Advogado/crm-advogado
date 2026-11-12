import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { flattenSteps, loadStepsTree } from '@/lib/automations/steps-tree'
import { parseAutomationFields, readAutomationJson } from '@/lib/automations/input'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = supabaseAdmin()
  const { data: automation, error } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const steps = await loadStepsTree(id)
  return NextResponse.json({ automation, steps })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await readAutomationJson(request)
  if (!body.ok) return NextResponse.json({ error: body.message }, { status: body.status })
  const parsed = parseAutomationFields(body.value, '', true)
  if (!parsed.ok) {
    return NextResponse.json({ error: 'Invalid automation', issues: [parsed.issue] }, { status: 400 })
  }
  const { steps, ...fields } = parsed.value

  const admin = supabaseAdmin()

  // Ownership check before we touch anything. Load the fields we need
  // to compute the post-patch "effective" state for validation.
  const { data: existing, error: readError } = await admin
    .from('automations')
    .select('id, is_active, trigger_type, trigger_config, updated_at')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .eq('user_id', ctx.userId)
    .maybeSingle()
  if (readError) {
    console.error('[PATCH /api/automations] lookup failed:', readError)
    return NextResponse.json({ error: 'Could not load the automation' }, { status: 500 })
  }
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Editing an active automation must keep it complete. Drafts still
  // accept incomplete configuration once the input structure is valid.
  if (fields.is_active ?? existing.is_active) {
    const mergedTriggerType = fields.trigger_type ?? existing.trigger_type
    const mergedTriggerConfig = fields.trigger_config ?? existing.trigger_config
    const mergedSteps = steps ?? await loadStepsTree(id)
    const issues = [
      ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
      ...validateStepsForActivation(mergedSteps),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot keep automation active with invalid configuration',
          issues,
        },
        { status: 400 },
      )
    }
  }

  if (steps !== undefined || Object.values(fields).some(value => value !== undefined)) {
    const { data: updated, error } = await admin.rpc('update_automation_tree', {
      p_account_id: ctx.accountId,
      p_user_id: ctx.userId,
      p_id: id,
      p_expected_updated_at: existing.updated_at,
      p_fields: fields,
      p_steps: steps === undefined ? null : flattenSteps(steps),
    })
    if (error) {
      console.error('[PATCH /api/automations] update failed:', error)
      return NextResponse.json({ error: 'Could not update the automation' }, { status: 500 })
    }
    if (!updated) {
      return NextResponse.json({ error: 'The automation changed. Reload and try again.' }, { status: 409 })
    }
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Deleting an automation is a write — enforce `agent` (the service-role
  // client below bypasses the agent-gated automations_delete RLS).
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await supabaseAdmin()
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
