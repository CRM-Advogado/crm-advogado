import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getTemplate } from '@/lib/automations/templates'
import { insertSteps, type BuilderStepInput } from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('automations')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ automations: data ?? [] })
}

export async function POST(request: Request) {
  // Creating an automation is a write — the RLS automations_insert policy
  // requires `agent`, but this route inserts via the service-role client
  // which bypasses RLS, so the role must be enforced here.
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Resolve the caller's account_id — `automations.account_id` is NOT
  // NULL post-017, so an INSERT without it trips the not-null constraint
  // even though the admin client bypasses RLS.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { name, description, trigger_type, trigger_config, is_active, steps, template } = body

  let effectiveSteps: BuilderStepInput[] | undefined = steps
  let effectiveName = name
  let effectiveDescription = description
  let effectiveTriggerType = trigger_type
  let effectiveTriggerConfig = trigger_config

  if (template && (!steps || steps.length === 0)) {
    const t = getTemplate(template)
    if (t) {
      effectiveName = effectiveName ?? t.name
      effectiveDescription = effectiveDescription ?? t.description
      effectiveTriggerType = effectiveTriggerType ?? t.trigger_type
      effectiveTriggerConfig = effectiveTriggerConfig ?? t.trigger_config
      effectiveSteps = t.steps as unknown as BuilderStepInput[]
    }
  }

  if (!effectiveName || !effectiveTriggerType) {
    return NextResponse.json(
      { error: 'name and trigger_type are required' },
      { status: 400 },
    )
  }

  // Block activation of a clearly broken automation up-front instead of
  // letting every trigger silently produce a failed log row. Drafts
  // (is_active=false) are allowed to be incomplete so users can save
  // progress mid-build.
  if (is_active) {
    const issues = [
      ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
      ...validateStepsForActivation(
        (effectiveSteps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[],
      ),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        { error: 'Cannot activate automation with invalid configuration', issues },
        { status: 400 },
      )
    }
  }

  const admin = supabaseAdmin()
  const { data: automation, error: insertErr } = await admin
    .from('automations')
    .insert({
      user_id: user.id,
      account_id: accountId,
      name: effectiveName,
      description: effectiveDescription ?? null,
      trigger_type: effectiveTriggerType,
      trigger_config: effectiveTriggerConfig ?? {},
      is_active: !!is_active,
    })
    .select()
    .single()

  if (insertErr || !automation) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'insert failed' },
      { status: 500 },
    )
  }

  if (effectiveSteps && effectiveSteps.length > 0) {
    const err = await insertSteps(automation.id, effectiveSteps)
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }

  return NextResponse.json({ automation }, { status: 201 })
}

// ------------------------------------------------------------
// DELETE /api/automations?all=true → apaga TODAS as automações da conta
//
// Existe para poupar quem precisa esvaziar a aba: sem isso é um
// DELETE por automação, um diálogo de confirmação de cada vez.
//
// O `?all=true` é obrigatório de propósito. Sem ele, qualquer
// DELETE que chegasse a esta URL por engano — um fetch com o método
// errado, um cliente mal configurado — apagaria a conta inteira. O
// parâmetro faz a intenção precisar ser escrita.
//
// Escopo por CONTA, não por usuário. É a diferença mais importante
// em relação ao DELETE /api/automations/[id], que filtra por
// `user_id` (e por isso não apaga a automação criada por um colega,
// embora ela apareça na lista). Aqui o cliente é o SSR sob RLS, e a
// política `automations_delete` da migration 017 permite a qualquer
// `agent` apagar automação da própria conta — que é exatamente o
// conjunto que a tela mostra. Um "remover todos" que deixasse linhas
// para trás pareceria quebrado.
//
// O `.eq('account_id')` é redundante sob RLS e fica de propósito,
// pelo mesmo motivo do export: sobreviver a uma troca deste cliente
// pelo service-role.
//
// Não há transação, e não precisa haver: as tabelas-filhas
// (`automation_steps`, `automation_logs`,
// `automation_pending_executions`, `automation_stalled_dispatches`)
// são todas ON DELETE CASCADE, e `zapsign_documents.automation_id` é
// ON DELETE SET NULL — o documento assinado sobrevive à automação
// que o gerou.
// ------------------------------------------------------------

export async function DELETE(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  if (new URL(request.url).searchParams.get('all') !== 'true') {
    return NextResponse.json(
      { error: 'Refusing to delete: pass ?all=true to confirm' },
      { status: 400 },
    )
  }

  // `.select('id')` faz o PostgREST devolver as linhas apagadas, que
  // é a única forma de saber quantas eram — o count vai para o toast.
  const { data, error } = await ctx.supabase
    .from('automations')
    .delete()
    .eq('account_id', ctx.accountId)
    .select('id')

  if (error) {
    console.error('[DELETE /api/automations] delete failed:', error)
    return NextResponse.json(
      { error: 'Could not delete automations' },
      { status: 500 },
    )
  }

  return NextResponse.json({ deleted: (data ?? []).length })
}
