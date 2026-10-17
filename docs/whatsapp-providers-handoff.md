# Entrega e continuidade das tarefas WA

Referência: tarefas WA-01 a WA-09 no Coda CRM - Advocacia. Data: 15/10/2026.
Repositório confirmado pelo usuário: `CRM-Advogado/crm-advogado`.
Base de desenvolvimento: `origin/develop` em `efdd4ce`.
Público inicial confirmado: advogado individual com um número; evolução para
escritórios e múltiplos números depende de necessidade posterior.

## Estado por tarefa

| Tarefa | Entrega e estado real |
| --- | --- |
| WA-01 — Arquitetura e contratos | ADR, inventário, matriz de capacidades, contratos e plano de transição no [PR #3](https://github.com/CRM-Advogado/crm-advogado/pull/3). Pronto para revisão técnica; decisões comerciais continuam abertas. |
| WA-02 — Portas e Meta | Incremento no PR #3: envios dos chamadores principais usam o mesmo caso de uso, referências isoladas e status corrigidos. Parcial: administração de modelos, download nos chamadores legados e onboarding ainda têm etapas de transição. |
| WA-03 — Cadastro e conexão comuns | Não implementada nesta entrega. Preservado o cadastro existente. Nome/número/autorização e seu estado persistente dependem do onboarding escolhido e do vínculo autorizado no servidor. |
| WA-04 — Onboarding YCloud | Pesquisa técnica documentada. Parceria, permissões, modalidade de autorização e ambiente de teste ainda não verificados. Nenhum ativo foi conectado. |
| WA-05 — Adaptador YCloud | Adaptador de envio, verificador de assinatura e normalizador de eventos com testes locais, em branch separada `codex/ycloud-adapter`. Parcial: sem persistência, rota de entrada, registro no runtime, ativação ou homologação real. |
| WA-06 — Preparação Gupshup | Referências e divergências documentais registradas. Confirmar modalidade contratada, contrato versionado e autenticação do callback com o fornecedor. |
| WA-07 — Adaptador Gupshup | Não implementado. Não registrar adaptador fictício nem reutilizar outra modalidade/API sem confirmação. A base comum já permite implementação posterior sob o mesmo contrato. |
| WA-08 — Consumo e cobrança | Não implementada. Responsabilidade de cobrança por escritório ou centralizada permanece aberta; nenhuma cobrança ou recarga foi ativada. |
| WA-09 — Homologação e piloto | QA local independente concluído para os incrementos entregues. Homologação externa, isolamento RLS real, coexistência e piloto permanecem pendentes. |

## Validação dos incrementos

- PR #3, candidato `363a417`: 891 testes em 81 arquivos; 31 casos próprios do
  agente de QA. Tipos, lint sem erros (38 avisos existentes), build e CI GitHub
  aprovados. Instalação reproduzível corrigida e verificada pelo próprio CI.
- Incremento YCloud: 971 testes em 83 arquivos; 32 testes do desenvolvimento e
  48 testes independentes de QA adicionados sobre a base. Tipos e lint aprovados,
  com os mesmos 38 avisos existentes. Build final é registrado no PR e em
  `ycloud-qa.md`.
- Foram exercitados regressivos de status entre contas, eventos atrasados e
  concorrentes, mídia redirecionada, resposta sem ID, envio incerto sem repetição,
  datas impossíveis e erros sem trechos de conteúdo privado.
- Todos os dados e transportes desses testes são sintéticos. Não houve envio
  real, implantação, mudança de banco ou alteração no ambiente do Moacir.

## Ordem de integração e próximos critérios

1. Revisar e integrar o PR #3 em `develop`.
2. Revisar o incremento separado YCloud após a base; seu PR também tem destino
   `develop` e carrega a dependência do PR #3 até ele ser integrado.
3. Definir modalidade de onboarding YCloud e prioridade de coexistência, além
   de credenciamento e cobrança. Não exigir SIM novo nem migrar números como
   consequência automática desta decisão.
4. Projetar o delta de persistência: conexão autorizada por conta, credenciais
   de servidor, IDs do provedor e da rede WhatsApp, inbox durável e deduplicação.
   Não habilitar uma rota que confirme 2xx antes da aceitação durável do evento.
5. Implementar o fluxo comum de conexão e homologar YCloud com duas contas
   distintas, autenticação real e número autorizado de teste.
6. Confirmar o contrato Gupshup, implementar seu adaptador e homologá-lo
   separadamente. Pendência exclusiva dele não invalida o QA local da YCloud.

Nenhum PR foi integrado automaticamente. O fluxo antigo de Embedded Signup
permanece no PR #2 e não foi integrado incidentalmente neste trabalho.

## Registro no Coda

O backlog foi lido para definir o escopo. Tentativas posteriores de consultar
o esquema da tabela retornaram `Unexpected response type` no conector. Não
foram alterados status, descrições ou comentários por um caminho alternativo.
Este documento registra as entregas e pendências para atualização posterior,
sem tratar tarefas parciais ou validações externas como concluídas.
