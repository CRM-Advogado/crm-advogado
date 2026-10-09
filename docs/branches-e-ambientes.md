# Branches e ambientes do CRM-Advogado

## Organização definida

O repositório https://github.com/CRM-Advogado/crm-advogado é a base do CRM que será desenvolvido para atender vários clientes. O ambiente atualmente utilizado pelo Moacir permanece separado deste projeto.

| Branch | Finalidade | Entrada de alterações |
| --- | --- | --- |
| `develop` | Desenvolvimento e validação | PRs de branches de implementação criadas a partir de `develop` |
| `main` | Produção para os clientes | PR de promoção de `develop`, após revisão e validação |

## Fluxo de implementação

1. Confirme que está no repositório CRM-Advogado/crm-advogado e atualize sua referência de `develop`.
2. Crie uma branch a partir de `develop`. Para trabalho realizado pelo Codex, use o prefixo `codex/`.
3. Implemente a alteração e execute as verificações pertinentes ao seu escopo.
4. Abra um PR com destino a `develop`, informando a mudança, a validação realizada e eventuais limitações.
5. Após integração e validação em desenvolvimento, promova as alterações para `main` por PR revisado.

Não publique implementações diretamente em `main`. A integração de um PR não comprova, por si só, que ocorreu uma implantação: o destino e as configurações de publicação devem ser confirmados.

## Separação dos ambientes

O repositório e os serviços do ambiente atual do Moacir não devem ser alterados por trabalhos neste projeto sem solicitação explícita.

Ao configurar desenvolvimento e produção do novo CRM, confirme a separação das implantações, bancos de dados, credenciais, integrações Meta/WhatsApp e destinos de webhook. Um fork ou uma branch não cria essa separação automaticamente.

Esta documentação define a organização e o fluxo de trabalho. Não afirma que os ambientes, serviços externos, automações de publicação ou proteções de branch já estejam configurados.

## Orientações herdadas do template

Esta política prevalece sobre instruções genéricas do template que indiquem criar branches de implementação a partir de `main` ou atualizar diretamente `main`. Alterações provenientes do upstream também devem passar por `develop` e validação antes da promoção para produção.
