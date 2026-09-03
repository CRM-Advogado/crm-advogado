-- ============================================================
-- 042_deal_stage_automation.sql — Movimentação automática de etapa
--
-- PROBLEMA QUE ESTA MIGRATION RESOLVE
--
-- Até aqui o funil era um destino sem sensor. O motor de automações
-- sabia CRIAR um negócio (`create_deal`) e nunca mais o tocava; e
-- nenhum gatilho enxergava o funil, então nada podia reagir quando um
-- negócio andava. Pior: o arrastar-e-soltar do quadro escreve
-- `deals.stage_id` direto do navegador, sem passar por servidor —
-- logo nem sequer havia um lugar onde pendurar a reação.
--
-- Esta migration instala as três peças que faltavam no BANCO:
--
--   1. `deals.stage_entered_at` — o relógio da etapa. Sem ele é
--      impossível perguntar "há quantos dias esse lead está parado",
--      que é o gatilho de inatividade.
--   2. `deal_stage_events` — o histórico de cada passagem de etapa.
--      Alimenta relatório de conversão e tempo médio por etapa.
--   3. Gatilhos de banco que mantêm (1) e (2) sozinhos.
--
-- Por que gatilho de BANCO e não código de aplicação: hoje existem
-- pelo menos três caminhos que escrevem `stage_id` (quadro kanban,
-- formulário de negócio, motor de automação) e amanhã existirão mais.
-- Um gatilho no banco é o único ponto por onde TODOS obrigatoriamente
-- passam. Se o relógio da etapa dependesse de a aplicação lembrar de
-- atualizá-lo, o gatilho de inatividade silenciosamente mentiria toda
-- vez que alguém esquecesse um caminho — e mentira silenciosa em
-- automação é pior que automação nenhuma.
--
-- O DESPACHO do gatilho de automação continua na aplicação (o banco
-- não sabe chamar o Next.js). O histórico aqui é a fonte da verdade;
-- o despacho é o efeito colateral.
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================


-- ============================================================
-- PARTE 1 — O relógio da etapa
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ;

COMMENT ON COLUMN deals.stage_entered_at IS
  'Quando o negócio entrou na etapa ATUAL. Reiniciado a cada mudança de stage_id pelo gatilho trg_deals_stage_clock. Base do gatilho de automação deal_stalled.';

-- Retroalimenta os negócios que já existem. Não temos o histórico
-- real deles, então o melhor palpite honesto é a última vez que a
-- linha foi tocada. Só preenche o que está nulo, então rodar de novo
-- não reescreve nada.
--
-- ATENÇÃO DE OPERAÇÃO: na PRIMEIRA execução este UPDATE toca todas as
-- linhas de `deals`, porque a coluna acabou de nascer nula em todas.
-- É reescrita de tabela inteira num único comando: segura, mas mantém
-- um lock ROW EXCLUSIVE sobre `deals` do início ao fim (SELECT segue
-- livre; outros UPDATE esperam). Em base pequena passa em
-- milissegundos. Se `deals` já tiver centenas de milhares de linhas,
-- rode a migration em janela de baixo movimento, ou quebre este
-- comando em lotes por faixa de `created_at`.
UPDATE deals
   SET stage_entered_at = COALESCE(updated_at, created_at, NOW())
 WHERE stage_entered_at IS NULL;

ALTER TABLE deals ALTER COLUMN stage_entered_at SET DEFAULT NOW();


-- ============================================================
-- PARTE 2 — O histórico de passagens
-- ============================================================

CREATE TABLE IF NOT EXISTS deal_stage_events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id       UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- NULL na criação do negócio: não veio de lugar nenhum.
  from_stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id   UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,

  -- Quantos segundos o negócio passou na etapa de origem. Gravado no
  -- momento da saída, quando o dado ainda existe. Calcular isso depois
  -- exigiria varrer o histórico inteiro em ordem; gravar na saída
  -- custa zero e deixa o relatório de tempo médio por etapa ser uma
  -- única agregação.
  seconds_in_from_stage BIGINT,

  -- Quem moveu. NULL = escrita de service_role, ou seja, o motor de
  -- automação (auth.uid() é nulo fora de uma sessão autenticada).
  -- Esse "nulo com significado" é justamente o que distingue
  -- movimento humano de movimento automático no relatório.
  changed_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE deal_stage_events IS
  'Histórico append-only de mudanças de etapa. Escrito por gatilho de banco, portanto captura TODOS os caminhos de escrita, inclusive o arrastar-e-soltar que grava direto do navegador.';
