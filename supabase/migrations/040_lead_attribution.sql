-- ============================================================
-- 040_lead_attribution.sql — Origem do lead (Click-to-WhatsApp)
--
-- Quando a conversa nasce de um anúncio Click-to-WhatsApp, a Meta
-- envia um objeto `referral` junto da PRIMEIRA mensagem, com o
-- identificador do anúncio, o criativo e o `ctwa_clid`. Hoje o
-- webhook do wacrm descarta esse objeto inteiro.
--
-- Estas colunas guardam a origem para permitir:
--   1. custo por lead qualificado POR CRIATIVO;
--   2. no futuro, devolver o evento de conversão à Meta pela API
--      de Conversões, usando o ctwa_clid como chave.
--
-- Política de atribuição: PRIMEIRO TOQUE. Uma vez gravada, a
-- origem não é sobrescrita — se a pessoa clicar em outro anúncio
-- meses depois, ela continua sendo lead do anúncio que a trouxe.
-- A trava está no código do webhook (.is('ad_source_id', null)).
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_source_id  TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_source_url TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_headline   TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ctwa_clid     TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN contacts.ad_source_id  IS 'ID do anúncio de origem (referral.source_id do webhook da Meta).';
COMMENT ON COLUMN contacts.ad_source_url IS 'URL de origem do clique (referral.source_url).';
COMMENT ON COLUMN contacts.ad_headline   IS 'Título do criativo que gerou o lead (referral.headline).';
COMMENT ON COLUMN contacts.ctwa_clid     IS 'Identificador de clique do Click-to-WhatsApp. Chave para a API de Conversões da Meta.';
COMMENT ON COLUMN contacts.first_seen_at IS 'Primeiro contato do lead. Distinto de created_at, que pode vir de importação.';

-- Relatório "leads por criativo" varre por conta + anúncio.
CREATE INDEX IF NOT EXISTS idx_contacts_ad_source
  ON contacts(account_id, ad_source_id)
  WHERE ad_source_id IS NOT NULL;
