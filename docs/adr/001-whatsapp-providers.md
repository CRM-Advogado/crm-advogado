# ADR 001 — Portas de integração WhatsApp

Estado: aceito para implementação incremental (WA-01/WA-02).
Base: `origin/develop`, CRM-Advogado/crm-advogado. O ambiente do Moacir é separado.

## Contexto

O CRM integra diretamente a Cloud API da Meta em vários caminhos de envio.
YCloud é o primeiro provedor planejado; Gupshup é o segundo. Uma interface
que exponha `phone_number_id`, access token ou DTOs da Meta aos casos de uso
apenas muda o nome do acoplamento. Não adotaremos uma reescrita do monólito.

## Decisão

Manter monólito modular e introduzir portas pequenas no módulo WhatsApp.
O domínio contém mensagens, capacidades, referências externas e erros,
sem dependências de Next.js, Supabase ou DTOs dos fornecedores. Adaptadores
traduzem essas mensagens e resultados para cada API.

Uma conexão tem identidade `(accountId, connectionId, provider)`. Toda
referência externa inclui essa identidade e o identificador opaco do
fornecedor. IDs não são comparados apenas pelo valor nem construídos
concatenando campos com separadores. Referências de resposta/reação devem
pertencer à mesma conexão. O resolver confere a conta antes de construir o
adaptador e recusa fornecedores ausentes: não existe fallback para Meta.

A integração existente usa a linha `whatsapp_config` da própria conta como
conexão Meta. O mapeamento é explícito e temporário, sem nova migration ou
inferência de provedor a partir do telefone. Os chamadores continuam lendo
essa linha com filtro por conta; o adaptador não consulta sessões ou banco.

Capacidades são declaradas por operação, com limites. Suporte a envio de
modelo não implica suporte a criar/editar modelos, onboarding ou cobrança.
Operações não implementadas não recebem métodos vazios nem sucesso simulado.

Erros distinguem rejeição definitiva, falha passível de nova tentativa e
resultado incerto. Timeout, perda de resposta, 5xx em envio e resposta 2xx
sem ID válido não autorizam repetição automática: o fornecedor pode ter
aceitado a mensagem. Não há failover entre fornecedores durante um envio.
O contrato atual não promete chave de idempotência para envio. Não há fila
durável, reconciliação automática ou garantia exactly-once nesta entrega.

## Matriz de capacidades nesta entrega

`Implementado` significa código com testes locais; `planejado` não habilita
uma capacidade no registro. A pesquisa de APIs e fontes permanece no documento
de provedores, sem confundir documentação externa com integração entregue.

| Capacidade                                           | Meta Cloud                                                         | YCloud                     | Gupshup                   |
| ---------------------------------------------------- | ------------------------------------------------------------------ | -------------------------- | ------------------------- |
| Texto, mídia, modelo aprovado, botões, lista, reação | Implementado pela porta neutra                                     | Planejado, não registrado  | Planejado, não registrado |
| Referências isoladas por conta/conexão/provedor      | Implementado                                                       | Contrato preparado         | Contrato preparado        |
| Download autenticado de mídia pela porta             | Implementado, limite 25 MiB; chamadores legados ainda não migrados | Pendente                   | Pendente                  |
| Administração de modelos                             | Código legado específico; capability neutra desabilitada           | Pendente                   | Pendente                  |
| Onboarding pela porta                                | Desabilitado; registro legado específico                           | Decisão comercial pendente | Pendente                  |
| Entrada/status via conexão autenticada               | Meta com conta resolvida antes do status e transição monotônica    | Pendente                   | Pendente                  |
| Repetição automática de envio incerto                | Não suportada                                                      | Não prometida              | Não prometida             |
| Mais de uma conexão por conta                        | Não habilitado no schema atual                                     | Não habilitado             | Não habilitado            |

## Portas e responsabilidades

- Mensagens: texto, mídia, modelo aprovado, botões, lista e reação.
- Mídia: recuperar metadados e conteúdo sem vazar credenciais ao domínio.
- Modelos administrativos, registro e onboarding: permanecem operações
  específicas da Meta até seus próprios contratos e critérios de aceite.
- Entrada: autenticação do webhook é responsabilidade do adaptador; resolução
  de conexão precede normalização e processamento no domínio.
- Repositório de conexão: mantém consulta por conta e criptografia fora do
  domínio; nunca aceita a escolha de provedor enviada pelo navegador.

## Inventário dos chamadores

| Entrada                            | Caminho existente                                     | Transição                                                  |
| ---------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Chat e API pública                 | `whatsapp/send-message`                               | Porta de mensagens                                         |
| Campanhas API v1                   | `whatsapp/broadcast-core`                             | Porta de mensagens                                         |
| Campanhas dashboard                | `/api/whatsapp/broadcast`                             | Porta de mensagens                                         |
| Automações                         | `automations/meta-send`                               | Porta de mensagens                                         |
| Fluxos e resposta IA               | `flows/meta-send`                                     | Porta de mensagens                                         |
| Reações                            | `/api/whatsapp/react`                                 | Porta de mensagens                                         |
| Download e webhook                 | `/api/whatsapp/media`, `/api/whatsapp/webhook`        | Porta de mídia, etapa própria                              |
| Criação/edição/exclusão de modelos | `/api/whatsapp/templates/*`, `template-header-handle` | Administração Meta específica                              |
| Registro e conexão                 | `/api/whatsapp/config/*`                              | Meta específica; não generalizar onboarding prematuramente |

## Sequência de transição

1. Contratos, isolamento de identidade, resolver estrito e testes de contrato.
2. Adaptador Meta real com regressões de serialização, erro e resultado incerto.
3. Migrar envios dos casos de uso preservando persistência e respostas públicas
   existentes. IDs antigos continuam armazenados como valores Meta; não se
   altera schema nem se promete armazenamento multi-provedor nesta etapa.
4. Migrar mídia, catálogo/administração de modelos e entrada após definir seus
   contratos. O inventário acima delimita os caminhos ainda acoplados.
5. Implementar YCloud após confirmar onboarding, credenciais e fluxo comercial;
   Gupshup depois, sem adaptadores fictícios para antecipar conclusão.

## Decisões abertas

O lançamento atende advogado individual com um número e mantém a conta/equipe
existente. `connectionId` prepara a evolução, sem implementar múltiplos números
ou alterar a cardinalidade do banco nesta etapa.

Coexistência com WhatsApp Business, migração de números, responsabilidade de
cobrança e onboarding YCloud (TP Lite
ou Meta Embedded Signup) dependem de decisão do produto e validação com o
fornecedor. Esta ADR não escolhe essas opções nem autoriza operações reais.

## Validação e limites

Testar resolução entre contas, referências entre conexões, fornecedor não
registrado, capacidades, serialização equivalente à Meta e classificação de
falhas sem repetição cega. O agente QA mantém testes independentes. Testes
locais com HTTP simulado não comprovam entrega real, aprovação comercial,
isolamento RLS ou onboarding dos provedores.
