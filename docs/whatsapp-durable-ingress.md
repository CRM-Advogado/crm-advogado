# Recebimento durável Meta — candidato local

Data: 17/10/2026. Implementação local da ADR 002 aprovada pelo usuário.
Não houve aplicação de migration em banco externo, ativação de flag, implantação,
agendamento externo ou envio real. O ambiente do Moacir permanece separado.

## Caminho efetivo

O modo durável da rota Meta limita o corpo durante a leitura a 1 MiB, verifica
a assinatura original, prepara fragmentos por conexão e chama um único RPC de
enqueue. Só retorna 200 depois de persistir todo o lote aceito. Erros de banco
retornam 503; vínculo inválido retorna 409; dados inválidos, 400. Nenhuma falha
faz fallback para o handler antigo. Campos de webhook desconhecidos são
classificados como ignorados no resultado, sem armazenar conteúdo desnecessário.

`045_whatsapp_durable_ingress.sql` cria inbox e outbox no PostgreSQL existente.
O worker materializa contato/conversa/mensagem, contadores, reações, status,
templates e intenções em uma transação. Eventos distintos podem existir com o
mesmo ID externo em conexões diferentes. Uma identidade repetida com conteúdo
ou conta conflitante é recusada, mesmo depois de purgar o fragmento original,
pois o ledger mantém um digest imutável.

O processamento após o ACK é apenas uma tentativa de dreno imediato. Recuperação
independente requer invocar periodicamente `/api/whatsapp/ingress/cron`, usando
`x-cron-secret` e o segredo de cron já existente. A implementação do endpoint
não configura esse agendador. Nenhum serviço de filas foi acrescentado.

## Modos e rollback

| `WHATSAPP_DURABLE_INGRESS_ENABLED` | Novo ingresso Meta                        | Cron durável                     |
| ---------------------------------- | ----------------------------------------- | -------------------------------- |
| Ausente ou `false`                 | Caminho legado, sem garantia durável      | Desabilitado                     |
| `true`                             | Persiste antes do ACK                     | Habilitado com autenticação      |
| `paused`                           | Rejeita novo ingresso autenticado com 503 | Habilitado para drenar o backlog |

O padrão continua legado; a migration não ativa a flag. Após ativar o candidato,
**não usar ausente/false como rollback**: esse caminho voltaria a confirmar sem
inbox e poderia duplicar eventos aceitos anteriormente. Para interromper novas
confirmações, usar `paused`, manter tabelas/ledger e drenar ou revisar os itens.
A reversão de código precisa preservar esse ingresso compatível, ou bloquear
novos ACKs no destino. Reensaiar o corte em homologação antes de qualquer ativação.

## Ordem, reservas e recuperação

- A sequência persistida da inbox define a ordem de recebimento local, inclusive
  dentro de um lote; não é uma promessa sobre ordem temporal de origem.
- Claims usam locks curtos/advisory por conexão e `SKIP LOCKED`. Apenas um item
  da conexão é materializado por vez. Os efeitos também são serializados por
  conexão. Um lock/falha de uma conta não deve bloquear as demais.
- Antes da materialização, a reserva pode expirar e ser retomada com outro token.
  O worker antigo não conclui com token expirado. Falhas transacionais podem ser
  tentadas até cinco vezes, com espera limitada; depois exigem diagnóstico.
- Uma falha anterior bloqueia a sequência daquela conexão. É possível cancelar
  explicitamente o evento com auditoria, sem apagar sua cópia não materializada.
- Antes de qualquer efeito externo, a outbox grava `external_started_at`.
  Queda, erro ou expiração depois disso resultam em `uncertain`. O item não volta
  automaticamente a pending, e os efeitos seguintes da conexão ficam bloqueados.
- O início ainda não prova que o POST ocorreu. Mesmo uma queda imediatamente
  anterior à chamada é incerta, por conservadorismo. Uma repetição cega seria
  pior que exigir revisão manual de um envio que talvez não tenha acontecido.

Há validação de vínculo no banco durante materialização e início, e novamente
antes do despacho. O contexto durável verifica conexão/número/WABA e deadline
antes de construir cada emissor Meta e antes das fases do pipeline. Não migra
para uma conexão nova se o número for revinculado. Uma requisição HTTP já em
andamento não pode ser desfeita por uma revogação posterior; a janela precisa
ser considerada na homologação. O relógio do worker e o banco devem estar
sincronizados; o fencing no banco usa `clock_timestamp()`.

