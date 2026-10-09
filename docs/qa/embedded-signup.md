# QA do Embedded Signup no produto — 09/10/2026

## Escopo e parecer

Port seletivo para CRM-Advogado/crm-advogado, branch codex/embedded-signup baseada em develop efdd4ce, sem alterar repositório ou serviços do Moacir. Parecer favorável à revisão do código em develop com META_EMBEDDED_SIGNUP_ENABLED=false. Não é aprovação de piloto com dados reais ou habilitação em produção.

## Evidências locais

| Verificação | Resultado |
| --- | --- |
| Vitest completo | 920 testes em 82 arquivos aprovados |
| Embedded Signup | 69 testes: parsing/origens/configuração, Graph simulada, autorização/API e PostgreSQL local PGlite |
| TypeScript | typecheck aprovado após correção de fechamento JSX na inserção do cartão |
| ESLint completo | zero erros, 38 avisos herdados; arquivos novos sem avisos |
| Build Next 16.2.12 | aprovado; 63 páginas geradas, sem página temporária de QA |
| Lockfile | npm ci --dry-run aprovado; entrada ausente de @swc/helpers corrigida em commit próprio |
| Interface real no Edge | componente em página temporária com NextIntl e CSS do produto; API e SDK simulados |

QA da interface: estado indisponível, PIN mascarado com zero inicial, preparação e clique direto para abrir Meta, sucesso com uma única gravação mesmo após FINISH duplicado, CANCEL sem callback libera nova tentativa e não grava. Mobile 390×844 e desktop 1280×800 sem overflow horizontal; capturas inspecionadas. Capturas e scripts em output/playwright ignorados pelo Git. Não houve avaliação com advogados, leitor de tela ou popup externo real.

Um primeiro acesso por 127.0.0.1 foi bloqueado pela proteção de origem do servidor Next dev; o teste continuou em localhost, sem alterar configuração de produção. O primeiro build encontrou erro de sintaxe introduzido ao formatar a inserção do cartão; foi corrigido, seguido de typecheck, lint dos arquivos alterados e build aprovados. Nenhum teste falhou na suíte Vitest.

## Limites

O teste SQL usa esquema mínimo local, não o catálogo integral importado na homologação. Não valida RLS/grants reais do Supabase, login real, isolamento de todas as entidades UI/REST/Storage, SMTP, OAuth Meta, propriedade real de ativos, registro, envio/recebimento ou revogação. A coexistência com WhatsApp Business no celular não está implementada. A concorrência com a rota manual legada requer validação adicional.

Nenhuma migration foi aplicada remotamente, nenhum segredo foi copiado, nenhuma configuração Meta/webhook foi alterada e nenhum dado real foi usado. O baseline importado não tem histórico reconciliado; os 46 avisos relatados permanecem pendentes. Ver [reconciliação e critérios de liberação](../homologacao-e-migracoes.md) e [configuração do fluxo](../embedded-signup.md).

## Próxima validação

Reconciliar baseline em banco descartável, corrigir permissões/buckets com testes allow/deny, testar login e isolamento A/B real, aplicar 055 apenas no novo destino validado, configurar app Meta próprio e concluir ciclo real de autorização + envio/recebimento em homologação. Registrar essas evidências antes de aprovar piloto ou promover para main.
