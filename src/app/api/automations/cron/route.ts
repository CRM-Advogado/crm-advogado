import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution, runAutomationsForTrigger } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  const stalled = await scanStalledDeals(admin)

  return NextResponse.json({ processed, ...stalled })
}

/**
 * Varredura do gatilho `deal_stalled`.
 *
 * Os outros gatilhos nascem de um evento — chega uma mensagem, alguém
 * põe uma etiqueta. Inatividade é o contrário: é a AUSÊNCIA de evento,
 * e ausência não notifica ninguém. A única forma de percebê-la é
 * alguém perguntar periodicamente, que é o que esta função faz.
 *
 * Consequência prática: sem o cron rodando, este gatilho nunca dispara.
 * Não falha, não avisa — simplesmente nunca acontece.
 */
/**
 * Orçamento de tempo da varredura.
 *
 * A varredura é ilimitada por natureza: N automações ativas × até 200
 * negócios cada × uma execução completa de automação por negócio, que
 * pode incluir um `send_webhook` com 10s de espera. Sem teto, uma
 * conta com poucas automações de inatividade e muitos negócios parados
 * estoura o limite de duração da função e é morta no meio.
 *
 * Ser morto no meio não corrompe nada — `claim_stalled_dispatch`
 * reserva cada negócio ANTES de disparar, então nada é avisado duas
 * vezes. Mas o corte fica invisível. Parar por conta própria dentro do
 * orçamento troca uma morte silenciosa por uma parada declarada, com
 * `stalled_truncated: true` na resposta; a rodada seguinte continua de
 * onde esta parou, porque quem já foi avisado não volta à fila.
 */
const SCAN_BUDGET_MS = 45_000

async function scanStalledDeals(
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<{
  stalled_scanned: number
  stalled_dispatched: number
  stalled_truncated: boolean
}> {
  const deadline = Date.now() + SCAN_BUDGET_MS
  let scanned = 0
  let dispatched = 0
  let truncated = false

  const { data: automations, error } = await admin
    .from('automations')
    .select('id, account_id, trigger_config')
    .eq('trigger_type', 'deal_stalled')
    .eq('is_active', true)

  if (error) {
    console.error('[automations] stalled scan: fetch failed', error)
    return { stalled_scanned: 0, stalled_dispatched: 0, stalled_truncated: false }
  }
  if (!automations || automations.length === 0) {
    return { stalled_scanned: 0, stalled_dispatched: 0, stalled_truncated: false }
  }

  for (const automation of automations) {
    if (Date.now() >= deadline) {
      truncated = true
      break
    }
    const cfg = (automation.trigger_config ?? {}) as {
      stage_id?: string
      days?: number
    }
    // O validador já barra isto na ativação; a conferência aqui cobre
    // linhas gravadas antes da validação existir ou por escrita direta
    // no banco.
    if (!cfg.stage_id || typeof cfg.days !== 'number' || cfg.days <= 0) continue

    const cutoff = new Date(Date.now() - cfg.days * 86_400_000).toISOString()

    const { data: deals, error: rpcErr } = await admin.rpc('find_stalled_deals', {
      p_account_id: automation.account_id,
      p_stage_id: cfg.stage_id,
      p_older_than: cutoff,
      p_limit: 200,
    })

    if (rpcErr) {
      console.error('[automations] stalled scan: rpc failed', automation.id, rpcErr)
      continue
    }
    if (!deals || deals.length === 0) continue

    for (const deal of deals as {
      deal_id: string
      contact_id: string | null
      pipeline_id: string
      stage_id: string
      practice_area: string | null
      stage_entered_at: string
    }[]) {
      // Conferido a cada negócio, e não só a cada automação: uma
      // única automação com 200 negócios parados já basta para
      // estourar o orçamento sozinha.
      if (Date.now() >= deadline) {
        truncated = true
        break
      }
      scanned++

      // Reserva atômica. Duas rodadas do cron sobrepostas não avisam
      // duas vezes sobre o mesmo negócio — quem perde a corrida
      // recebe FALSE e segue.
      const { data: claimed, error: claimErr } = await admin.rpc(
        'claim_stalled_dispatch',
        {
          p_automation_id: automation.id,
          p_deal_id: deal.deal_id,
          p_stage_id: deal.stage_id,
        },
      )
      if (claimErr) {
        console.error('[automations] stalled claim failed', deal.deal_id, claimErr)
        continue
      }
      if (claimed !== true) continue

      const daysStalled = Math.floor(
        (Date.now() - new Date(deal.stage_entered_at).getTime()) / 86_400_000,
      )

      await runAutomationsForTrigger({
        accountId: automation.account_id as string,
        triggerType: 'deal_stalled',
        contactId: deal.contact_id,
        context: {
          deal_id: deal.deal_id,
          pipeline_id: deal.pipeline_id,
          // `to_stage_id` e não um campo próprio: para todo passo que
          // consome o contexto, a etapa "de destino" é onde o negócio
          // está agora. É também o que `triggerMatches` confere.
          to_stage_id: deal.stage_id,
          practice_area: deal.practice_area ?? undefined,
          stalled_days: daysStalled,
        },
      })
      dispatched++
    }
  }

  if (truncated) {
    console.warn('[automations] stalled scan hit its time budget', {
      scanned,
      dispatched,
      budgetMs: SCAN_BUDGET_MS,
    })
  }

  return {
    stalled_scanned: scanned,
    stalled_dispatched: dispatched,
    stalled_truncated: truncated,
  }
}
