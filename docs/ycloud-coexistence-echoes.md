# YCloud — normalização de envios do aplicativo WhatsApp Business

Data: 16/10/2026. Incremento isolado sobre `origin/develop` em `8fb566e`.
O usuário confirmou coexistência obrigatória entre aplicativo WhatsApp Business
e CRM no mesmo número, inicialmente para advogado individual.

## Contrato implementado com fixtures

O normalizador YCloud reconhece `whatsapp.smb.message.echoes`, documentado como
mensagem enviada pela empresa usando o aplicativo WhatsApp Business ou um
companion compatível. O payload documentado usa `whatsappMessage`, com recurso
`id`, `wamid`, número de origem/destino, WABA, tipo e conteúdo.

Esse evento produz `kind: outbound_echo` e `source: business_app`, mantendo
conta/conexão/provedor nas referências e preservando conteúdo, números e os
identificadores separados. O `context.message_id`, quando presente, permanece
como `replyToTransportMessageId`: é um `wamid`, não um ID de recurso YCloud.

A origem precisa corresponder ao número da empresa e a WABA ao vínculo de
servidor. Não usar a direção invertida de um inbound do cliente. O corpo deve
estar autenticado antes de entrar no normalizador, seguindo o verificador
HMAC existente; a normalização não substitui autenticação ou autorização.

Texto e metadados de mídia são cobertos por fixtures derivadas da estrutura
oficial, usando dados sintéticos. O conteúdo usa o mesmo contrato normalizado
já existente; tipos ainda não cobertos permanecem explicitamente não suportados.
URLs são apenas metadados: a função não faz download, envia resposta ou dispara
motor de automação/IA. Grupos e identidades sem números E.164 continuam fora do
recorte. Eventos da família `whatsapp.echo_message.*` de outros produtos não
são tratados como sinônimos do evento SMB do aplicativo.

## Regras para a futura integração

- Não tratar echo como inbound de cliente, nem incrementar unread ou disparar
  gatilhos de entrada/bots por causa dele.
- Correlacionar recurso e `wamid` dentro da conta/conexão, incluindo quando o
  mesmo envio aparece em outro canal de sincronização. Referência estável não
  executa deduplicação: persistência e ledger continuam necessários.
- Definir e homologar a intervenção humana pelo aplicativo e a pausa coerente
  das automações, sem disparar uma resposta automática para o próprio envio.
- Não interpretar este evento como histórico retroativo ou garantia de entrega.

Este incremento não implementa essas regras no banco ou nos motores. Não há
endpoint, ativação, onboarding, migração, assinatura real de número, replay
persistente ou pausa efetiva. Portanto ele prepara um contrato necessário à
coexistência, mas não entrega coexistência operacional completa. Retenção,
durabilidade e homologação exclusiva continuam pendentes de alinhamento.

## Fontes e verificação

A estrutura foi consultada no índice documental Context7 da referência YCloud,
nas fontes primárias [atualizações de webhook](https://docs.ycloud.com/reference/webhook-updates-bsuid)
e [payloads de eventos](https://docs.ycloud.com/reference/webhook-events-payloads).
Os exemplos incluem texto com contexto e mídia com `link`, `id` e `mime_type`.
Alguns links legados redirecionam à página geral quando abertos diretamente;
isso não substitui credenciamento e homologação com o aplicativo real.

Testes de desenvolvimento e QA independente verificam classificação distinta,
direção, vínculo WABA, referências por conexão, preservação de IDs/contexto,
conteúdo e replay determinístico. Nenhuma chamada real ou teste de unread,
pausa de bot, banco ou entrega é alegado por essas fixtures.
