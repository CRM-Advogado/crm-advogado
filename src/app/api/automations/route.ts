import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getTemplate } from '@/lib/automations/templates'
import { flattenSteps } from '@/lib/automations/steps-tree'
import { isObject, parseAutomationFields, parseSteps, readAutomationJson } from '@/lib/automations/input'
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

  const template = isObject(body.value) ? body.value.template : undefined
  if (template !== undefined && typeof template !== 'string') {
    return NextResponse.json({ error: 'template must be a string' }, { status: 400 })
  }

  const { is_active } = parsed.value
  let {
    name: effectiveName,
    description: effectiveDescription,
    trigger_type: effectiveTriggerType,
    trigger_config: effectiveTriggerConfig,
    steps: effectiveSteps,
  } = parsed.value

  if (template && !effectiveSteps?.length) {
    const t = getTemplate(template)
    if (t) {
      const parsedTemplate = parseSteps(t.steps, 'steps', true)
      if (!parsedTemplate.ok) {
        return NextResponse.json({ error: 'Invalid automation template' }, { status: 500 })
      }
      effectiveName ??= t.name
      effectiveDescription ??= t.description
      effectiveTriggerType ??= t.trigger_type
      effectiveTriggerConfig ??= { ...t.trigger_config }
      effectiveSteps = parsedTemplate.value
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
      ...validateStepsForActivation(effectiveSteps ?? []),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        { error: 'Cannot activate automation with invalid configuration', issues },
        { status: 400 },
      )
    }
  }

  const { data, error } = await supabaseAdmin().rpc('create_automation_trees', {
    p_account_id: ctx.accountId,
    p_user_id: ctx.userId,
    p_automations: [{
      name: effectiveName,
      description: effectiveDescription ?? null,
      trigger_type: effectiveTriggerType,
      trigger_config: effectiveTriggerConfig ?? {},
      is_active: is_active ?? false,
      steps: flattenSteps(effectiveSteps ?? []),
    }],
  })
  const automation = data?.[0]
  if (error || !automation) {
    console.error('[POST /api/automations] insert failed:', error)
    return NextResponse.json({ error: 'Could not create the automation' }, { status: 500 })
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
