# QA — preflight YCloud da própria conta

Data: 21/10/2026. Repositório CRM-Advogado/crm-advogado. Branch codex/ycloud-guided-onboarding, base ab2973d. Escopo final reduzido a diagnóstico de leitura da própria conta; não é onboarding delegado de clientes.

22 testes independentes em src/lib/whatsapp/ycloud-preflight-qa.test.ts passaram com dados fictícios e fetch substituído. Nenhuma API real, envio, cobrança, conexão de número, migration ou persistência foi executada pelo QA.

## Cobertura

- Rota exige administrador antes de consultar o fornecedor; acesso de outra conta e feature flag desligada não executam HTTP.
- Conta, chave, WABA e número vêm do servidor. Query forjada não substitui os seletores; seletores inválidos são recusados antes da rede.
- Somente GET em endpoints YCloud fixos, segmentos codificados, redirect recusado e cache desabilitado. Credencial vai no header e não no corpo/query/resultado.
- Identidades WABA, número e associação entre os recursos devem coincidir; recursos ausentes ficam aguardando autorização.
- CONNECTED e VERIFIED são necessários para resource_verified. Estado pendente, desconectado, não verificado ou ausente permanece awaiting_authorization.
- Respostas e erros externos não expõem a chave sintética; leitura de resposta é limitada a 64 KiB.
- Mesmo no resultado mais forte, coexistenceVerified, customerBindingVerified e operational continuam false; não existe connected:true.

O QA não identificou bug novo com reprodução vermelha neste recorte. Os testes já passaram após implementação/correções concorrentes, incluindo o gate de estado da linha, e não se alega RED observado.

## Limites

Esses testes provam autorização e contrato local com respostas controladas. Não comprovam acesso real à própria WABA, modalidade TP Lite, autorização delegada de cliente, propriedade comercial da conta, coexistência no mesmo número, callback HTTPS, recebimento durável YCloud, envio ou entrega. O estado resource_verified indica recursos visíveis e estados esperados pelo diagnóstico; não é uma conexão operacional do CRM.

A feature flag permanece desligada por padrão e a allowlist identifica somente a conta própria configurada no servidor. O recorte não cria sessão, conexão persistente, UI ou onboarding real. Credenciais nunca devem ser colocadas em testes, logs, URLs ou documentação.

Após congelamento: suíte completa passou com 1.062 testes em 89 arquivos, incluindo 22 casos independentes de QA e 18 novos do desenvolvimento. Typecheck e lint focado passaram. Lint completo passou com 0 erros e 38 avisos preexistentes. Build final é executado separadamente pelo coordenador.

Build de produção validado pelo coordenador com variáveis fictícias, sem serviços externos.
