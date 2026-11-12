# QA — recebimento durável Meta local

Data: 17/10/2026, com execuções iniciais em 16/10. Repositório CRM-Advogado/crm-advogado. Branch codex/whatsapp-durable-ingress, base origin/develop 8fb566e. Referência de desenho: ADR 002 aprovada para desenvolvimento local. QA independente não editou implementação, migração ou testes do desenvolvimento.

## PostgreSQL real e método

37 cenários independentes passaram em PostgreSQL 17.10 portátil, restrito ao loopback, com dados fictícios. O script scripts/qa/whatsapp-durable-qa.mjs cria um banco isolado com nome gerado e validado whatsapp_durable_qa_<timestamp>, aplica a migration 045 e remove somente esse banco ao terminar. PGHOST, PGPORT, PGUSER, PGPASSWORD e PGDATABASE configuram acesso ao cluster local; hosts externos são recusados. A execução padrão local usa porta 55483.

O harness usa conexões PostgreSQL separadas, transações e locks reais. Não usa mocks para comprovar atomicidade, exclusão mútua, isolamento de privilégios ou posse das reservas. O processo sandbox bloqueia sockets por padrão; execução local autorizada fora desse isolamento foi necessária.

A fixture inclui somente tabelas/colunas de dependência utilizadas pela migration, preservando os tipos, checks de mensagens e modelos, unicidade de telefone por conta e unicidade de conversa por conta/contato relevantes das migrations 001, 014, 017, 022, 035 e 036. Não é um clone completo do Supabase: auth, Storage, Realtime, triggers não relacionados e todas as políticas RLS históricas não são homologados por esse teste. As tabelas, RPCs, permissões e RLS novos da migration 045 são aplicados de verdade.

## Achados e evidências

| Achado                                                                                               | Evidência anterior                                                                                        | Cobertura após correção                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Referência a variável local qualificada com nome da função em SQL PL/pgSQL falhava na materialização | Execução real retornou 42P01, missing FROM-clause entry for table materialize_whatsapp_ingress            | Bloco explicitamente rotulado; materialização, rollback e duas mensagens concorrentes passaram                                      |
| Identidade repetida com payload diferente precisava continuar detectável após descarte               | Revisão do coordenador/desenvolvimento identificou risco; fix chegou antes da execução independente final | Colisão é rejeitada antes e depois da purga, sem sobrescrever ledger                                                                |
| Contato fornecido pelo chamador precisava corresponder ao telefone canônico                          | Revisão identificou validação inicialmente só por conta                                                   | Teste rejeita contato da mesma conta com outro telefone                                                                             |
| Revínculo concorrente e expiração de lease precisavam cercar a materialização                        | Revisão identificou TOCTOU e relógio de início da transação                                               | Locks reais impedem revínculo até commit; expiração por relógio atual dentro de transação antiga ou durante espera provoca rollback |

Também houve reprodução vermelha independente de duas intenções distintas da mesma conexão reservadas simultaneamente por dois workers (2 reservas, esperado 1). Após FIFO por sequência local e exclusão por conexão na inbox e outbox, o regressivo passou. O teste SQL adicional de reação identificou ainda erro 42702, coluna message_id ambígua no conflito da upsert, corrigido por variável local distinta; o teste de adicionar/remover reação passou depois da correção. Os demais riscos de revisão possuem regressivos verdes após as correções; não se alega execução vermelha independente desses casos.

## Cenários independentes cobertos

