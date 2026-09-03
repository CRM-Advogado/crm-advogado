"use client"

// ============================================================
// Relatórios → Origem dos leads.
//
// Responde a pergunta que cliques e custo por lead não respondem:
// qual criativo traz lead que vira caso. Uma linha por anúncio, o
// período no topo, e a ordenação em qualquer coluna numérica.
//
// A conta é toda do banco (`lead_attribution_report`, migration 041);
// esta tela chama a função, ordena e desenha. A RLS de contatos e
// negócios já limita o resultado à conta do usuário — a função é
// SECURITY INVOKER —, então não há filtro de tenancy a duplicar aqui.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, ArrowDown, ArrowUp, ExternalLink, Megaphone } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import { cn } from '@/lib/utils'
import {
  LOW_SAMPLE_THRESHOLD,
  PERIOD_KEYS,
  conversionRate,
  displayCurrency,
  loadLeadAttribution,
  sortRows,
  totals,
  type LeadAttributionRow,
  type PeriodKey,
  type SortKey,
  type SortState,
} from '@/lib/reports/lead-attribution'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

/** Colunas ordenáveis, na ordem em que aparecem. */
const COLUMNS: { key: SortKey; labelKey: string }[] = [
  { key: 'leads', labelKey: 'colLeads' },
  { key: 'cases', labelKey: 'colCases' },
  { key: 'conversion', labelKey: 'colConversion' },
  { key: 'won', labelKey: 'colWon' },
  { key: 'value', labelKey: 'colValue' },
  { key: 'lastLead', labelKey: 'colLastLead' },
]

