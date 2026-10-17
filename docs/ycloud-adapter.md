# Adaptador YCloud — contrato local e limites

Tarefa WA-05, incremento técnico parcial sobre a base WA-01/WA-02. Consulta documental:
15/10/2026. Depende da arquitetura do PR de base, sem exigir uma decisão de
onboarding para exercitar o adaptador com fixtures.

## Implementação

`providers/ycloud.ts` implementa a porta neutra de mensagens. A fábrica recebe
identidade da conexão, API key privada e remetente E.164 com `+`, preserva uma
cópia e usa `POST https://api.ycloud.com/v2/whatsapp/messages/sendDirectly` com
`X-API-Key`. O destinatário também deve estar normalizado em E.164.

Texto, imagem, vídeo, documento, áudio, modelo aprovado, botões, lista e reação
são serializados conforme os modelos oficiais. Áudio não leva legenda/nome;
documento pode levar ambos. Enviar modelo aprovado não cria nem aprova modelos.
Download de mídia, administração de modelos e onboarding estão desabilitados.

Não há instalação de SDK, consulta ao banco, variável global de credencial,
seletor, endpoint ou migration. O adaptador não está registrado no resolver da
configuração Meta existente. Testes usam HTTP simulado; não há ativação real.

## Identificadores e alvos

| Campo interno              | Meta existente                     | YCloud                     |
| -------------------------- | ---------------------------------- | -------------------------- |
| `ProviderExternalId.value` | `wamid` legado                     | ID do recurso YCloud, `id` |
| `transportMessageId`       | Desnecessário para compatibilidade | `wamid`, quando retornado  |

As referências incluem conta, conexão e provedor. `sendOutbound` preserva ambos
os IDs. Um recurso YCloud sem `wamid` pode ter sido aceito, mas ainda não pode
ser alvo de resposta ou reação. `messageTarget` exige o ID da rede WhatsApp e
nunca usa o recurso YCloud como substituto. Para Meta, o alvo continua `value`.
Referências de mídia são independentes dos alvos de mensagem.

Antes de uma integração com o banco, persistir os dois IDs e a conexão. Não
gravar `id` YCloud no campo legado `whatsapp_message_id` presumindo ser `wamid`.

## Falhas

| Situação                                                             | Resultado                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| HTTP 401/403 e demais 4xx, exceto 429                                | Rejeitado                                                          |
| HTTP 429                                                             | Passível de nova tentativa pelo chamador, sem repetição automática |
| HTTP 5xx, timeout, conexão interrompida, JSON 2xx inválido ou sem ID | Incerto: pode ter sido aceito; não repetir cegamente               |
| Recurso 2xx explicitamente `status: failed`                          | Rejeitado, com código interno estável                              |
| Recurso com ID e sem `wamid`                                         | Aceitação válida, aguardando correlação para resposta/reação       |

Há timeout de 15 segundos, cache desabilitado e redirects recusados. Erros não
refletem corpo, descrição ou código arbitrário do fornecedor, que podem conter
conteúdo privado ou uma chave ecoada. Não há retentativa da Meta por variante de
telefone, failover, reconciliação automática ou garantia de idempotência de envio.

## Entrada autenticada com fixtures

`verifyYCloudWebhookSignature` verifica HMAC-SHA256 sobre os bytes exatos de
`timestamp + '.' + rawBody` usando segredo do endpoint e header
`YCloud-Signature: t=...,s=...`. Usa comparação em tempo constante e janela de
300 segundos, configurável para testes. Segredo ausente, header malformado,
campos duplicados, digest inválido e timestamp fora da janela falham. API key
e segredo de webhook são credenciais distintas.

`normalizeYCloudWebhook` recebe JSON **já autenticado**, conexão e vínculo
número/WABA de configuração do servidor; o JSON não escolhe a conta. Valida
versão, calendário e horário RFC3339, WABA e direção do número. Erro de JSON
tem mensagem estável, sem expor trechos do corpo em logs.

- `whatsapp.message.updated`: preserva `accepted`, `sent`, `delivered`, `read`
  e `failed` como estados distintos e conserva recurso e `wamid` separado.
- `whatsapp.inbound_message.received`: normaliza texto, metadados de mídia,
  escolhas de botões/lista e reação. URLs de mídia são apenas dados: nenhuma
  requisição ou credencial é enviada a elas. Outros conteúdos são marcados
  explicitamente como não suportados.
- Outros eventos, incluindo SMB/echo, e grupos não são processados. BSUID
  fica fora do público inicial de chats individuais com números E.164.

Evento e mensagem têm referências separadas. O evento preserva sua identidade
para deduplicação futura, mas estas funções não persistem, deduplicam ou
confirmam recebimento. Assinatura válida não substitui vínculo com número/WABA.

Não existe rota HTTP YCloud. Uma rota depende de aceitação durável,
deduplicação e recuperação antes de responder 2xx, além de vínculo autorizado
com uma conta. Credenciamento, onboarding TP Lite/Embedded Signup, coexistência,
cobrança, entrega real, armazenamento dos IDs e RLS permanecem pendentes. Fixtures
não concluem toda a WA-05 nem autorizam ativação comercial.

## Fontes primárias

- [API de mensagens do SDK oficial](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/apis/whatsapp-messages-api.ts),
  [requisição](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/models/whatsapp-message-send-request.ts)
  e [resposta](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/models/whatsapp-message.ts).
- [Contexto de resposta](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/models/whatsapp-message-context.ts)
  e [reação](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/models/whatsapp-message-reaction.ts), ambos usam `wamid`.
- [Mídia](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/models/whatsapp-message-media.ts),
  [interação](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/models/whatsapp-message-interactive.ts)
  e [mensagem recebida](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/models/whatsapp-inbound-message.ts).
- [Assinatura de webhook](https://docs.ycloud.com/en/documentation/developer/webhooks)
  e [schemas de eventos](https://docs.ycloud.com/en/api-reference/webhooks/test-webhooks).
  A referência do receptor orienta 2xx somente após autenticar e aceitar o evento duravelmente.
