# Homologação do produto e reconciliação das migrações

## Destinos e separação

- Repositório: https://github.com/CRM-Advogado/crm-advogado; PRs de implementação para develop, promoção posterior de develop para main.
- Supabase do produto: qdtvxpngastjxpyaofqz, organização CRM Advogados. O nome no painel é “CRM Advogados - Production”, mas o handoff o define como HOMOLOGAÇÃO para o piloto. O nome não autoriza uso com dados reais.
- O repositório, Supabase, arquivos, usuários, credenciais, aplicativo Meta e webhook do Moacir ficam fora das alterações deste produto.

## Estado recebido em 09/10/2026

O handoff homologacao-handoff.md da preparação de 08/10 informa 44 tabelas com RLS, 39 funções, 130 políticas (118 public e 12 storage), três buckets vazios e Realtime. Nenhum dado de negócio, usuário ou arquivo do escritório foi copiado. O teste básico de duas contas usou claims simulados em transação desfeita; não validou login real, toda a API, UI, Storage ou integrações. Estes dados são o estado relatado no handoff, não uma nova auditoria do banco.

O esquema foi importado diretamente dos catálogos. A tabela de histórico supabase_migrations.schema_migrations não recebeu registros. O código-base tinha migrations até 044; o catálogo importado inclui objetos de módulos posteriores e a migration 055 do Embedded Signup ainda não está aplicada. Esta entrega adiciona 055 ao código, sem afirmar que as versões intermediárias estão reconciliadas.

## Ordem de reconciliação

1. Confirmar projeto/organização de destino e guardar snapshot do esquema sem dados, manifesto e avisos atuais. Usar homologacao-schema.sql, homologacao-schema-manifest.json, homologacao-comparacao.json e homologacao-verificacao.json como referências do handoff; não transportar dumps de dados ou segredos para o repositório público.
2. Comparar tabelas, funções (assinaturas e corpos), políticas, grants, triggers, índices, extensões, buckets e publicação Realtime com as migrations versionadas. Catalogar objetos existentes sem migration correspondente e divergências. Não marcar migrations como aplicadas apenas pelo nome ou número.
3. Construir um baseline revisável do esquema do PRODUTO e reproduzi-lo em banco descartável vazio. Avaliar explicitamente os módulos herdados e as permissões, sem importar alterações de negócio do Moacir automaticamente. Registrar apenas o baseline comprovado no histórico de homologação.
4. Testar que futuras migrations partem desse baseline. Depois aplicar e validar o delta 055: accounts/auth.users/whatsapp_config, campos esperados e unicidade de phone_number_id; tabela de sessões e três RPCs com grants exclusivos de service_role. Conferir RLS/grants reais com anon, authenticated e service_role.
5. Publicar em homologação com ambiente e integrações próprios; executar login real e testes UI/REST/Storage de contas A/B antes do piloto. Só então avaliar a habilitação do Embedded Signup.

Não executar supabase db push contra o projeto importado antes dessa reconciliação. O teste da migration 055 nesta entrega usa PostgreSQL local com esquema mínimo e não prova compatibilidade de todo o catálogo remoto.

## Pendências antes de dados reais

- Revisar os 46 avisos relatados: buckets públicos/listagem, permissões PUBLIC/anon/authenticated em funções SECURITY DEFINER, seis funções sem search_path fixo e vector em public. Conferir a necessidade de cada permissão e implementar correções em PRs próprios com testes allow/deny. Não houve correção remota desses avisos nesta entrega.
- Validar cadastro/login/convites, URLs de redirecionamento, SMTP e papéis administrativos com usuários fictícios reais em homologação.
- Testar isolamento de leitura e escrita em todas as entidades usadas no piloto e acesso direto REST/Storage entre dois escritórios; o teste básico de contacts não cobre todo o CRM.
- Configurar app Meta, OAuth, domínios, segredos e webhook próprios. Autorizar WABA/número de teste, enviar/receber mensagens, testar revogação, falhas parciais e concorrência com a rota manual.
- Manter META_EMBEDDED_SIGNUP_ENABLED=false até essas validações. Coexistência com WhatsApp Business no celular não está implementada por este fluxo padrão.

## Critério para promover

QA local favorável permite revisar o código em develop com o recurso desativado. Não comprova aptidão para comercialização ou piloto com dados reais. A promoção para main e a implantação devem incluir evidências do ambiente alvo e resolução das pendências aplicáveis.
