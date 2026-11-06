# QA independente — identidade e reserva YCloud

Repositório CRM-Advogado/crm-advogado, branch `codex/ycloud-account-binding`, base `31efc7f`. O incremento reserva uma identidade opaca por conta e namespace e permite correlacionar evidência candidata. Não conclui onboarding nem ativa WhatsApp.

## Resultados

- 40 testes independentes TypeScript/HTTP passaram em `src/lib/whatsapp/ycloud-customer-link-qa.test.ts`; lint focado sem erros ou avisos.
- Harness PostgreSQL 17 real em `scripts/qa/ycloud-customer-link-qa.mjs`: **38 cenários aprovados após a correção**, incluindo regressão descrita abaixo.
- Coordenador confirmou suíte global com 1.180 testes em 93 arquivos, typecheck e build aprovados; lint com zero erros e 38 avisos preexistentes. A única correção posterior alterou a consulta SQL do GET e sua documentação, revalidada nos 38 cenários PostgreSQL; não houve mudança de lógica TypeScript após essas verificações.

## Cobertura

Os testes independentes verificam flags antes do banco, RPCs e identidade exclusivamente do servidor, origem canônica contra Host/forwarded headers forjados, recusa de corpos e origens indevidas, queries sem influência sobre a conta, autenticação, membership revalidada no banco, respostas sem campos privados, falhas genéricas e `Cache-Control: no-store`.

O PostgreSQL local verifica identidade UUID gerada no banco, sessão única com TTL fixo de duas horas, reservas idempotentes e concorrentes, impossibilidade de renovar identidade expirada/restaurada, bloqueio de revogação concorrente de membership durante a transação, separação de contas e namespaces, replay, evidência anterior ou tardia, múltiplos eventos inclusive fora da janela, conflitos de WABA sequenciais e concorrentes, rollback sem órfãos, permissões service-role somente via RPC para escrita e RLS negando clientes mesmo com grant de leitura acidental.

## Bug reproduzido e regressão

Após `reserve`, evento A, `reconcile` e evento B com outro WABA para a mesma identidade, o GET devolvia `evidence_matched` persistido até uma nova reconciliação. O teste independente `status detects later contradictory evidence without an explicit reconcile` reproduziu RED em PostgreSQL real: 37 casos passaram e um falhou, retornando `evidence_matched` onde se esperava `manual_review`.

A regressão exige que a consulta detecte a contradição imediatamente, sem apagar o WABA e o evento já reivindicados. Após a correção da consulta SQL, o mesmo caso passou: **38 GREEN, zero falhas**. Nenhum bloqueador permanece neste recorte local.

## Limites

O harness usa fixture mínima de `profiles` e migrations 046/047 em banco local descartável; não valida o projeto Supabase externo completo. O banco efêmero é removido e o cluster parado ao terminar. Nenhuma API real, mensagem, crédito, migration externa, flag operacional ou ambiente do Moacir foi alterado.

`evidence_matched` significa candidato no nível do cliente. `received_at` e TTL representam chegada local; não comprovam origem temporal do evento ou uma tentativa específica de signup. Eventos múltiplos, mesmo para o mesmo WABA, exigem revisão conservadora. Não há emissão de link, vínculo operacional de telefone, envio/recebimento ou coexistência homologada. `operational` e `coexistenceVerified` permanecem falsos.

Reprodução: `npm run test:ycloud-customer-link:qa`, usando apenas PostgreSQL local descartável configurado por PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE. O script recusa hosts externos.
