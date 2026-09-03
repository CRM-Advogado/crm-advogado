-- ============================================================
-- 044_zapsign_integration.sql — Assinatura eletrônica (ZapSign)
--
-- PROBLEMA QUE ESTA MIGRATION RESOLVE
--
-- O funil tem uma etapa "Contrato Assinado" desde sempre, mas nada a
-- alimenta: nenhuma automação sabe gerar um contrato, mandar pro lead
-- assinar, nem saber quando ele assinou. Esta migration instala as duas
-- tabelas que faltam para o motor de automações (`src/lib/automations/
-- engine.ts`) ganhar um passo `send_signature_request` (gera o
-- documento no ZapSign a partir de um modelo e manda o link por
-- WhatsApp) e um gatilho `document_signed` (reage quando o ZapSign
-- avisa, via webhook, que o documento voltou assinado).
--
--   1. `zapsign_credentials` — token de API por conta (bring-your-own-
--      key, mesmo desenho de `ai_configs` da 029) + o segredo do
--      webhook de entrada.
--   2. `zapsign_documents` — um documento enviado para assinatura por
--      linha; é o que liga o token do ZapSign de volta ao contato/
--      negócio da conta quando o webhook chega.
--
-- Por que o segredo do webhook é GUARDADO COMO HASH, não como texto
-- puro: a ZapSign não documenta assinatura HMAC nos webhooks (ao
-- contrário do Meta, que assina com `x-hub-signature-256`). A única
-- forma de autenticar a requisição de entrada é um segredo opaco na
-- própria URL (`/api/webhooks/zapsign/<secret>`). Guardá-lo em texto
-- puro no banco faria de qualquer leitura da tabela — um dump, uma
-- query mal filtrada — uma forma de forjar eventos de assinatura. O
-- mesmo raciocínio já vale para `api_keys.key_hash` (migration 026):
-- SHA-256 é a escolha certa para um segredo de alta entropia (não uma
-- senha escolhida por humano), porque não há dicionário a atacar e um
-- hash rápido com índice único é o que permite achar a conta pelo
-- segredo em O(1) sem guardar o segredo em si.
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

-- ============================================================
-- PARTE 1 — Credenciais da conta
-- ============================================================

