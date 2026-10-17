# QA — arquitetura de provedores WhatsApp

Data: 15/10/2026. Repositório: CRM-Advogado/crm-advogado. Branch: codex/whatsapp-providers, baseada em origin/develop efdd4ce. Workspace isolado: C:\Users\Kelvi\.codex\visualizations\2026\10\16\01a14248-0c4c-79b1-9a06-14d1d47371a0\crm-advogado. Evidência referente ao diff de trabalho; hash final será o commit do PR.

## Método e baseline

QA independente do agente de desenvolvimento, com testes escritos em arquivos exclusivos e sem editar implementação. Guia Next.js local de Vitest e after consultado. Baseline: 78 arquivos e 851 testes passaram. Nenhuma credencial real, serviço externo, deploy ou banco de produção foi utilizado.

O ambiente sandbox impede rename no diretório temporário padrão do Vitest. Definir TEMP/TMP para uma pasta temporária dentro do workspace permitiu executar os testes sem alterar configuração da aplicação.

## Bugs e regressões

| Achado                                                             | Evidência antes                                                                           | Cobertura e resultado                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Status com mesmo ID externo afetava outra conta                    | Teste POST + callback after reproduziu conta B alterada para read pelo webhook da conta A | provider-qa.test.ts da rota: passou após resolver conexão e escopar leitura por conta                     |
| Status atrasado sent regredia mensagem read                        | Teste da rota falhou: estado final sent, esperado read                                    | Passou após transições monotônicas; inclui ausência de fanout para evento obsoleto                        |
| Corrida entre leitura e atualização podia perder read              | Revisão identificou CAS restrito ao estado lido                                           | Teste injeta avanço concorrente sent para delivered antes da atualização; estado final read, passou       |
| Download de mídia podia seguir redirect após allowlist inicial     | Teste com URL inicial aprovada e transporte simulando redirect resolveu bytes indevidos   | Passou após política de redirect que rejeita redirecionamento                                             |
| Código Meta 131030 precisava permanecer disponível ao retry legado | Revisão observou que detalhes sem código quebrariam classificador de telefone             | Teste preserva código mesmo com mensagem genérica; passou                                                 |
| Resposta 2xx sem ID externo não comprova envio rastreável          | Inspeção dos transportes legados; sem reprodução red registrada pelo QA                   | Três casos (JSON inválido, objeto vazio, ID vazio) passam exigindo erro incerto, sem repetição automática |
| CI não abrangia develop                                            | Workflow baseline só incluía main                                                         | Teste interpreta YAML e exige main/develop em push e pull_request; passou após correção                   |
| Lockfile incompleto impedia instalação limpa                       | npm ci falhou antes e passou após correção pelo coordenador                               | Instalação limpa e pipeline continuam sendo a verificação de integração desse caso                        |

| Retry por variante de telefone podia repetir envio incerto cujo código era 131030 | Dois regressivos falharam: 500/429 autorizavam retry | Novo classificador rejeita ambos; dois testes do envio de conversa real confirmam somente uma chamada HTTP |

## Matriz independente

- Referências externas preservam namespace conta, provedor e conexão; valores vazios são rejeitados.
- Resolução rejeita outra conta antes de instanciar transporte; provedor indisponível não cai em Meta.
- Reply e referências de mídia de outra conexão são rejeitados antes de rede.
- Identidade e credenciais são copiadas; mutação posterior não retargeta o adapter.
- Payload de texto e reply mantêm formato Meta; retorno inclui namespace.
- 401/403 são rejeições; 429 é retryable; 5xx em envio e timeout são incertos; nenhuma repetição automática.
- Erros não expõem token sintético.
- Porta fake YCloud substitui transporte sem rede; capability não suportada falha antes de send.
- Adapter retornando referência de outra conexão resulta em erro incerto.
- Webhook preserva isolamento da conta e impede regressão/replay de estado.

## Validação e limites

Execução intermediária após migração: 80 arquivos e 876 testes passaram. Após congelamento final: 81 arquivos e 891 testes passaram. QA independente: 27 casos de contrato/callers/CI e 4 de webhook. Typecheck passou. Lint final: 0 erros; 38 avisos após remover aviso transitório de variável não usada no teste QA. Build de produção Next.js 16.2.12 com Turbopack passou no coordenador, incluindo compilação, TypeScript e 62 páginas, com configuração fictícia e sem acessar serviços externos.

Os testes usam respostas sintéticas e doubles do banco. Não comprovam permissões de fornecedores, conformidade dos payloads em contas reais, políticas RLS, migrations aplicadas, comportamento de hospedagem, callbacks externos ou onboarding comercial. Schema legado continua com uma conexão Meta por conta; namespace no contrato não habilita multiconexão no banco. YCloud/Gupshup não devem ser ativados sem adapter, contrato e homologação próprios.

Leituras iniciais no repositório do Moacir foram descartadas do escopo desta entrega. Não são evidência de bugs corrigidos ou presentes neste checkout.
