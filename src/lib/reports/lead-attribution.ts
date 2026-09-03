// ============================================================
// Relatório "do criativo ao caso" — carga e ordenação.
//
// A agregação pesada é do banco: `lead_attribution_report`
// (migration 041) junta contatos e negócios e devolve uma linha por
// anúncio de origem. Aqui só normalizamos os tipos que vêm da API
// REST, derivamos a taxa de conversão e ordenamos.
//
// Tudo abaixo de `loadLeadAttribution` é função pura — é o que os
// testes exercitam, sem banco.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** Uma linha do relatório, já normalizada para números de verdade. */
export interface LeadAttributionRow {
  /** Id do anúncio no Meta. `null` na linha de base (sem origem). */
  adSourceId: string | null
  /** 'ad' (pago) ou 'post' (orgânico); `null` na linha de base. */
  adSourceType: string | null
  adHeadline: string | null
  adSourceUrl: string | null
  leads: number
  /** Leads que geraram ao menos um negócio. */
  leadsWithDeal: number
  dealsTotal: number
  dealsOpen: number
  dealsWon: number
  dealsLost: number
  wonValue: number
  wonCurrencies: string[]
  firstLeadAt: string | null
  lastLeadAt: string | null
}

/**
 * Abaixo deste número de leads a taxa de conversão não significa
 * grande coisa — um lead que virou caso vira "100%" e encabeça
 * qualquer ordenação. A tela marca essas linhas em vez de escondê-las:
 * o dado é real, a leitura é que exige cautela.
 */
export const LOW_SAMPLE_THRESHOLD = 10

export type PeriodKey = '7d' | '30d' | '90d' | 'all'

export const PERIOD_KEYS: readonly PeriodKey[] = ['7d', '30d', '90d', 'all']

/**
 * Início da janela para um período, ou `null` para "tudo" (sem
 * recorte). O fim fica aberto: o relatório usa `[início, fim)` e o fim
 * só é passado quando existe.
 */
export function periodStart(period: PeriodKey, now: Date = new Date()): string | null {
  if (period === 'all') return null
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
  const start = new Date(now)
  start.setDate(start.getDate() - days)
  return start.toISOString()
}

/** Taxa de leads que viraram caso, em 0–100. Zero leads → 0. */
export function conversionRate(row: LeadAttributionRow): number {
  if (row.leads === 0) return 0
  return (row.leadsWithDeal / row.leads) * 100
}

export type SortKey =
  | 'leads'
  | 'cases'
  | 'conversion'
  | 'won'
  | 'value'
  | 'lastLead'

export interface SortState {
  key: SortKey
  direction: 'asc' | 'desc'
}

function sortValue(row: LeadAttributionRow, key: SortKey): number {
  switch (key) {
    case 'leads':
      return row.leads
    case 'cases':
      return row.leadsWithDeal
    case 'conversion':
      return conversionRate(row)
    case 'won':
      return row.dealsWon
    case 'value':
      return row.wonValue
    case 'lastLead':
      return row.lastLeadAt ? Date.parse(row.lastLeadAt) : 0
  }
}

/**
 * Ordena as linhas de criativo. Não recebe a linha de base (sem
 * origem) — ela não disputa ranking com anúncio, é o contraponto, e a
 * tela a renderiza fora do corpo da tabela.
 *
 * O desempate é sempre por volume de leads e depois pelo id do
 * anúncio, para a ordem não dançar entre duas renderizações quando
 * várias linhas empatam (o caso comum em conversão: vários 0%).
 */
export function sortRows(
  rows: LeadAttributionRow[],
  { key, direction }: SortState
): LeadAttributionRow[] {
  const factor = direction === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const delta = sortValue(a, key) - sortValue(b, key)
    if (delta !== 0) return delta * factor
    if (a.leads !== b.leads) return (a.leads - b.leads) * factor
    return (a.adSourceId ?? '').localeCompare(b.adSourceId ?? '')
  })
}

