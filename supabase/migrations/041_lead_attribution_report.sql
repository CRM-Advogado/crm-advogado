-- ============================================================
-- 041_lead_attribution_report.sql — do clique ao caso, por criativo
--
-- A migration 040 passou a GRAVAR a origem do lead vinda do objeto
-- `referral` do Click-to-WhatsApp (ad_source_id, ad_source_url,
-- ad_headline, ctwa_clid). O dado ficava só na tabela: nenhuma tela,
-- API ou ferramenta devolvia. Esta migration fecha as duas pontas.
--
-- 1) ad_source_type
--
--    A Meta manda `referral.source_type` = 'ad' ou 'post'. Sem essa
--    coluna, um lead vindo de post orgânico compartilhado entrava no
--    relatório como se fosse anúncio pago e contaminava o custo por
--    caso. Guardar o tipo é o que permite separar os dois.
--
-- 2) lead_attribution_report()
--
--    Cliques e leads são números fáceis; o que decide investimento é
--    quantos leads de CADA criativo viraram caso. A função cruza
--    contacts.ad_source_id com deals.contact_id e devolve, por
--    anúncio: leads, leads que geraram negócio, negócios abertos,
--    ganhos e perdidos, e o valor ganho.
--
--    A linha com ad_source_id NULL é mantida de propósito: é a base
--    de comparação (indicação, orgânico, importação). Sem ela não dá
--    para saber se o anúncio converte melhor ou pior que o resto.
--
--    Sobre `won_value`: deals guarda `currency` por linha. Somar
--    moedas diferentes daria um número silenciosamente errado, então
--    a função devolve também `won_currencies` — se vier mais de uma
--    moeda no array, o total não deve ser lido como dinheiro.
--
-- Segurança
--
--   SECURITY INVOKER (padrão): a função roda como quem chama, então
--   a RLS de `contacts` e `deals` (associação à conta, migration 017)
--   limita o resultado. O `p_account_id` é filtrado explicitamente no
--   corpo porque o backend público chama com a chave de service role,
--   que ignora RLS — os dois controles se somam, nenhum depende do
--   outro. PUBLIC perde o EXECUTE que o Supabase concede por padrão
--   (mesma disciplina das migrations 025/037).
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tipo da origem (anúncio pago x post orgânico)
-- ------------------------------------------------------------

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_source_type TEXT;

COMMENT ON COLUMN contacts.ad_source_type IS
  'Tipo da origem do clique (referral.source_type): "ad" para anúncio pago, "post" para publicação orgânica. NULL em contato sem origem registrada.';


-- ------------------------------------------------------------
-- 2) Relatório: criativo -> lead -> caso
-- ------------------------------------------------------------

-- Assinatura antiga é removida antes do CREATE porque mudar o tipo
-- de retorno de uma função existente não é permitido pelo REPLACE.
DROP FUNCTION IF EXISTS public.lead_attribution_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION public.lead_attribution_report(
  p_account_id UUID,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to   TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  ad_source_id     TEXT,
  ad_source_type   TEXT,
  ad_headline      TEXT,
  ad_source_url    TEXT,
  leads            BIGINT,
  leads_with_deal  BIGINT,
  deals_total      BIGINT,
  deals_open       BIGINT,
  deals_won        BIGINT,
  deals_lost       BIGINT,
  won_value        NUMERIC,
  won_currencies   TEXT[],
  first_lead_at    TIMESTAMPTZ,
  last_lead_at     TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH janela AS (
    -- A data de referência do lead é o primeiro contato. Em contato
    -- antigo ou importado, `first_seen_at` é NULL (a coluna nasceu na
    -- 040), então caímos em `created_at` para não sumir com a linha.
    SELECT
      c.id,
      c.ad_source_id,
      c.ad_source_type,
      c.ad_headline,
      c.ad_source_url,
      COALESCE(c.first_seen_at, c.created_at) AS lead_at
    FROM contacts c
    WHERE c.account_id = p_account_id
  ),
  filtrada AS (
    SELECT *
    FROM janela
    WHERE (p_from IS NULL OR lead_at >= p_from)
      AND (p_to   IS NULL OR lead_at <  p_to)
  )
  SELECT
    f.ad_source_id,
    -- Um mesmo anúncio sempre traz o mesmo tipo/criativo; o max() é
    -- só o desempate exigido pelo GROUP BY.
    max(f.ad_source_type)                          AS ad_source_type,
    max(f.ad_headline)                             AS ad_headline,
    max(f.ad_source_url)                           AS ad_source_url,
    count(DISTINCT f.id)                           AS leads,
    count(DISTINCT f.id) FILTER (WHERE d.id IS NOT NULL) AS leads_with_deal,
    count(DISTINCT d.id)                           AS deals_total,
    count(DISTINCT d.id) FILTER (WHERE d.status = 'open') AS deals_open,
    count(DISTINCT d.id) FILTER (WHERE d.status = 'won')  AS deals_won,
    count(DISTINCT d.id) FILTER (WHERE d.status = 'lost') AS deals_lost,
    -- O LEFT JOIN não multiplica valor: cada negócio pertence a um
    -- único contato, então cada linha de `deals` aparece uma vez.
    COALESCE(sum(d.value) FILTER (WHERE d.status = 'won'), 0) AS won_value,
    COALESCE(
      array_agg(DISTINCT d.currency) FILTER (WHERE d.status = 'won' AND d.currency IS NOT NULL),
      '{}'::TEXT[]
    )                                              AS won_currencies,
    min(f.lead_at)                                 AS first_lead_at,
    max(f.lead_at)                                 AS last_lead_at
  FROM filtrada f
  LEFT JOIN deals d
    ON d.contact_id = f.id
   AND d.account_id = p_account_id
  GROUP BY f.ad_source_id
  -- Criativo que mais traz lead primeiro; empate desempata pelo id do
  -- anúncio, com a linha sem origem (NULL) no fim.
  ORDER BY count(DISTINCT f.id) DESC, f.ad_source_id ASC NULLS LAST;
$$;

COMMENT ON FUNCTION public.lead_attribution_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Leads e negócios agrupados por anúncio de origem (Click-to-WhatsApp). Janela opcional sobre o primeiro contato do lead: [p_from, p_to).';

ALTER FUNCTION public.lead_attribution_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lead_attribution_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lead_attribution_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

-- O relatório junta `deals` por (account_id, contact_id) e não havia
-- índice em contact_id — sem ele o LEFT JOIN vira varredura sequencial
-- da tabela inteira a cada consulta.
CREATE INDEX IF NOT EXISTS idx_deals_account_contact
  ON deals(account_id, contact_id);
