# QA independente — evidência de onboarding YCloud

Repositório CRM-Advogado/crm-advogado, branch `codex/ycloud-durable-ingress`, base `ab2973d`. Escopo: captura autenticada de `whatsapp.business_account.updated/PARTNER_ADDED`, sem associação de cliente, envio ou conexão operacional.

## Resultados locais

- 33 testes independentes em `src/lib/whatsapp/ycloud-partner-ingress-qa.test.ts` passaram, incluindo 7 casos do handler HTTP real com banco substituído. Os 15 testes de desenvolvimento são separados.
- Suíte completa: **1.070 testes em 89 arquivos**, todos aprovados.
- Typecheck aprovado. Lint completo: **0 erros e 38 avisos preexistentes**; lint focado dos arquivos QA sem avisos.
- **29 casos SQL passaram em PostgreSQL 17 local descartável**, com conexão restrita a `127.0.0.1:55484`. O harness cria um banco de nome controlado e o remove no encerramento. O cluster local foi parado após o teste.
- Build final e CI são responsabilidade do coordenador; este relatório não declara esses resultados antes de sua execução.

## Cobertura independente

A camada TypeScript/HTTP verifica flag desligada sem inicializar banco, configuração de namespace, assinatura nos bytes originais, janela de replay, UTF-8 inválido, limite de corpo sem Content-Length, recusa de eventos fora do escopo, identificadores inválidos, persistência mínima, ausência de seletores do navegador, indicador de crédito falso sem ativação, replay e falhas de persistência. Uma Promise de RPC mantida pendente confirma que a função não retorna sucesso antes da aceitação. O handler retorna 404/401/409/422/503 nos respectivos cenários e conserva `Cache-Control: no-store`, sem expor o erro privado.

O PostgreSQL real verifica reaplicação da migration preservando dados, replay idempotente, namespaces separados, conflito imutável em digest/WABA/cliente/crédito, duas conexões concorrentes com replays idênticos e conflitantes, rollback sem aceitação, RPC e tabela inacessíveis a anon/authenticated, RLS negando leitura mesmo após grant de SELECT acidental, service_role autorizado somente para leitura e RPC, escrita direta negada, SECURITY DEFINER/search_path fixo, constraints e ausência de coluna de payload bruto/assinatura/chave/tenant/ativação.

## Bugs e regressões

Não houve bug novo com reprodução vermelha neste incremento. As coberturas independentes passaram contra o candidato; não se alega RED observado ou correção de defeito não reproduzido. Falhas iniciais de conexão local foram do isolamento do processo/sandbox, não do SQL ou da aplicação; o ensaio completo posteriormente passou.

## Limites de aceite

Não houve API YCloud real, mensagens, consumo de saldo, cadastro de webhook, alteração no banco externo, ativação de flag ou vínculo de cliente. A migration 045 e os emissores Meta permanecem separados; o receptor novo não os invoca. Não foram exercitados onboarding TP Lite real, elegibilidade de número, coexistência, materialização de mensagens, worker de reconciliação, deployment ou isolamento RLS no Supabase externo. Este ledger guarda evidência de fornecedor, não concede acesso a uma conta CRM. O retorno mantém `operational=false`.

O receptor é deliberadamente parcial: updates diferentes de PARTNER_ADDED retornam 422, inclusive dentro da família assinada. Antes de habilitar externamente, validar subscrições e limites de reentrega/suspensão do fornecedor. Não usá-lo como receptor geral de mensagens/status/ecos.

Reprodução SQL: `npm run test:ycloud-evidence:qa` com PostgreSQL exclusivamente local e variáveis PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE do ambiente descartável. Nunca apontar o harness para banco remoto ou produção.

Build de produção validado pelo coordenador com configurações fictícias; nenhuma integração externa acessada.
