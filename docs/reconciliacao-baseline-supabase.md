# Reconciliação do baseline do Supabase

Quando o esquema de homologação veio de uma importação e não tem histórico, reconcilie as definições dos objetos antes de registrar qualquer versão. A fonte da cadeia proposta é o diretório [supabase/migrations](../supabase/migrations) no commit de release. O inventário HML-04 do ambiente alvo deve ficar em armazenamento privado.

1. Gere um dump somente de esquema do ambiente alvo e registre a versão do PostgreSQL e das extensões. Compare DDL, colunas, constraints, índices, políticas, funções, ACLs, gatilhos e Realtime. Compare também os metadados dos buckets e suas políticas de Storage. Mantenha a comparação e os dumps fora do Git.
2. Monte um Supabase local descartável com as extensões necessárias e rode os arquivos versionados em ordem. Exporte o esquema com as mesmas opções usadas no alvo e compare as definições. Faça uma segunda execução descartável com a cadeia proposta para um ambiente importado. Use apenas fixtures sintéticas para exercitar as alterações que dependem de dados.
3. Classifique cada versão como **equivalente**, **ausente**, **divergente** ou **inconclusiva**. Para cada objeto herdado sem migration, decida se pertence ao produto e registre a decisão. Uma migration com efeitos em dados ou com objetos substituídos por versões posteriores exige evidência da pós-condição, além da comparação do esquema.
4. Prepare a lista de versões a registrar e a lista de deltas a aplicar, com evidência por versão e por dependência. Submeta as divergências a revisão antes de alterar o histórico. Registre como aplicadas somente as versões cuja equivalência foi comprovada. Depois de executar os deltas revisados, confira novamente o histórico, as definições e as permissões.

| Versão | O que conferir para preparar o delta |
| --- | --- |
| 045 | Dependências de contas, mensagens e configuração do WhatsApp. Compare tabelas de eventos e outbox, índices, RLS e grants das RPCs. |
| 046 | Tabela e RPC de evidências do YCloud, índices, RLS e grants. |
| 048 | Definição, parâmetros e grants de dashboard_metrics. A existência da assinatura por si só deixa a versão inconclusiva. |
| 055 | Dependências em accounts, auth.users e whatsapp_config, unicidade do telefone, RLS das sessões e grants das três RPCs. |
| 056 | Dependências em profiles, automations e automation_steps. Compare as RPCs de escrita atômica e grants. Planeje a implantação da aplicação que usa essas RPCs para depois da migração. |

Registre no inventário privado, por versão, o estado, a evidência, o delta proposto e a decisão de registro. Use a [ordem de homologação](homologacao-e-migracoes.md) para a sequência de aplicação e validação no ambiente alvo.

## Ensaio local da cadeia

Após instalar as dependências pelo lockfile, execute a partir da raiz:

    node scripts/qa/migration-baseline.mjs

O ensaio usa PostgreSQL em memória via PGlite, cria as estruturas mínimas de Auth e Storage e roda os arquivos até 044 antes dos deltas 045, 046, 048, 055 e 056. As versões 030 a 033 ficam fora desse ensaio por dependerem de pgvector. O ensaio verifica a presença dos objetos principais e o acesso exclusivo de service_role às RPCs de escrita selecionadas. O resultado comprova que o subconjunto testado executa a partir de uma base vazia com as estruturas simuladas. A equivalência do ambiente importado, a cadeia integral com pgvector e a execução com Auth, Storage e Realtime reais exigem a comparação e o Supabase local descritos acima.
