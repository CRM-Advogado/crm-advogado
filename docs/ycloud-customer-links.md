# Primeira identidade local YCloud e correlação de evidência

Candidato local de WA-03/WA-04 sobre o ledger 046. A migration 047 e as rotas não emitem links YCloud, não fazem chamadas ao fornecedor, não registram números e não habilitam mensagens. A flag `YCLOUD_CUSTOMER_LINK_ENABLED` continua desligada por padrão. Não aplicar a migration em ambiente externo sem validação e aprovação correspondentes.

## O que é persistido

Para cada conta e namespace de endpoint, uma reserva cria atomicamente uma identidade opaca aleatória, estável e imutável, e uma única sessão local. O identificador de parceiro não é o ID da conta nem o ID da sessão. Nenhum deles pode ser escolhido pelo navegador. O namespace vem de `YCLOUD_WEBHOOK_ENDPOINT_NAMESPACE`, o mesmo do receptor 046. A sessão dura duas horas fixas e registra o ator solicitante. Não contém URL, token, API key ou telefone.

Repetir a reserva enquanto ativa retorna a mesma sessão, sem estender prazo. Expiração exige revisão manual; não há renovação, segunda sessão, cancelamento/reabertura, exclusão ou reatribuição de identidade neste incremento. O mapeamento e eventual claim de WABA não são liberados por remoção da conta, expiração ou revisão manual. Uma futura recuperação precisa de contrato explícito e não pode reaproveitar automaticamente a evidência antiga.

## Rotas autenticadas

- `GET /api/whatsapp/ycloud/onboarding`: status seguro da conta atual.
- `POST /api/whatsapp/ycloud/onboarding`: reserva do primeiro ciclo local.
- `POST /api/whatsapp/ycloud/onboarding/reconcile`: correlação conservadora com evidência já aceita no ledger.

Todas exigem admin/owner e respondem com `Cache-Control: no-store`. As mutações exigem Origin exatamente igual à origem canônica configurada em `NEXT_PUBLIC_SITE_URL`, HTTPS (HTTP somente localhost), e recusam `Sec-Fetch-Site` cross-site. Não há fallback para Host ou cabeçalhos encaminhados. Nenhum corpo de mutação é aceito; query strings não selecionam conta, WABA, namespace ou identidade. Credenciais e seletores do fornecedor são exclusivamente do servidor.

Cada RPC service-only verifica novamente o papel atual do ator em `profiles`, sob lock compartilhado. IDs de conta/ator do RPC são contexto confiável do servidor, não entrada do navegador. Tabelas têm RLS sem políticas de leitura/escrita para anon/authenticated e sem escrita direta para service_role. A API retorna apenas status, ID da sessão e expiração; nunca WABA, partnerCustomerId, namespace ou evento.

## O que `evidence_matched` significa

A reconciliação exige identidade local prévia, namespace exato e exatamente um evento do ledger para aquela identidade. A chegada da evidência deve estar dentro da janela local e a primeira correlação precisa ocorrer antes da expiração. Conta sem reserva falha; evidência de outra identidade/namespace não participa. Múltiplos eventos, inclusive contradições fora da janela, ou conflito de WABA levam a `manual_review`. A consulta GET também revalida um candidato contra o ledger atual: evidência posterior contraditória resulta em `manual_review` mesmo antes de nova reconciliação, preservando a claim original. A unicidade namespace/WABA e namespace/evento impede atribuir a mesma evidência ou claim a duas contas.

`evidence_matched` identifica uma evidência assinada de WABA correspondente à identidade local estável. **Não prova que aquela sessão de autorização foi concluída.** O evento do fornecedor não traz ID da tentativa. `received_at` é horário local de chegada, não horário de criação no fornecedor; filtrar essa data não torna um evento antigo novo. A restrição ao primeiro ciclo com identidade imprevisível nunca reutilizada é deliberada. A sessão não recebe estado completed, e o resultado nunca autoriza conexão, número ou envio. Se a evidência já foi correlacionada, a consulta preserva o resultado após o prazo; uma reserva após expiração continua recusada.

`operational` e `coexistenceVerified` são sempre false. `paymentMethodAttached` não comprova coexistência e não é critério para habilitar operação. Não existe seleção de número nem substituição da configuração Meta.

## Pendências externas e próximas etapas

O emissor futuro de links deverá usar a identidade reservada exclusivamente no servidor, respeitar as condições do TP Lite e registrar a emissão efetiva. Depois ainda faltam confirmação do número, coexistência, integração dos IDs de mensagens, ingresso durável de mensagens YCloud e QA real A/B. Uma landing page ou habilitação de parceria não comprova essas etapas. A aplicação externa de migrations, ativação, credenciais e qualquer envio permanecem separados.

Fontes: [TP Lite](https://docs.ycloud.com/en/partner-center/technical-development-partners/partner-direct-link-tp-lite), [evidência durável local](ycloud-onboarding-evidence.md). Os testes deste incremento usam dados fictícios e PostgreSQL descartável local.
