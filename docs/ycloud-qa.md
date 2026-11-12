# QA — adapter YCloud isolado

Data: 15/10/2026. Repositório CRM-Advogado/crm-advogado. Branch codex/ycloud-adapter, base 363a417 (arquitetura/Meta, PR #3). Testes independentes do desenvolvimento em src/lib/whatsapp/ycloud-qa.test.ts. Validação somente local com fixtures e transporte substituído; nenhum número, segredo ou serviço real.

## Contrato verificado

A documentação primária de [webhooks YCloud](https://docs.ycloud.com/en/documentation/developer/webhooks) descreve cabeçalho t/s e HMAC-SHA256 sobre timestamp, ponto e corpo bruto. Também informa que webhooks globais podem receber eventos de várias WABAs, portanto assinatura válida não dispensa vínculo autorizado do número com a conta. Janela temporal de 300 segundos é política local de proteção contra replay.

O [modelo oficial de mensagem](https://github.com/YCloud-Developers/ycloud-sdk-node/blob/main/models/whatsapp-message.ts) distingue ID YCloud e wamid; os dois identificadores precisam permanecer separados para correlação e replies/reactions.

## Matriz prevista

- Número remetente E164 definido no servidor e copiado ao criar o adapter; destinatário inválido rejeitado antes de rede.
- API key somente no cabeçalho; requisição sendDirectly; nenhuma repetição ou fallback automático.
- ID YCloud diferente de wamid preservado; replies e reactions exigem a identidade WhatsApp correta e a mesma conta/conexão.
- HMAC verifica bytes exatos, comprimento e formato hexadecimal, timestamp inteiro e janela simétrica de 300 segundos; campos t/s duplicados ou segredo ausente rejeitados.
- Normalização valida envelope documentado, timestamp, binding número/WABA e namespace conta/provedor/conexão/evento.
- accepted permanece distinto de sent/delivered; dados sem IDs ou com formatos inesperados falham explicitamente.
- 401/403 rejeitados, 429 retryable, falhas de transporte/5xx em envio incertas sem repetição automática.

## Resultado

48 testes independentes locais passaram no arquivo ycloud-qa.test.ts. O QA reproduziu uma falha antes da correção: createTime 2026-02-31T22:00:00Z era aceito por normalização permissiva de Date.parse. Após validação de calendário e relógio, o teste passou. Casos adicionais incluem ano não bissexto, dia inexistente, hora 24, minuto 60, data bissexta válida e offset explícito.

Dois riscos de revisão receberam testes já verdes após correções concorrentes do desenvolvimento: código de erro externo que reproduzisse uma API key fictícia em maiúsculas e exceção JSON com fragmento do corpo privado. O QA não registrou execução vermelha desses dois casos; sua origem é revisão estática. Casos de falha 401/429/500 e status failed em resposta 2xx verificam que mensagem/código não incluem a chave sintética.

A verificação HMAC aceita bytes UTF8 exatos, rejeita alterações de whitespace, campos t/s duplicados, formato numérico ambíguo, assinatura inválida, segredo ausente e timestamp fora de mais ou menos 300 segundos. Janela temporal reduz replay; não constitui deduplicação persistente. Eventos iguais preservam namespace conta/provedor/conexão, mas o chamador ainda precisa persistir o identificador para idempotência durável.

Após congelamento: suíte completa com 83 arquivos e 971 testes passou; typecheck passou. Lint passou com 0 erros e 38 avisos preexistentes. Build final passou no coordenador: Next.js 16.2.12 com Turbopack, compilação, TypeScript e 62 páginas. QA libera o candidato local para revisão e commit; homologação externa permanece pendente. Adapter isolado não representa ativação de fornecedor, homologação externa, entrada durável, onboarding, coexistência ou aprovação de produção. Nenhum endpoint HTTP ou confirmação HTTP 2xx foi criado. Consulta de histórico, administração de modelos, normalização de eventos de histórico/modelos e download autenticado de mídia não foram habilitados. Referências de mídia recebidas são somente metadados.
