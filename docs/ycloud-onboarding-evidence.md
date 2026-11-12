# Evidência durável de onboarding YCloud — candidato local

Recorte de WA-04 e SEC-IMP-07. A arquitetura e o adaptador isolado já estão em develop; o ingresso durável Meta da migration 045 não recebe YCloud. Este incremento registra apenas a evidência autenticada `whatsapp.business_account.updated/PARTNER_ADDED` antes de confirmar recebimento. Não conclui WA-04/WA-05 nem a homologação.

## Contrato

`POST /api/whatsapp/ycloud/webhook` fica desativado por padrão (404). A flag de servidor `YCLOUD_ONBOARDING_EVIDENCE_ENABLED=true` exige `YCLOUD_WEBHOOK_SECRET` e um namespace imutável do endpoint em `YCLOUD_WEBHOOK_ENDPOINT_NAMESPACE`. O namespace nunca vem da URL, query, corpo ou cabeçalhos do cliente. Segredo de endpoint não é API key. A integração não faz chamadas externas.

O corpo é limitado durante streaming a 1 MiB e decodificado com UTF-8 estrito, preservando os bytes válidos para HMAC. A assinatura é validada antes do JSON, com a janela de timestamp existente de 300 segundos. Corpo inválido é recusado; eventos e updates fora do recorte retornam 422, sem ACK de sucesso. Configure exclusivamente a subscrição `whatsapp.business_account.updated`; mesmo nessa família, outros updates permanecem deliberadamente não suportados e podem causar reentregas. Este endpoint não deve receber mensagens, status, ecos ou callbacks de outros produtos.

Depois da assinatura, o receptor exige apiVersion v2, identidade do evento limitada, WABA numérica, partnerCustomerId opaco limitado e paymentMethodAttached booleano. O RPC transacional `record_ycloud_onboarding_evidence` mantém somente namespace, ID/tipo/update, WABA, identificador opaco do cliente parceiro, indicador de crédito, SHA256 do corpo original e horário local de recebimento. Não persiste raw payload, assinatura, chave, telefone, conteúdo de mensagens, URL de onboarding ou IDs de conta recebidos no JSON.

Um replay idêntico mantém a linha original e retorna duplicate=true. A mesma identidade namespace/evento com digest ou evidência diferente gera 409; erro/retorno ambíguo de banco gera 503. A resposta de sucesso só acontece depois da confirmação transacional. Namespaces distintos são independentes. Mudança de namespace ou remoção do ledger perde a memória de deduplicação: não usar isso como rollback. Mantenha o namespace estável, e para interromper ingressos desative a flag sem apagar evidências.

## Limite de confiança

A migration 046 é local, aditiva e idempotente. A tabela tem RLS sem políticas para clientes e privilégios negados a anon/authenticated. Somente service_role lê o ledger e executa o RPC; o papel não recebe escrita direta. Não há interface/API de consulta pública.

Evidência assinada não é autorização automática de um tenant CRM: o evento pode chegar sem sessão local conhecida. Não há associação por account_id, configuração de número, status connected nem envio habilitado. `operational` sempre false. A etapa futura deverá reconciliar partnerCustomerId contra sessão criada pelo servidor e confirmar WABA/número elegíveis; não confiar em redirect, chave global ou campos livres do navegador. paymentMethodAttached indica condição de crédito do fornecedor, não comprova coexistência.

O ledger mínimo permanece até definição da política de retenção e reconciliação. Não existe worker, replay de efeitos, remoção automática ou perda silenciosa de pendências neste recorte. Uma implantação futura precisa validar capacidade, monitoramento, RLS, schema e política de retenção antes de habilitar. Nenhuma migration foi aplicada em banco externo, webhook cadastrado, recurso ativado ou crédito consumido.

## Fontes verificadas

- [Partner Direct Link TP Lite](https://docs.ycloud.com/en/partner-center/technical-development-partners/partner-direct-link-tp-lite): habilitação e evento PARTNER_ADDED com partnerCustomerId.
- [Configuração de webhooks](https://docs.ycloud.com/en/api-reference/guides/api-fundamentals/configure-webhooks): corpo original, segredo de endpoint, autenticação e entregas repetidas.
- [Implementação do receptor](https://docs.ycloud.com/en/api-reference/guides/api-fundamentals/implement-a-webhook-receiver): HMAC, persistência antes do ACK e limites de reentrega/suspensão. Respostas 422 são falhas de entrega para o fornecedor, não filas permanentes: não habilitar este recorte como receptor geral.

Testes com fixtures e PostgreSQL local não comprovam onboarding real ou operação do CRM.