COMMENT ON COLUMN deal_stage_events.changed_by IS
  'Usuário que moveu. NULL significa movimento pelo motor de automação (service_role não tem auth.uid()).';

-- Varredura do gatilho de inatividade: "negócios desta conta, nesta
-- etapa, parados desde antes de X". Cobre exatamente esse predicado.
CREATE INDEX IF NOT EXISTS idx_deals_stage_clock
  ON deals(account_id, stage_id, stage_entered_at);

-- Linha do tempo de um negócio, e agregação por conta.
CREATE INDEX IF NOT EXISTS idx_deal_stage_events_deal
  ON deal_stage_events(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deal_stage_events_account
  ON deal_stage_events(account_id, created_at DESC);


-- ---- RLS ---------------------------------------------------
-- Histórico é append-only para a aplicação: membros LEEM, ninguém
-- edita nem apaga pela API. A escrita acontece exclusivamente pelo
-- gatilho, que roda como SECURITY DEFINER e portanto não é barrado
-- pela ausência de política de INSERT.
ALTER TABLE deal_stage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_stage_events_select ON deal_stage_events;
CREATE POLICY deal_stage_events_select ON deal_stage_events
  FOR SELECT USING (is_account_member(account_id));


-- ============================================================
-- PARTE 3 — Os gatilhos que mantêm tudo sozinho
-- ============================================================

-- BEFORE: o relógio da etapa é propriedade EXCLUSIVA deste gatilho.
--
-- Repare que ele roda em TODO update de `deals`, não apenas em
-- `UPDATE OF stage_id`. A diferença é de segurança, não de estilo.
--
-- RLS é por linha, não por coluna: a política `deals_update` da 017
-- deixa qualquer membro com papel de agente escrever QUALQUER coluna
-- da linha, incluindo `stage_entered_at`. Se o gatilho só disparasse
-- quando `stage_id` aparecesse no SET, dois caminhos escapariam:
--
--   1. `UPDATE deals SET stage_entered_at = '2000-01-01'` — o gatilho
--      nem dispararia, e o valor do cliente entraria intacto;
--   2. `SET stage_id = <mesmo valor>, stage_entered_at = '2000-01-01'`
--      — dispararia, mas o ramo de mudança seria falso e o valor
--      passaria mesmo assim.
--
-- Em ambos, o relógio de inatividade seria zerado sem que negócio
-- nenhum tivesse andado, e o gatilho `deal_stalled` passaria a mentir
-- em silêncio — precisamente o que o cabeçalho deste arquivo diz que
-- a solução em banco existe para impedir. Um formulário que
-- reenviasse o registro inteiro já bastaria para provocar isso sem
-- ninguém agir de má-fé.
--
-- Por isso o `ELSE` explícito: quando a etapa não muda, o valor
-- anterior é restaurado por cima do que o cliente mandou. A coluna
-- passa a ser inescrevível de fora, sem depender de REVOKE por
-- coluna.
--
-- `IS DISTINCT FROM` e não `<>` porque `<>` com NULL devolve NULL, e
-- NULL não é verdadeiro — um UPDATE que trocasse a etapa de/para NULL
-- passaria batido.
CREATE OR REPLACE FUNCTION wacrm_deals_stage_clock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.stage_entered_at := NOW();
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_entered_at := NOW();
  ELSE
    NEW.stage_entered_at := OLD.stage_entered_at;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION wacrm_deals_stage_clock() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_deals_stage_clock ON deals;
CREATE TRIGGER trg_deals_stage_clock
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION wacrm_deals_stage_clock();


-- AFTER: grava a passagem no histórico.
-- SECURITY DEFINER porque a tabela tem RLS sem política de INSERT — a
-- intenção é que NINGUÉM escreva histórico pela API, só este gatilho.
CREATE OR REPLACE FUNCTION wacrm_deals_stage_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO deal_stage_events (deal_id, account_id, from_stage_id, to_stage_id, changed_by)
    VALUES (NEW.id, NEW.account_id, NULL, NEW.stage_id, auth.uid());

  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO deal_stage_events (
      deal_id, account_id, from_stage_id, to_stage_id,
      seconds_in_from_stage, changed_by
    )
    VALUES (
      NEW.id, NEW.account_id, OLD.stage_id, NEW.stage_id,
      -- OLD.stage_entered_at pode ser nulo em negócio anterior à
      -- retroalimentação acima; nesse caso o tempo é desconhecido e
      -- fica nulo, que é honesto. Zero seria mentira.
      CASE WHEN OLD.stage_entered_at IS NULL THEN NULL
           ELSE EXTRACT(EPOCH FROM (NOW() - OLD.stage_entered_at))::BIGINT
      END,
      auth.uid()
    );
  END IF;

  RETURN NULL;  -- AFTER trigger: valor de retorno é ignorado.
END;
$$;

-- Dono explícito, e não implícito de "quem rodou a migration".
--
-- `deal_stage_events` tem RLS com política apenas de SELECT: a
-- intenção é que ninguém escreva histórico pela API. Quem escreve é
-- este gatilho, e ele só consegue porque roda como o dono da função,
-- que atravessa RLS.
--
-- Se a migration fosse aplicada por um papel SEM esse privilégio, o
-- INSERT do gatilho passaria a violar a política — e como um AFTER
-- trigger que falha aborta a transação inteira, TODA mudança de etapa
-- de negócio pararia de funcionar, inclusive o arrastar-e-soltar do
-- quadro. Fixar o dono transforma essa dependência silenciosa numa
-- garantia declarada.
ALTER FUNCTION wacrm_deals_stage_event() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_deals_stage_event ON deals;
CREATE TRIGGER trg_deals_stage_event
  AFTER INSERT OR UPDATE OF stage_id ON deals
  FOR EACH ROW EXECUTE FUNCTION wacrm_deals_stage_event();


-- ============================================================
-- PARTE 4 — A tese no negócio
--
-- A migration 039 criou `deals.practice_area` e a indexou, mas NADA
-- no aplicativo jamais a preencheu: `create_deal` não copia a tese do
-- contato, o formulário de negócio não tem o campo, e a interface
-- `Deal` sequer declara a coluna. Ela nasceu órfã. O comentário da
-- 039 ("normalmente copiada do contato na criação") descrevia uma
-- intenção que nunca virou código.
--
-- Isso importa agora porque a automação passa a casar o negócio do
-- contato PELA TESE — um lead de BPC e um de aposentadoria são casos
-- distintos e não podem se atropelar no funil. Casar por uma coluna
-- que está sempre nula não casaria com nada.
--
-- Aqui a coluna é retroalimentada a partir do contato. A partir de
-- agora quem a mantém é o aplicativo (create_deal e move_deal_stage).
-- ============================================================

UPDATE deals d
   SET practice_area = c.practice_area
  FROM contacts c
 WHERE d.contact_id = c.id
   AND d.practice_area IS NULL
   AND c.practice_area IS NOT NULL;


-- ============================================================
-- PARTE 5 — Consulta de negócios parados
--
-- Encapsulada em função para que a varredura periódica não precise
-- reproduzir a regra de "negócio aberto" em TypeScript. A regra mora
-- num lugar só.
--
-- Sobre `status`: a 001 criou a coluna com DEFAULT 'active', mas a
-- migration 002 normalizou os dados existentes, trocou o default para
-- 'open' e instalou `deals_status_check CHECK (status IN ('open',
-- 'won','lost'))`. Ou seja, 'active' é história morta — só as três
-- grafias sancionadas existem hoje. A coluna aceita NULL, então o
-- COALESCE abaixo trata o nulo como aberto, que é a leitura do resto
-- do código.
-- ============================================================

CREATE OR REPLACE FUNCTION find_stalled_deals(
  p_account_id UUID,
  p_stage_id   UUID,
  p_older_than TIMESTAMPTZ,
  p_limit      INTEGER DEFAULT 200
)
RETURNS TABLE (
  deal_id       UUID,
  contact_id    UUID,
  pipeline_id   UUID,
  stage_id      UUID,
  practice_area TEXT,
  stage_entered_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
-- SECURITY INVOKER de propósito, seguindo a 041. O único chamador é a
-- varredura periódica, que usa a chave de service_role — e esse papel
-- já ignora RLS por atributo próprio, independentemente do modo da
-- função. Um SECURITY DEFINER aqui não compraria capacidade nenhuma e
-- só ampliaria a superfície, contra a disciplina que o projeto adotou
-- depois do incidente registrado na migration 037.
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT d.id, d.contact_id, d.pipeline_id, d.stage_id,
         d.practice_area, d.stage_entered_at
    FROM deals d
   WHERE d.account_id = p_account_id
     AND d.stage_id   = p_stage_id
     AND d.stage_entered_at IS NOT NULL
     AND d.stage_entered_at < p_older_than
     AND COALESCE(d.status, 'open') NOT IN ('won', 'lost')
   ORDER BY d.stage_entered_at ASC
   LIMIT p_limit;
$$;

COMMENT ON FUNCTION find_stalled_deals IS
  'Negócios ABERTOS de uma conta parados numa etapa desde antes de p_older_than. Usada pela varredura periódica que dispara o gatilho deal_stalled.';


-- ============================================================
-- PARTE 6 — Trava de disparo único do gatilho de inatividade
--
-- `find_stalled_deals` responde "quem está parado", não "quem ainda
-- não foi avisado". Um negócio parado há oito dias continua parado na
-- rodada seguinte do cron, e na outra, e na outra. Sem trava, uma
-- automação de inatividade que apenas envie uma mensagem passaria a
-- reenviá-la a cada varredura — para o cliente, do outro lado, isso é
-- indistinguível de spam.
--
-- A chave inclui a ETAPA de propósito: se o negócio sair e voltar
-- mais tarde para a mesma etapa, é um novo período de inatividade e
-- merece novo aviso. O que a trava impede é o mesmo período ser
-- anunciado duas vezes.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_stalled_dispatches (
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  deal_id       UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  stage_id      UUID NOT NULL,
  fired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (automation_id, deal_id, stage_id)
);

COMMENT ON TABLE automation_stalled_dispatches IS
  'Marca que uma automação de inatividade já avisou sobre um negócio numa etapa. Impede reenvio a cada rodada do cron.';

ALTER TABLE automation_stalled_dispatches ENABLE ROW LEVEL SECURITY;
-- Sem política alguma: é estado interno da varredura, que roda com
-- service_role. RLS ligada e nenhuma política significa que nenhum
-- usuário autenticado enxerga ou escreve esta tabela.

/**
 * Reserva o direito de disparar, de forma atômica.
 *
 * Devolve TRUE apenas para quem inseriu a linha. Duas execuções
 * sobrepostas do cron chamando isto para o mesmo negócio: uma recebe
 * TRUE e dispara, a outra recebe FALSE e segue adiante. A garantia
 * vem da chave primária, não de um "leia depois escreva" — que é
 * exatamente onde uma verificação em TypeScript perderia a corrida.
 */
CREATE OR REPLACE FUNCTION claim_stalled_dispatch(
  p_automation_id UUID,
  p_deal_id       UUID,
  p_stage_id      UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted INTEGER;
BEGIN
  INSERT INTO automation_stalled_dispatches (automation_id, deal_id, stage_id)
  VALUES (p_automation_id, p_deal_id, p_stage_id)
  ON CONFLICT (automation_id, deal_id, stage_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END;
$$;

COMMENT ON FUNCTION claim_stalled_dispatch IS
  'Reserva atomicamente o disparo de deal_stalled. TRUE = pode disparar; FALSE = já foi avisado.';

ALTER FUNCTION claim_stalled_dispatch(UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION claim_stalled_dispatch(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_stalled_dispatch(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION claim_stalled_dispatch(UUID, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_stalled_dispatch(UUID, UUID, UUID) TO service_role;

-- Quando um negócio muda de etapa, as marcas da etapa ANTERIOR viram
-- lixo: aquele período de inatividade acabou. Limpar aqui evita a
-- tabela crescer para sempre e mantém a semântica de "um aviso por
-- período".
CREATE OR REPLACE FUNCTION wacrm_clear_stalled_dispatches()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    DELETE FROM automation_stalled_dispatches
     WHERE deal_id = NEW.id
       AND stage_id = OLD.stage_id;
  END IF;
  RETURN NULL;
END;
$$;

ALTER FUNCTION wacrm_clear_stalled_dispatches() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_deals_clear_stalled ON deals;
CREATE TRIGGER trg_deals_clear_stalled
  AFTER UPDATE OF stage_id ON deals
  FOR EACH ROW EXECUTE FUNCTION wacrm_clear_stalled_dispatches();

-- A isolação de inquilino é o parâmetro p_account_id, obrigatório. A
-- função NÃO fica exposta ao papel `authenticated`: quem a chama é a
-- varredura periódica, que roda sem sessão de usuário. Expô-la a
-- usuários comuns não teria utilidade e daria a eles uma consulta
-- parametrizada por conta.
ALTER FUNCTION find_stalled_deals(UUID, UUID, TIMESTAMPTZ, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION find_stalled_deals(UUID, UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION find_stalled_deals(UUID, UUID, TIMESTAMPTZ, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION find_stalled_deals(UUID, UUID, TIMESTAMPTZ, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION find_stalled_deals(UUID, UUID, TIMESTAMPTZ, INTEGER) TO service_role;