export interface AttributionTotals {
  leads: number
  leadsWithDeal: number
  dealsWon: number
  wonValue: number
  wonCurrencies: string[]
  conversion: number
}

/** Soma o conjunto de linhas recebido. Some a base ou não, à escolha
 *  de quem chama — a tela totaliza só os anúncios. */
export function totals(rows: LeadAttributionRow[]): AttributionTotals {
  const acc = rows.reduce(
    (sum, row) => {
      sum.leads += row.leads
      sum.leadsWithDeal += row.leadsWithDeal
      sum.dealsWon += row.dealsWon
      sum.wonValue += row.wonValue
      for (const currency of row.wonCurrencies) sum.currencies.add(currency)
      return sum
    },
    {
      leads: 0,
      leadsWithDeal: 0,
      dealsWon: 0,
      wonValue: 0,
      currencies: new Set<string>(),
    }
  )
  return {
    leads: acc.leads,
    leadsWithDeal: acc.leadsWithDeal,
    dealsWon: acc.dealsWon,
    wonValue: acc.wonValue,
    wonCurrencies: [...acc.currencies].sort(),
    conversion: acc.leads === 0 ? 0 : (acc.leadsWithDeal / acc.leads) * 100,
  }
}

/**
 * Moeda a usar para exibir `wonValue`. Uma só moeda no conjunto: é
 * ela. Nenhuma (nada ganho ainda): a moeda padrão da conta. Mais de
 * uma: `null` — somar moedas diferentes daria um número errado, e a
 * tela precisa dizer isso em vez de escondê-lo.
 */
export function displayCurrency(
  currencies: string[],
  accountDefault: string
): string | null {
  if (currencies.length === 0) return accountDefault
  if (currencies.length === 1) return currencies[0]
  return null
}

// Formato bruto devolvido pela função SQL via PostgREST. BIGINT chega
// como número; NUMERIC chega como string (não cabe garantidamente num
// number), por isso todo campo passa por Number().
interface RawRow {
  ad_source_id: string | null
  ad_source_type: string | null
  ad_headline: string | null
  ad_source_url: string | null
  leads: number | string
  leads_with_deal: number | string
  deals_total: number | string
  deals_open: number | string
  deals_won: number | string
  deals_lost: number | string
  won_value: number | string | null
  won_currencies: string[] | null
  first_lead_at: string | null
  last_lead_at: string | null
}

function normalize(raw: RawRow): LeadAttributionRow {
  return {
    adSourceId: raw.ad_source_id,
    adSourceType: raw.ad_source_type,
    adHeadline: raw.ad_headline,
    adSourceUrl: raw.ad_source_url,
    leads: Number(raw.leads),
    leadsWithDeal: Number(raw.leads_with_deal),
    dealsTotal: Number(raw.deals_total),
    dealsOpen: Number(raw.deals_open),
    dealsWon: Number(raw.deals_won),
    dealsLost: Number(raw.deals_lost),
    wonValue: Number(raw.won_value ?? 0),
    wonCurrencies: raw.won_currencies ?? [],
    firstLeadAt: raw.first_lead_at,
    lastLeadAt: raw.last_lead_at,
  }
}

/** Exportada para os testes normalizarem uma linha crua. */
export function normalizeRows(raw: unknown): LeadAttributionRow[] {
  if (!Array.isArray(raw)) return []
  return (raw as RawRow[]).map(normalize)
}

/**
 * Chama a função do banco. `p_account_id` é filtrado dentro dela e a
 * RLS de `contacts`/`deals` também vale (a função é SECURITY INVOKER),
 * então uma conta nunca vê a outra nem por engano de parâmetro.
 */
export async function loadLeadAttribution(
  db: SupabaseClient,
  accountId: string,
  period: PeriodKey,
  now: Date = new Date()
): Promise<LeadAttributionRow[]> {
  const { data, error } = await db.rpc('lead_attribution_report', {
    p_account_id: accountId,
    p_from: periodStart(period, now),
    p_to: null,
  })
  if (error) throw error
  return normalizeRows(data)
}