CREATE TABLE IF NOT EXISTS zapsign_credentials (
  account_id         UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  created_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- AES-256-GCM-encrypted, mesmo par encrypt()/decrypt() de
  -- src/lib/whatsapp/encryption.ts que já guarda whatsapp_config.access_token
  -- e ai_configs.api_key. Nunca devolvido em texto puro pela API — a UI
  -- só recebe um flag has_token.
  api_token          TEXT NOT NULL,

  -- true = usa o host sandbox.api.zapsign.com.br (token de teste,
  -- separado do de produção). A ZapSign não tem um campo "sandbox" no
  -- corpo da requisição — é host + token diferentes, então esta coluna
  -- decide qual base URL o cliente HTTP usa.
  sandbox             BOOLEAN NOT NULL DEFAULT false,

  -- SHA-256 do segredo que compõe a URL do webhook de entrada. Ver nota
  -- de idempotência acima sobre por que é hash e não texto puro. NULL
  -- até a primeira geração (a conta pode salvar o token sem ainda ter
  -- gerado a URL do webhook).
  webhook_secret_hash TEXT UNIQUE,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE zapsign_credentials ENABLE ROW LEVEL SECURITY;

-- SELECT: qualquer membro (viewer+) — o construtor de automação precisa
-- saber se a integração está configurada para habilitar o passo
-- send_signature_request, mesmo sem poder editar a credencial.
DROP POLICY IF EXISTS zapsign_credentials_select ON zapsign_credentials;
CREATE POLICY zapsign_credentials_select ON zapsign_credentials FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ apenas (settings-class, igual ai_configs).
DROP POLICY IF EXISTS zapsign_credentials_insert ON zapsign_credentials;
CREATE POLICY zapsign_credentials_insert ON zapsign_credentials FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS zapsign_credentials_update ON zapsign_credentials;
CREATE POLICY zapsign_credentials_update ON zapsign_credentials FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS zapsign_credentials_delete ON zapsign_credentials;
CREATE POLICY zapsign_credentials_delete ON zapsign_credentials FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_zapsign_credentials_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zapsign_credentials_updated_at ON zapsign_credentials;
CREATE TRIGGER zapsign_credentials_updated_at
  BEFORE UPDATE ON zapsign_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.update_zapsign_credentials_updated_at();


-- ============================================================
-- PARTE 2 — Documentos enviados para assinatura
-- ============================================================

CREATE TABLE IF NOT EXISTS zapsign_documents (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Negócio associado, quando o passo rodou dentro de um gatilho de
  -- funil (contexto trazido pela migration 042). NULL quando a
  -- automação não tinha negócio no contexto — o documento ainda existe
  -- e ainda dispara document_signed, só não referencia um negócio.
  deal_id        UUID REFERENCES deals(id) ON DELETE SET NULL,
  automation_id  UUID REFERENCES automations(id) ON DELETE SET NULL,

  -- Token do DOCUMENTO no ZapSign (não o do modelo). Único por conta —
  -- é a chave que o webhook usa para achar esta linha.
  --
  -- NULÁVEL de propósito. A linha nasce ANTES da chamada ao ZapSign,
  -- justamente para existir quando a chamada não devolve resposta: um
  -- timeout depois de o ZapSign ter processado criava um documento lá
  -- que não existia aqui, e o webhook dele caía em "documento
  -- desconhecido". Com a linha já gravada, o `id` dela viaja na
  -- requisição como `external_id`, volta no corpo do webhook, e o aviso
  -- casa mesmo sem nunca termos recebido o token. Token NULL significa
  -- exatamente isto: "mandamos, e não sabemos se chegou".
  --
  -- O índice único abaixo continua valendo: no Postgres NULLs não
  -- conflitam entre si, então várias linhas em dúvida convivem.
  zapsign_token    TEXT,
  template_token   TEXT NOT NULL,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'signed', 'refused')),
  sign_url         TEXT,
  signed_at        TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reparo para bancos onde uma versão anterior desta migration já rodou
-- com `zapsign_token NOT NULL`. `CREATE TABLE IF NOT EXISTS` não volta
-- para alterar coluna de tabela existente, então a mudança precisa vir
-- explícita — e escrita de um jeito que não faça nada quando a tabela
-- já nasceu certa.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'zapsign_documents'
      AND column_name = 'zapsign_token'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE zapsign_documents ALTER COLUMN zapsign_token DROP NOT NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_zapsign_documents_account_token
  ON zapsign_documents(account_id, zapsign_token);

CREATE INDEX IF NOT EXISTS idx_zapsign_documents_contact
  ON zapsign_documents(contact_id, created_at DESC);

COMMENT ON TABLE zapsign_documents IS
  'Um documento enviado para assinatura por linha. Escrito pelo passo send_signature_request (status pending) e atualizado pelo webhook de entrada quando a ZapSign avisa doc_signed.';
COMMENT ON COLUMN zapsign_documents.zapsign_token IS
  'Token do DOCUMENTO (não do modelo) devolvido por POST /api/v1/models/create-doc/. É o que o webhook manda de volta para casar o evento com esta linha. NULL enquanto a criação não foi confirmada — ver o id, que viaja como external_id e serve de chave reserva.';
COMMENT ON COLUMN zapsign_documents.id IS
  'Enviado ao ZapSign como external_id na criação do documento e devolvido no corpo do webhook. É a chave que permite reencontrar a linha quando a resposta da criação se perdeu.';

ALTER TABLE zapsign_documents ENABLE ROW LEVEL SECURITY;

-- Só leitura pela API — a escrita é exclusiva do service-role (motor de
-- automações no envio, rota de webhook na confirmação), mesmo padrão de
-- deal_stage_events / automation_stalled_dispatches (migration 042):
-- nenhuma política de INSERT/UPDATE/DELETE para o papel authenticated.
DROP POLICY IF EXISTS zapsign_documents_select ON zapsign_documents;
CREATE POLICY zapsign_documents_select ON zapsign_documents FOR SELECT
  USING (is_account_member(account_id));