export default function ReportsPage() {
  const t = useTranslations('Reports.leadAttribution')
  const { accountId, defaultCurrency } = useAuth()

  const [period, setPeriod] = useState<PeriodKey>('30d')
  const [rows, setRows] = useState<LeadAttributionRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Casos primeiro: é a leitura que sobrevive a volume baixo. Conversão
  // sozinha coroa o criativo de 1 lead e 1 caso.
  const [sort, setSort] = useState<SortState>({ key: 'cases', direction: 'desc' })

  // Bumped to force a refetch with the same period (o botão de tentar
  // de novo). Fica no vetor de dependências do efeito abaixo.
  const [reloadToken, setReloadToken] = useState(0)

  // O efeito não chama setState de forma síncrona — quem liga o
  // "carregando" é o clique que provoca a troca. Além de satisfazer a
  // regra do React, a flag `cancelled` evita que uma resposta lenta de
  // um período já abandonado sobrescreva a do período atual.
  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    loadLeadAttribution(createClient(), accountId, period)
      .then((result) => {
        if (cancelled) return
        setRows(result)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[reports] lead attribution failed:', err)
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId, period, reloadToken])

  const changePeriod = useCallback(
    (next: PeriodKey) => {
      if (next === period) return
      setLoading(true)
      setPeriod(next)
    },
    [period]
  )

  const retry = useCallback(() => {
    setLoading(true)
    setReloadToken((n) => n + 1)
  }, [])

  // A linha sem `adSourceId` é a base de comparação — orgânico,
  // indicação, importação. Fica fora do ranking (não é criativo) e
  // aparece no rodapé, ao lado do total dos anúncios.
  const { ads, baseline } = useMemo(() => {
    const all = rows ?? []
    return {
      ads: all.filter((r) => r.adSourceId !== null),
      baseline: all.find((r) => r.adSourceId === null) ?? null,
    }
  }, [rows])

  const sorted = useMemo(() => sortRows(ads, sort), [ads, sort])
  const summary = useMemo(() => totals(ads), [ads])

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === 'desc' ? 'asc' : 'desc' }
        : // Coluna nova começa decrescente: em toda métrica daqui,
          // "mais" é a informação que se procura primeiro.
          { key, direction: 'desc' }
    )
  }, [])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <section className="rounded-xl border border-border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t('tableTitle')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('tableHint')}</p>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {PERIOD_KEYS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => changePeriod(p)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  period === p
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t(`period.${p}`)}
              </button>
            ))}
          </div>
        </header>

        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : error ? (
          <div className="p-5">
            <p className="text-sm text-red-400">{t('loadFailed')}</p>
            <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              {t('retry')}
            </button>
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState t={t} hasBaseline={!!baseline} baselineLeads={baseline?.leads ?? 0} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[220px]">{t('colCreative')}</TableHead>
                {COLUMNS.map((col) => (
                  <TableHead
                    key={col.key}
                    className="text-right"
                    // aria-sort pertence à célula de cabeçalho, não ao
                    // botão dentro dela — leitores de tela procuram o
                    // atributo no columnheader.
                    aria-sort={
                      sort.key === col.key
                        ? sort.direction === 'desc'
                          ? 'descending'
                          : 'ascending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={cn(
                        'inline-flex items-center gap-1 transition-colors',
                        sort.key === col.key
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t(col.labelKey)}
                      {sort.key === col.key ? (
                        sort.direction === 'desc' ? (
                          <ArrowDown className="size-3" aria-hidden />
                        ) : (
                          <ArrowUp className="size-3" aria-hidden />
                        )
                      ) : null}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>

            <TableBody>
              {sorted.map((row) => (
                <AdRow
                  key={row.adSourceId}
                  row={row}
                  t={t}
                  defaultCurrency={defaultCurrency}
                />
              ))}
            </TableBody>

            <TableFooter>
              <TableRow>
                <TableCell className="font-medium">{t('totalAds')}</TableCell>
                <TableCell className="text-right tabular-nums">{summary.leads}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {summary.leadsWithDeal}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {summary.conversion.toFixed(1)}%
                </TableCell>
                <TableCell className="text-right tabular-nums">{summary.dealsWon}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <Money
                    value={summary.wonValue}
                    currencies={summary.wonCurrencies}
                    fallback={defaultCurrency}
                    mixedLabel={t('mixedCurrency')}
                  />
                </TableCell>
                <TableCell />
              </TableRow>

              {baseline ? (
                <TableRow className="text-muted-foreground">
                  <TableCell className="font-normal">
                    {t('baseline')}
                    <span className="mt-0.5 block text-xs">{t('baselineHint')}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{baseline.leads}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {baseline.leadsWithDeal}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {conversionRate(baseline).toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{baseline.dealsWon}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Money
                      value={baseline.wonValue}
                      currencies={baseline.wonCurrencies}
                      fallback={defaultCurrency}
                      mixedLabel={t('mixedCurrency')}
                    />
                  </TableCell>
                  <TableCell />
                </TableRow>
              ) : null}
            </TableFooter>
          </Table>
        )}
      </section>

      <p className="text-xs leading-relaxed text-muted-foreground">{t('spendNote')}</p>
    </div>
  )
}

function AdRow({
  row,
  t,
  defaultCurrency,
}: {
  row: LeadAttributionRow
  t: ReturnType<typeof useTranslations>
  defaultCurrency: string
}) {
  const rate = conversionRate(row)
  const lowSample = row.leads < LOW_SAMPLE_THRESHOLD

  return (
    <TableRow>
      <TableCell className="max-w-[320px] whitespace-normal">
        <div className="flex items-start gap-2">
          <Megaphone className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {row.adHeadline || t('untitledCreative')}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 font-mono text-xs break-all text-muted-foreground">
              {row.adSourceId}
              {row.adSourceUrl ? (
                <a
                  href={row.adSourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('openSource')}
                  className="text-primary hover:underline"
                >
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </p>
            {/* Post orgânico compartilhado chega pelo mesmo `referral`
                dos anúncios. Marcar evita ler tráfego gratuito como
                resultado de campanha paga. */}
            {row.adSourceType === 'post' ? (
              <Badge variant="secondary" className="mt-1 h-4 px-1.5 text-[10px]">
                {t('organicPost')}
              </Badge>
            ) : null}
          </div>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.leads}</TableCell>
      <TableCell className="text-right font-medium tabular-nums">{row.leadsWithDeal}</TableCell>
      <TableCell
        className={cn(
          'text-right tabular-nums',
          lowSample && 'text-muted-foreground'
        )}
        title={lowSample ? t('lowSample', { threshold: LOW_SAMPLE_THRESHOLD }) : undefined}
      >
        {rate.toFixed(1)}%{lowSample ? ' *' : ''}
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.dealsWon}</TableCell>
      <TableCell className="text-right tabular-nums">
        <Money
          value={row.wonValue}
          currencies={row.wonCurrencies}
          fallback={defaultCurrency}
          mixedLabel={t('mixedCurrency')}
        />
      </TableCell>
      <TableCell className="text-right text-muted-foreground tabular-nums">
        {row.lastLeadAt ? new Date(row.lastLeadAt).toLocaleDateString() : '—'}
      </TableCell>
    </TableRow>
  )
}

/**
 * Valor ganho. Quando a linha mistura moedas não existe total honesto,
 * então mostramos o número cru com um alerta em vez de carimbar um
 * símbolo qualquer e fingir que a soma significa dinheiro.
 */
function Money({
  value,
  currencies,
  fallback,
  mixedLabel,
}: {
  value: number
  currencies: string[]
  fallback: string
  mixedLabel: string
}) {
  const currency = displayCurrency(currencies, fallback)
  if (currency) return <>{formatCurrency(value, currency)}</>
  return (
    <span className="inline-flex items-center gap-1" title={`${mixedLabel} (${currencies.join(', ')})`}>
      <AlertTriangle className="size-3 text-amber-400" aria-hidden />
      {value.toLocaleString()}
    </span>
  )
}

function EmptyState({
  t,
  hasBaseline,
  baselineLeads,
}: {
  t: ReturnType<typeof useTranslations>
  hasBaseline: boolean
  baselineLeads: number
}) {
  return (
    <div className="px-5 py-12 text-center">
      <Megaphone className="mx-auto size-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium text-foreground">{t('emptyTitle')}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        {hasBaseline
          ? t('emptyWithBaseline', { count: baselineLeads })
          : t('emptyNoLeads')}
      </p>
    </div>
  )
}
