// ============================================================
// GET /api/v1/reports/lead-attribution — leads e casos por criativo
//                                        (scope: contacts:read)
//
// Responde a pergunta que o número de cliques não responde: de qual
// anúncio veio o lead que virou caso. Agrupa os contatos pela origem
// gravada na primeira mensagem (`referral.source_id` do
// Click-to-WhatsApp) e cruza com os negócios do pipeline.
//
// A conta pesada é do banco — a função `lead_attribution_report`
// (migration 041) faz junção, filtro e agregação em uma consulta só.
// Esta rota valida a janela de datas, chama a função e devolve.
//
// Query params (todos opcionais):
//   from  — ISO 8601. Início da janela, INCLUSIVO, sobre o primeiro
//           contato do lead.
//   to    — ISO 8601. Fim da janela, EXCLUSIVO.
//
// A resposta não é paginada: uma linha por anúncio (mais a linha de
// `ad_source_id: null`, que é a base sem origem). Uma operação tem
// dezenas de criativos, não milhares.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

/**
 * Parse an optional ISO date param. Returns `undefined` when absent
 * and `null` when present but unparseable — the caller turns the
 * latter into a 400 instead of silently ignoring a typo'd window and
 * reporting on all time.
 */
function parseDateParam(raw: string | null): string | null | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

interface ReportRow {
  ad_source_id: string | null;
  ad_source_type: string | null;
  ad_headline: string | null;
  ad_source_url: string | null;
  leads: number;
  leads_with_deal: number;
  deals_total: number;
  deals_open: number;
  deals_won: number;
  deals_lost: number;
  won_value: number | string;
  won_currencies: string[] | null;
  first_lead_at: string | null;
  last_lead_at: string | null;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const url = new URL(request.url);

    const from = parseDateParam(url.searchParams.get('from'));
    if (from === null) {
      return fail('bad_request', "'from' must be an ISO 8601 date", 400);
    }
    const to = parseDateParam(url.searchParams.get('to'));
    if (to === null) {
      return fail('bad_request', "'to' must be an ISO 8601 date", 400);
    }
    if (from && to && from >= to) {
      return fail('bad_request', "'from' must be earlier than 'to'", 400);
    }

    // The function is SECURITY INVOKER and this client is service-role
    // (RLS-bypassing), so `p_account_id` is what scopes the result to
    // the key's account — the same discipline every other v1 route
    // follows with its explicit `.eq('account_id', …)`.
    const { data, error } = await ctx.supabase.rpc('lead_attribution_report', {
      p_account_id: ctx.accountId,
      p_from: from ?? null,
      p_to: to ?? null,
    });

    if (error) {
      console.error('[api/v1/reports/lead-attribution] rpc error:', error);
      return fail('internal', 'Failed to build the attribution report', 500);
    }

    const rows = (data ?? []) as ReportRow[];

    return ok({
      window: { from: from ?? null, to: to ?? null },
      rows: rows.map((r) => {
        const currencies = r.won_currencies ?? [];
        return {
          ad_source_id: r.ad_source_id,
          ad_source_type: r.ad_source_type,
          ad_headline: r.ad_headline,
          ad_source_url: r.ad_source_url,
          leads: Number(r.leads),
          leads_with_deal: Number(r.leads_with_deal),
          deals_total: Number(r.deals_total),
          deals_open: Number(r.deals_open),
          deals_won: Number(r.deals_won),
          deals_lost: Number(r.deals_lost),
          // NUMERIC arrives as a string from PostgREST (it exceeds the
          // range JS numbers represent exactly); Number() here keeps
          // the wire type consistent with the counters above.
          won_value: Number(r.won_value ?? 0),
          won_currencies: currencies,
          // Deals can carry different currencies. Summing across them
          // would produce a silently wrong total, so we flag it rather
          // than hide it: when true, read `won_value` as a count, not
          // as money.
          won_value_mixed_currency: currencies.length > 1,
          first_lead_at: r.first_lead_at,
          last_lead_at: r.last_lead_at,
        };
      }),
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
