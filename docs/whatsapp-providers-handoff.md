# Entrega e continuidade das tarefas WA

Referência: tarefas WA-01 a WA-09 no Coda CRM - Advocacia. Data: 15/10/2026.
Atualização de integração e direção do produto: 16/10/2026.
Repositório confirmado pelo usuário: `CRM-Advogado/crm-advogado`.
Base inicial da implementação: `origin/develop` em `efdd4ce`.
Base após integração aprovada: `origin/develop` em `8fb566e`.
Público inicial confirmado: advogado individual com um número; evolução para
escritórios e múltiplos números depende de necessidade posterior.
Coexistência confirmada como obrigatória em 16/10: aplicativo WhatsApp Business
e CRM devem funcionar no mesmo número. Esse requisito ainda não foi homologado.

## Estado por tarefa

| Tarefa | Entrega e estado real |
| --- | --- |
| WA-01 — Arquitetura e contratos | ADR, inventário, matriz de capacidades, contratos e plano de transição no [PR #3](https://github.com/CRM-Advogado/crm-advogado/pull/3), integrado em develop em `6d92a06`. Decisões comerciais continuam abertas. |
| WA-02 — Portas e Meta | Incremento no PR #3: envios dos chamadores principais usam o mesmo caso de uso, referências isoladas e status corrigidos. Parcial: administração de modelos, download nos chamadores legados e onboarding ainda têm etapas de transição. |
| WA-03 — Cadastro e conexão comuns | Não implementada nesta entrega. Preservado o cadastro existente. Nome/número/autorização e seu estado persistente dependem do onboarding escolhido e do vínculo autorizado no servidor. |
| WA-04 — Onboarding YCloud | Pesquisa técnica documentada. Parceria, permissões, modalidade de autorização e ambiente de teste ainda não verificados. Nenhum ativo foi conectado. |
| WA-05 — Adaptador YCloud | Adaptador de envio, verificador de assinatura e normalizador de eventos com testes locais no [PR #4](https://github.com/CRM-Advogado/crm-advogado/pull/4), integrado em develop em `8fb566e`. Parcial: sem persistência, rota de entrada, registro no runtime, ativação ou homologação real. |
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

1. PR #3 integrado após aprovação do usuário: candidato `363a417`, merge
   `6d92a06`. PR #4 integrado em seguida: candidato `ce30c12`, merge `8fb566e`.
   A integração do código não comprova implantação, conexão de número ou mudança
   de banco. As evidências locais anteriores permanecem registradas acima.
2. Revisar a [ADR 002 proposta](adr/002-whatsapp-durable-ingress-proposal.md):
   recebimento durável Meta, deduplicação e intenções no PostgreSQL existente.
   É documento para alinhamento, não aprovação de implementação ou migrations.
   Alinhar retenção, diagnóstico de resultados incertos e ambiente exclusivo.
3. Preparar persistência comum de conexão autorizada e IDs do provedor/rede,
   mantendo uma conexão por conta. Mídia e administração de modelos podem
   migrar em incrementos separados. Não confirmar 2xx antes da aceitação durável.
4. Confirmar credenciamento e modalidade de onboarding YCloud compatível com
   coexistência obrigatória. Tratar eventos de envios do aplicativo/SMB/echo,
   correlação e intervenção humana antes do piloto. O adaptador atual não
   implementa essa coexistência. Cobrança permanece aberta; não exigir SIM novo,
   migrar número ou remover aplicativo automaticamente.
5. Implementar o fluxo comum e homologar YCloud em ambiente exclusivo com duas
   contas, autenticação real, número autorizado e app/CRM no mesmo número.
6. Confirmar o contrato Gupshup, implementar seu adaptador e homologá-lo
   separadamente. Pendência exclusiva dele não invalida o QA local da YCloud.

Os PRs #3 e #4 foram integrados somente após aprovação do usuário em 16/10.
O fluxo antigo de Embedded Signup permanece no PR #2 e não foi integrado
incidentalmente neste trabalho.

## Registro no Coda

O backlog foi lido para definir o escopo. Tentativas posteriores de consultar
o esquema da tabela retornaram `Unexpected response type` no conector. Não
foram alterados status, descrições ou comentários por um caminho alternativo.
Este documento registra as entregas e pendências para atualização posterior,
sem tratar tarefas parciais ou validações externas como concluídas.
Na retomada de 16/10, a consulta foi bloqueada pelo limite mensal do conector;
esta continuidade usa o handoff existente e as evidências do repositório.
