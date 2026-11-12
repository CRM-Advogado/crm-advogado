# Diagnóstico da conta própria YCloud

Este incremento permite conferir, pelo servidor, se uma WABA e um número esperados estão acessíveis pela chave da conta própria. Não conecta o CRM, não cria vínculo, não muda `whatsapp_config`, não cadastra número e não envia mensagens. O diagnóstico fica desativado por padrão. Não é o onboarding delegado de novos clientes.

## Contrato

`GET /api/whatsapp/ycloud/preflight` exige sessão CRM de proprietário ou administrador. O servidor compara a conta autenticada com **uma única conta explicitamente autorizada** em `YCLOUD_OWN_ACCOUNT_ID`. Nenhum ID, telefone ou chave recebido por query string/browser seleciona recursos. A chave fica apenas em `YCLOUD_API_KEY`; nunca usar variável `NEXT_PUBLIC_*`.

Configuração exclusivamente de servidor:

- `YCLOUD_OWN_ACCOUNT_PREFLIGHT_ENABLED=true` libera o diagnóstico; ausente/false mantém 404.
- `YCLOUD_OWN_ACCOUNT_ID`: conta CRM própria autorizada.
- `YCLOUD_API_KEY`: chave privada da conta YCloud própria.
- `YCLOUD_OWN_WABA_ID`: WABA esperada.
- `YCLOUD_OWN_PHONE_NUMBER`: número esperado em E.164, com `+`.

Não inserir esses valores reais no repositório. Não habilitar enquanto faltarem número/WABA elegíveis. A validação local usa respostas simuladas; não exige preencher credenciais reais. A rota não realiza chamadas externas enquanto desativada ou para contas fora da autorização.

Com a liberação explícita, faz apenas dois GETs documentados: `/v2/whatsapp/businessAccounts/{id}` e `/v2/whatsapp/phoneNumbers/{wabaId}/{phoneNumber}`. Usa caminhos fixos, seletores codificados, timeout, `no-store`, proibição de redirects e resposta limitada a 64 KiB. Não faz retry automático e não retorna corpos/erros brutos do fornecedor.

`awaiting_authorization` significa que um recurso retornou 404. Isso não identifica a causa: recurso ausente, ainda não compartilhado ou seletor incorreto. `resource_verified` significa que o servidor leu WABA e número, confirmou os IDs/telefone esperados e observou `status=CONNECTED` e `codeVerificationStatus=VERIFIED`. Se os IDs conferirem mas esses estados estiverem ausentes ou diferentes, retorna `awaiting_authorization` com `resourcesVerified=true`; isso não infere a causa nem a elegibilidade para coexistência. Falhas de autenticação, indisponibilidade, JSON inválido ou recursos divergentes são erros explícitos; não viram sucesso.

Os campos `coexistenceVerified`, `customerBindingVerified` e `operational` são sempre `false`. O GET publicado não fornece prova de coexistência nem `partnerCustomerId`. Status de telefone `CONNECTED` e `paymentMethodAttached` não substituem essas provas. Não existe persistência de conexão nem habilitação de envio após o diagnóstico.

## Próximos gates

O usuário ainda precisa preparar seu WhatsApp Business App e site/identidade empresarial para verificar a elegibilidade no fornecedor. Testar sua conta no console é diferente de habilitar o TP Lite para novos clientes. A coexistência App + CRM no mesmo número continua obrigatória.

Para onboarding delegado, a habilitação TP Lite, domínio/HTTPS e autorização do parceiro permanecem pendentes. O evento autenticado `whatsapp.business_account.updated/PARTNER_ADDED` documenta `partnerCustomerId`; os GETs de recursos não documentam esse campo. Será necessário guardar a evidência autenticada antes do ACK e reconciliar com WABA/telefone selecionados pelo servidor. Redirect, frontend e um simples GET com chave global não autorizam associação entre clientes. Nenhuma sessão, migração, webhook ou associação nova foi introduzida neste recorte.

Antes de uso operacional ainda faltam binding persistente autorizado, ingresso YCloud durável, resolução de provider no runtime, teste real de coexistência/echo e homologação de envio/recebimento. Este diagnóstico não comprova esses itens.

## Fontes primárias verificadas em 21/10/2026

- [API oficial de números (SDK gerado)](https://raw.githubusercontent.com/YCloud-Developers/ycloud-sdk-node/main/apis/whatsapp-phone-numbers-api.ts)
- [Modelo oficial de número](https://raw.githubusercontent.com/YCloud-Developers/ycloud-sdk-node/main/models/whatsapp-phone-number.ts)
- [API oficial WABA](https://raw.githubusercontent.com/YCloud-Developers/ycloud-sdk-node/main/apis/whatsapp-business-accounts-api.ts)
- [Modelo oficial WABA](https://raw.githubusercontent.com/YCloud-Developers/ycloud-sdk-node/main/models/whatsapp-business-account.ts)
- [Partner Direct Link TP Lite](https://docs.ycloud.com/en/partner-center/technical-development-partners/partner-direct-link-tp-lite)
