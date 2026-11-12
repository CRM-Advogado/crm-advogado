# QA — ecos de coexistência YCloud

Data: 16/10/2026. Repositório CRM-Advogado/crm-advogado. Branch codex/ycloud-coexistence-echoes, base origin/develop 8fb566e. Escopo: normalização local do evento whatsapp.smb.message.echoes, sem conectar número, ativar fornecedor, criar endpoint ou persistência.

## Evidências e cobertura independente

20 testes próprios em src/lib/whatsapp/ycloud-coexistence-qa.test.ts passaram. A estrutura da fixture foi conferida na documentação primária YCloud, consultada via Context7: [eventos com BSUID](https://docs.ycloud.com/reference/webhook-updates-bsuid) e [exemplos de sincronização do aplicativo](https://docs.ycloud.com/reference/whatsapp-business-app-sent-message-sync-webhook-examples). Links legados diretos podem redirecionar à visão geral; os resultados da consulta de documentação forneceram o envelope completo whatsappMessage.

- Eco do aplicativo recebe kind outbound_echo e source business_app, distintos de inbound e delivery.
- Conta/conexão vêm do argumento autorizado no servidor; campos conflitantes no JSON não escolhem outra identidade.
- Remetente empresarial e WABA devem corresponder ao binding; direção invertida e conexão de outro provedor são rejeitadas.
- Evento, recurso YCloud e wamid permanecem separados. Reply context preserva o wamid do alvo separadamente.
- Mesma entrega produz identidade determinística; mesma identidade externa em outra conta/conexão fica em namespace distinto.
- Campos obrigatórios e valores explicitamente vazios são rejeitados.
- Conteúdo não suportado é marcado explicitamente e grupos são ignorados no recorte atual.
- Imagem vira metadados de mídia; nenhuma chamada HTTP ou credencial é enviada ao link.

Nenhum bug novo foi identificado pelo QA independente neste incremento. Os casos foram executados já com a implementação disponível e passaram; não se alega reprodução vermelha anterior.

## Limites e aceite local

Esses testes comprovam classificação e normalização com dados sintéticos. Não comprovam gravação de mensagem, deduplicação persistente, contador unread, pausa de automação ou correlação com envios já gravados. O evento distinto permite que um futuro consumidor trate intervenção humana sem encaminhá-la ao fluxo de entrada do cliente; nenhum consumidor foi ligado nesta entrega.

Não foi habilitado callback, ack HTTP 2xx, worker, fila, registro do fornecedor, migração ou conexão real. Histórico e grupos continuam fora do escopo. Coexistência no mesmo número continua dependendo de credenciamento, elegibilidade, onboarding, persistência e homologação com app/CRM reais.

Após congelamento, suíte completa passou com 84 arquivos e 998 testes; typecheck passou. Lint final passou com 0 erros e 38 avisos preexistentes. Build de produção passou no coordenador, com compilação, TypeScript e 62 páginas. QA aprova o candidato local para revisão e commit, mantendo as limitações descritas.
