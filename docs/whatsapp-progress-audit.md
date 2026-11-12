# Retomada das integrações WhatsApp

Verificado em 27/10/2026 no GitHub e na tabela de tarefas do projeto. Repositório: CRM-Advogado/crm-advogado. Base develop: ab2973d. O ambiente do Moacir permanece separado.

## Entregas integradas

- PR #3: contratos de provedores e adaptação incremental Meta; corresponde à arquitetura WA-01 e parte de WA-02.
- PR #4: adaptador YCloud isolado, assinatura e normalização de eventos; parte de WA-05, sem runtime operacional.
- PR #6: normalização dos ecos do WhatsApp Business; parte de WA-05, sem homologação real de coexistência.
- PR #7: recebimento durável Meta; parte de SEC-IMP-07. O schema e o worker pressupõem Meta e não recebem YCloud diretamente.

## Trabalhos ainda abertos

- PR #8: diagnóstico de leitura da conta própria YCloud. CI passou; não integrado. Não cria conexão, vínculo ou autorização de cliente.
- PR #2: Embedded Signup Meta. Não integrado; não equivale ao onboarding TP Lite YCloud.
- PR #5: proposta documental anterior ao PR #7. Não integrada; conferir sobreposição antes de eventual fechamento.
- WA-03/04: experiência comum de conexão e onboarding delegado com associação segura ao cliente.
- WA-05: ingresso e processamento duráveis YCloud, vínculo persistente, resolução operacional do provedor e integração às conversas.
- WA-09/SEC-QA-01/HML-17: fixtures e regressões, seguidas de homologação real e isolamento entre contas. Testes simulados não substituem autorização, envio e recebimento reais.

A candidatura YCloud foi recebida, mas o retorno do representante pediu informações do produto, onboarding e volumes. A resposta autorizada solicitou TP Lite/coexistência e esclarecimento de requisitos/custos. Não há confirmação de habilitação.

## Incremento desta retomada

Capturar somente evidência autenticada de onboarding `whatsapp.business_account.updated/PARTNER_ADDED`, persistindo antes do ACK e deduplicando por endpoint e evento. Não atribuir conta a partir do payload, não reutilizar a inbox Meta, não materializar mensagens e não promover estado conectado. Flag desligada por padrão; SQL apenas local e revisável.

Essa evidência prepara a reconciliação futura com sessões e identificadores de cliente emitidos pelo servidor. Ainda faltam conexão persistente autorizada, estados de revogação e reconciliação, fluxo de links, runtime de mensagens, HTTPS/backend, configuração externa e QA real. Não marcar WA-04/05/09 ou SEC-IMP-07 inteiras como concluídas por este recorte.

Fontes: https://github.com/CRM-Advogado/crm-advogado/pulls?q=is%3Apr e https://docs.superhuman.com/d/CRM-Advocacia_d8ADxLuRmmb/Tarefas-Tecnicas_su2VIKB9.
