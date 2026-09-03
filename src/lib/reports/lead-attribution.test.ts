import { describe, it, expect } from 'vitest'

import {
  conversionRate,
  displayCurrency,
  normalizeRows,
  periodStart,
  sortRows,
  totals,
  type LeadAttributionRow,
} from './lead-attribution'

function row(over: Partial<LeadAttributionRow> = {}): LeadAttributionRow {
  return {
    adSourceId: 'AD',
    adSourceType: 'ad',
    adHeadline: null,
    adSourceUrl: null,
    leads: 0,
    leadsWithDeal: 0,
    dealsTotal: 0,
    dealsOpen: 0,
    dealsWon: 0,
    dealsLost: 0,
    wonValue: 0,
    wonCurrencies: [],
    firstLeadAt: null,
    lastLeadAt: null,
    ...over,
  }
}

describe('normalizeRows', () => {
  it('coerces the NUMERIC that PostgREST sends as a string', () => {
    const [r] = normalizeRows([
      {
        ad_source_id: 'AD_BPC',
        ad_source_type: 'ad',
        ad_headline: 'BPC negado?',
        ad_source_url: null,
        leads: 12,
        leads_with_deal: 3,
        deals_total: 4,
        deals_open: 1,
        deals_won: 2,
        deals_lost: 1,
        won_value: '5400.00',
        won_currencies: ['BRL'],
        first_lead_at: '2026-08-01T00:00:00Z',
        last_lead_at: '2026-08-10T00:00:00Z',
      },
    ])
    expect(r.wonValue).toBe(5400)
    expect(typeof r.wonValue).toBe('number')
    expect(r.leadsWithDeal).toBe(3)
  })

  it('survives a null won_currencies and a non-array payload', () => {
    const [r] = normalizeRows([
      {
        ad_source_id: null,
        ad_source_type: null,
        ad_headline: null,
        ad_source_url: null,
        leads: 1,
        leads_with_deal: 0,
        deals_total: 0,
        deals_open: 0,
        deals_won: 0,
        deals_lost: 0,
        won_value: null,
        won_currencies: null,
        first_lead_at: null,
        last_lead_at: null,
      },
    ])
    expect(r.wonCurrencies).toEqual([])
    expect(r.wonValue).toBe(0)
    expect(normalizeRows(null)).toEqual([])
  })
})

describe('conversionRate', () => {
  it('is leads-with-deal over leads, in percent', () => {
    expect(conversionRate(row({ leads: 40, leadsWithDeal: 10 }))).toBe(25)
  })

  it('does not divide by zero when a creative has no leads', () => {
    expect(conversionRate(row({ leads: 0, leadsWithDeal: 0 }))).toBe(0)
  })
})

describe('sortRows', () => {
  const a = row({ adSourceId: 'A', leads: 100, leadsWithDeal: 10, dealsWon: 8 }) // 10%
  const b = row({ adSourceId: 'B', leads: 10, leadsWithDeal: 3, dealsWon: 1 }) //  30%
  const c = row({ adSourceId: 'C', leads: 50, leadsWithDeal: 5, dealsWon: 4 }) //  10%

  it('ranks by cases, which is the volume-robust reading', () => {
    expect(
      sortRows([b, c, a], { key: 'cases', direction: 'desc' }).map((r) => r.adSourceId)
    ).toEqual(['A', 'C', 'B'])
  })

  it('ranks by conversion when asked', () => {
    expect(
      sortRows([a, b, c], { key: 'conversion', direction: 'desc' }).map((r) => r.adSourceId)
    ).toEqual(['B', 'A', 'C'])
  })

  it('breaks conversion ties by lead volume, so equal rates keep a stable order', () => {
    // A and C both convert at 10%; A has more leads, so it leads.
    const ranked = sortRows([c, a], { key: 'conversion', direction: 'desc' })
    expect(ranked.map((r) => r.adSourceId)).toEqual(['A', 'C'])
  })

  it('does not mutate the array it was given', () => {
    const input = [b, a]
    sortRows(input, { key: 'leads', direction: 'desc' })
    expect(input.map((r) => r.adSourceId)).toEqual(['B', 'A'])
  })
})

describe('totals', () => {
  it('recomputes conversion over the summed leads, not by averaging rates', () => {
    // Averaging the two rates would give 20%; the honest figure is 13/110.
    const sum = totals([
      row({ leads: 100, leadsWithDeal: 10, dealsWon: 8, wonValue: 8000, wonCurrencies: ['BRL'] }),
      row({ leads: 10, leadsWithDeal: 3, dealsWon: 1, wonValue: 1000, wonCurrencies: ['BRL'] }),
    ])
    expect(sum.leads).toBe(110)
    expect(sum.leadsWithDeal).toBe(13)
    expect(sum.wonValue).toBe(9000)
    expect(sum.conversion).toBeCloseTo(11.818, 2)
  })

  it('collects every currency present so mixed sums can be flagged', () => {
    const sum = totals([
      row({ wonCurrencies: ['BRL'] }),
      row({ wonCurrencies: ['USD', 'BRL'] }),
    ])
    expect(sum.wonCurrencies).toEqual(['BRL', 'USD'])
  })
})

describe('displayCurrency', () => {
  it('uses the only currency present', () => {
    expect(displayCurrency(['BRL'], 'USD')).toBe('BRL')
  })

  it('falls back to the account default when nothing was won yet', () => {
    expect(displayCurrency([], 'BRL')).toBe('BRL')
  })

  it('refuses to pick one when the row mixes currencies', () => {
    expect(displayCurrency(['BRL', 'USD'], 'BRL')).toBeNull()
  })
})

describe('periodStart', () => {
  const now = new Date('2026-08-21T12:00:00.000Z')

  it('walks back the requested number of days', () => {
    expect(periodStart('7d', now)).toBe('2026-08-14T12:00:00.000Z')
    expect(periodStart('30d', now)).toBe('2026-07-22T12:00:00.000Z')
  })

  it('returns null for "all", which the SQL reads as no lower bound', () => {
    expect(periodStart('all', now)).toBeNull()
  })
})