- Migration reaplicável; enqueue concorrente da mesma identidade gera uma linha.
- Envelope com contas diferentes e um vínculo inválido desfaz o lote inteiro.
- Mesma identidade com conteúdo diferente é rejeitada, inclusive após purga.
- Claimers concorrentes recebem conjuntos distintos; token antigo não conclui após nova reserva.
- Rollback explícito e falha SQL interna não deixam contatos, conversas, mensagens, conclusão ou intenções parciais.
- Eventos diferentes do mesmo telefone usam reservas sequenciais por conexão e geram um contato/conversa e unread igual a dois. O primeiro evento aceito recebe first_inbound/was_created; contas diferentes continuam concorrentes.
- Conta e conexão originais são preservadas após revínculo; exclusão de conexão conserva o item aceito e cancela materialização.
- Modelo com mesmo ID externo em outra conta permanece intocado.
- Outbox admite um consumidor por intenção; checkpoint é anterior ao efeito e expiração posterior vira uncertain, sem nova reserva para envio.
- Finalização antiga é recusada; conclusão bem-sucedida remove o payload correspondente e conserva ledger.
- Replay após conclusão não repete mensagem, unread nem outbox.
- Revogação entre materialização e início da outbox cancela a intenção.
- anon/authenticated não leem conteúdo nem executam RPCs de worker; service_role pode reservar; search_path das funções é fixado.
- Inspeção é isolada por conta e não inclui conteúdo das mensagens.

## Camada TypeScript e execução

10 testes independentes adicionais em src/lib/whatsapp/durable-qa.test.ts passaram. Doubles nesta camada verificam o contrato da rota e do worker, sem substituir os testes SQL: ACK aguarda aceitação durável; erro de banco responde 503 sem processamento legado; assinatura inválida e corpo excessivo falham antes da aceitação; pausa não recai no handler legado; falha no checkpoint não executa efeito; falha após efeito parcial gera uncertain sem repetir; cancelamento não executa; contexto assíncrono isola conta/conexão e bloqueia início de outro efeito após expiração.

Com PostgreSQL descartável local e dependências instaladas, executar npm run test:whatsapp-durable:qa. Em CI, o job usa PostgreSQL 17 e configura PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE. Nenhum binário temporário ou módulo em .qa-temp é necessário para reproduzir o script.

Inbox e outbox respeitam sequência de recebimento local por conexão; contas distintas continuam paralelas e linhas bloqueadas de uma conta não paralisam outra. Cancelamento manual do item de inbox exige conta/operador, conserva conteúdo não resolvido e registra auditoria. Outbox incerta bloqueia trabalho posterior da mesma conexão. A resolução manual exige conta, operador e decisão auditados; apenas confirma conclusão ou cancela sem retry, libera intenções posteriores e não reenvia a intenção incerta. Locks de linhas de uma conta não bloqueiam a reserva de outra nos casos testados, incluindo recuperação de starts expirados.

## Limites

Esses cenários comprovam o recorte SQL local. Não demonstram implantação, cron configurado, serviço Supabase real, acesso entre escritórios no ambiente de homologação ou entrega externa. A outbox tem uma intenção de pipeline por evento, sem ledger de cada passo; término do pipeline não equivale a entrega comprovada em fornecedor. Resultados incertos exigem diagnóstico manual e não são repetidos automaticamente.

Payload de inbox concluída é descartado; itens não resolvidos e ledger não recebem prazo de exclusão silencioso nesta entrega. Retenção operacional, ambiente exclusivo e credenciamento continuam necessários antes de habilitação externa. Candidato congelado: 995 testes Vitest em 86 arquivos passaram, incluindo 10 casos independentes de QA; os 37 cenários PostgreSQL independentes também passaram. Typecheck do desenvolvimento e TypeScript do build passaram. Lint completo: 0 erros e 38 avisos existentes. Build de produção aprovado pelo coordenador, com 63 páginas. Após o último ajuste apenas SQL para reação, o harness PostgreSQL completo foi reexecutado e passou. Nenhuma aprovação externa é inferida desses resultados.

A flag WHATSAPP_DURABLE_INGRESS_ENABLED permanece desabilitada por padrão. O modo paused recusa novas confirmações e preserva o caminho de drenagem; voltar ao legado após aceitar eventos exige o procedimento de rollback documentado. Não houve aplicação de migrations em serviço externo, ativação, alteração de cron real ou envio a fornecedor.
