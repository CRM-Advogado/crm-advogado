# Integrações WhatsApp — evidências e limites de homologação

Referência das tarefas: WA-01 a WA-09, tabela Tasks do Coda CRM - Advocacia.
Consulta documental: 15/10/2026, America/Sao_Paulo.
Projeto: `CRM-Advogado/crm-advogado`; base `origin/develop` em `efdd4ce`.

## Direção confirmada

O primeiro público é o advogado individual com um número. O modelo de conta
e equipe existente é preservado. Uma identidade de conexão explícita permite
evoluir posteriormente para escritórios e múltiplos números; essa evolução
não faz parte da cardinalidade inicial.

YCloud é o primeiro provedor novo e Gupshup o segundo, conforme o Coda.
A integração Meta existente continua compatível. Não há troca automática
de fornecedor, migração de número, contratação ou ativação em produção.

## YCloud: contrato público verificável

- A [introdução atual da API](https://docs.ycloud.com/en/api-reference/getting-started/ycloud-api)
  documenta `https://api.ycloud.com/v2`, JSON e autenticação `X-API-Key`
  exclusivamente no servidor. Aceitação não comprova entrega.
- O [cliente oficial gerado de OpenAPI](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/apis/whatsapp-messages-api.ts)
  documenta `POST /whatsapp/messages/sendDirectly`, envio síncrono para a API
  WhatsApp, e `GET /whatsapp/messages/{id}`. O envio enfileirado é outra
  operação, `POST /whatsapp/messages`; não deve ser confundido com entrega.
- Os modelos oficiais de [requisição](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/models/whatsapp-message-send-request.ts)
  e [resposta](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/models/whatsapp-message.ts)
  são as referências de serialização do adaptador. O ID do recurso YCloud
  e o `wamid` têm papéis distintos e precisam ser correlacionados.
- A [documentação atual de webhooks](https://docs.ycloud.com/en/documentation/developer/webhooks)
  especifica `YCloud-Signature: t={timestamp},s={signature}` e HMAC-SHA256
  sobre o timestamp, um ponto e o corpo bruto exato. O projeto deve também
  verificar janela temporal e deduplicar o evento persistido. Webhooks
  globais podem receber eventos de várias WABAs; assinatura válida sozinha
  não autoriza associar o evento a qualquer escritório.

Links antigos de referência e o endereço legado `openapi.json` não foram
suficientes para obtenção do contrato atual: houve redirecionamento à página
geral ou 404. O SDK oficial foi usado como evidência adicional do transporte,
sem instalar um SDK novo nem assumir aprovação comercial.

## Gupshup: não misturar modalidades

A [visão geral Bizgate](https://bizgate-docs.gupshup.io/docs/partner-api-overview)
organiza mensagens, modelos, mídia, assinaturas e faturamento por capacidade.
O [guia de início atual](https://bizgate-docs.gupshup.io/reference/getting-started)
descreve a base `https://partner.gupshup.io/partner/bizgate` e Universal Token.
Já há páginas antigas que descrevem partner token e app access token.

A página oficial [Send text message](https://bizgate-docs.gupshup.io/reference/sendtextmessage),
localizada pelo índice de pesquisa, descreve a operação
`/partner/bizgate/app/{appId}/messaging` com bearer UT e envelope Cloud API.
Entretanto, os links de endpoints em
[Messaging V3](https://bizgate-docs.gupshup.io/docs/messaging-v3) e
[Webhook Management](https://bizgate-docs.gupshup.io/docs/webhook-management)
retornaram 404 nesta consulta. Isso é uma divergência documental, não prova
de que um contrato específico esteja disponível para a conta do produto.

Antes de implementar ou expor o callback Gupshup, confirmar no portal a
modalidade contratada, os endpoints versionados, fixtures de entrada e a
autenticação efetivamente oferecida ao callback. Não reutilizar HMAC da Meta
ou da YCloud nem presumir uma assinatura Gupshup não documentada. Uma porta
sem adaptador registrado deve falhar explicitamente, sem recorrer à Meta.

## Pendências externas e decisões do produto

| Tema | Estado e condição de avanço |
| --- | --- |
| Onboarding YCloud | Comparar Embedded Signup e Partner Direct Link/TP Lite com documentação específica acessível e conta de parceiro; decisão ainda aberta. |
| Coexistência no celular | Prioridade e elegibilidade ainda a confirmar. Não remover o aplicativo ou exigir SIM novo automaticamente. |
| Cobrança | Pagamento por escritório ou centralizado ainda aberto. Nenhuma cobrança/recarga automática. |
| Credenciamento YCloud | Conta, permissões, canal de teste e autorização de uso real não verificados. |
| Credenciamento Gupshup | Modalidade Bizgate/Self Serve e contrato de callback a confirmar. |
| Entrada durável | Definir armazenamento e recuperação antes de habilitar um endpoint que confirme HTTP 2xx. Não escolher fila nova implicitamente. |
| Embedded Signup anterior | A base develop examinada não contém o incremento do outro repositório. Sua revisão/integração é tarefa separada; não copiar ambiente do Moacir. |

## Evidência necessária para conclusão

Fixtures e testes de contrato comprovam serialização, capacidades,
classificação de erros, namespaces e comportamento dos casos de uso sob
respostas controladas. Não comprovam credenciamento, entrega real, RLS no
Supabase, autorização de número ou coexistência.

Para WA-04/06/09: usar ambiente exclusivo do CRM-Advogado e duas contas reais
de homologação; exercitar autorização cancelada e repetida, conexão de outra
conta, texto, áudio/documento, modelo aprovado, status fora de ordem,
revogação e recuperação. Registrar o SHA exato. Habilitar somente o provedor
que cumprir seu aceite; não marcar todas as tarefas concluídas pelo teste
local do adaptador.