## Unidade de efeito e equivalência

O pipeline por evento é uma unidade conservadora: webhook de conversa criada,
fluxo, automações, IA e webhook de mensagem. Fluxo consumido suprime gatilhos
de conteúdo e IA; gatilhos de relacionamento continuam. Os flags de primeiro
inbound/contato novo são calculados transacionalmente. Reação não cria mensagem,
não aumenta unread e não dispara esse pipeline. Status conserva avanço monotônico.

`completed` na outbox significa retorno do despacho local, não entrega externa.
Os motores legados podem registrar falhas sem lançar. Examinar também logs de
automações/fluxos/IA e entrega do provedor. Não existe ledger novo por passo:
uma interrupção após efeitos parciais exige revisar o conjunto; o worker não
repete a orquestração inteira. A garantia de exatamente uma entrega externa não
é oferecida.

Mudanças deliberadas frente ao legado: telefone canônico exato em vez de fuzzy
por últimos oito dígitos; nomes associados por `wa_id`; mídia referenciada pelo
proxy sem validação HTTP prévia; `last_message_at` não regride por evento antigo.
Variantes de tronco podem precisar de correção manual antes da ativação.

Templates são restritos à conta da conexão/WABA original, inclusive quando duas
contas possuem o mesmo ID de modelo. Alteração de componentes mantém diagnóstico
de sincronização manual. Sem tempo/ID da origem, templates usam identidade por
requisição para permitir ciclos legítimos de estado: não há promessa de dedupe
semântica ou ordenação nesse caso. Atualizações são DB-idempotentes, sem outbox.

## Diagnóstico e decisões manuais

Todos os RPCs abaixo são restritos a `service_role`; não são API pública ou UI.
O operador usa IDs de conta/item e sua identidade de auditoria. Não registrar
segredos ou conteúdo nos comandos/logs de operação.

- `inspect_whatsapp_ingress(p_account_id, p_limit)`: metadados e estados de inbox
  e outbox, sem payload, tokens de reserva ou texto de mensagens.
- `resolve_whatsapp_ingress_uncertain(p_outbox_id, p_account_id, p_operator_id,
p_resolution)`: aceita somente `confirmed_completed` ou `cancelled_without_retry`.
  Registra ator, horário e decisão; nunca reenvia nem devolve o item a pending.
  Só libera próximos efeitos após avaliação do evento incerto.
- `cancel_whatsapp_ingress(p_event_id, p_account_id, p_operator_id)`: cancela
  evento ainda não materializado, registra auditoria e conserva sua cópia para
  a política de retenção. Não remove mensagem já materializada.

Revogação ou remoção de configuração não apaga silenciosamente trabalho aceito:
os IDs originais são preservados sem cascata de conta/conexão. Itens que perderam
o vínculo são cancelados ou ficam incertos se o efeito já começou. Eles não são
reatribuídos a outra conta ou número.

A cópia da inbox é apagada no commit da materialização. A da outbox é apagada
na conclusão ou resolução explícita. A mensagem canônica e o ledger permanecem.
Não existe TTL automático de pendentes/falhos/incertos/cancelados não
materializados; a política externa ainda precisa ser definida. Monitorar volume,
idade, estados falhos, conexões bloqueadas e cron, sem descartar itens para
aliviar saturação. Se o banco não aceitar, não confirmar 200.

## Verificação local e limites externos

O QA independente executa `npm run test:whatsapp-durable:qa` em PostgreSQL 17
descartável, limitado a loopback, com criação e remoção de um banco de nome
controlado. Configuração via `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` e
`PGDATABASE`. O script exige um usuário local autorizado a criar banco e testa
o delta contra fixtures coerentes com as constraints relevantes do baseline.
Não apontar esse teste a um serviço externo ou banco de produção.

São necessários testes de reexecução da migration, rollback, lote atômico,
purga e digest, duas contas, colisão de IDs, nomes de remetente, status/reação,
templates, leases, locks, concorrência e resolução sem replay. Os testes unitários
também verificam ACK, falha de persistência, conteúdo, flags e pipeline.
Fixtures não substituem executar toda a sequência de migrations e testar RLS no
Supabase exclusivo de homologação, nem comprovam entrega ou agendamento real.

YCloud, coexistência operacional, histórico e Gupshup não são ativados por este
incremento. O candidato pode ser revisado e testado localmente; aplicação externa
de SQL, credenciamento, retenção e ativação exigem o alinhamento correspondente.
