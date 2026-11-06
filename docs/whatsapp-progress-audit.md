# Retomada das integrações WhatsApp

GitHub verificado em 28/10/2026; os estados da tabela técnica abaixo são o recorte consultado em 27/10/2026, sem nova confirmação pelo conector. Repositório: CRM-Advogado/crm-advogado. Base develop: 31efc7f. O ambiente do Moacir permanece separado.

## Entregas integradas

- PR #3: contratos de provedores e adaptação incremental Meta; corresponde à arquitetura WA-01 e parte de WA-02.
- PR #4: adaptador YCloud isolado, assinatura e normalização de eventos; parte de WA-05, sem runtime operacional.
- PR #6: normalização dos ecos do WhatsApp Business; parte de WA-05, sem homologação real de coexistência.
- PR #7: recebimento durável Meta; parte de SEC-IMP-07. O schema e o worker pressupõem Meta e não recebem YCloud diretamente.
- PR #8: diagnóstico de leitura da conta própria YCloud, integrado. Não cria conexão, vínculo ou autorização de cliente.
- PR #9: evidências assinadas de onboarding YCloud, persistidas antes do ACK e deduplicadas por endpoint/evento. Integrado; não ativa conexão.

## Trabalhos ainda abertos

- PR #2: Embedded Signup Meta. Não integrado; não equivale ao onboarding TP Lite YCloud.
- PR #5: proposta documental anterior ao PR #7. Não integrada; conferir sobreposição antes de eventual fechamento.
- WA-03/04: experiência comum de conexão e onboarding delegado com associação segura ao cliente.
- WA-05: ingresso e processamento duráveis YCloud, vínculo persistente, resolução operacional do provedor e integração às conversas.
- WA-09/SEC-QA-01/HML-17: fixtures e regressões, seguidas de homologação real e isolamento entre contas. Testes simulados não substituem autorização, envio e recebimento reais.

A candidatura YCloud foi recebida, mas o retorno do representante pediu informações do produto, onboarding e volumes. A resposta autorizada solicitou TP Lite/coexistência e esclarecimento de requisitos/custos. Não há confirmação de habilitação.

## Incremento desta retomada

Reservar a identidade opaca do cliente no servidor, com um único ciclo inicial de duas horas por conta/endpoint, e reconciliar a evidência do PR #9 com essa identidade. A correlação permanece como `evidence_matched`, sem afirmar conclusão de tentativa, autorização operacional ou coexistência. Expiração e contradições exigem revisão manual; não há renovação ou reassociação automática. Flag desligada por padrão; SQL apenas local e revisável.

Ainda faltam emissão do link TP Lite, interface de conexão, validação operacional da WABA/número e coexistência, revogação, runtime durável de mensagens, HTTPS/backend, configuração externa e QA real. O ledger atual registra chegada do evento, sem identificador de tentativa do provedor; não permite provar uma nova tentativa por tempo de chegada. Não marcar WA-04/05/09 ou SEC-IMP-07 inteiras como concluídas por este recorte.

Fontes: https://github.com/CRM-Advogado/crm-advogado/pulls?q=is%3Apr e https://docs.superhuman.com/d/CRM-Advocacia_d8ADxLuRmmb/Tarefas-Tecnicas_su2VIKB9.
