# Mapa de tenancy

Leia **antes** de escrever qualquer consulta nova. Errar aqui não gera
erro: gera vazamento entre contas, que passa em todos os testes e só
aparece quando um cliente vê o dado de outro.

Levantado das 43 migrations. São 38 tabelas: **28 têm `account_id`**,
**10 não têm** e se escopam pelo pai.

## A regra que decide tudo: qual cliente você está usando

| Cliente | Onde | RLS | O que você precisa fazer |
| --- | --- | --- | --- |
| `@/lib/supabase/server` (SSR) | rota autenticada, server component | **aplica** | nada — o RLS já filtra |
| `@/lib/supabase/client` | browser | **aplica** | nada |
| `supabaseAdmin()` | motores: cron, webhook, engine | **IGNORA** | filtrar `.eq('account_id', …)` em **toda** query |

O terceiro caso é a fonte de quase todo risco. O cliente service-role
não é "o mesmo com mais permissão" — ele não enxerga RLS nenhum. Uma
query sem filtro explícito lê a base inteira, de todas as contas.

Corolário menos óbvio: **validação não é escopo**. Conferir que um
`tag_id` é não-vazio não diz nada sobre a quem ele pertence. Quando um
id chega de fora (arquivo, API, payload), é preciso confirmar que ele
existe *dentro da conta* — ver `lib/automations/import.ts`, que
resolve tudo contra um catálogo montado com filtro por `account_id`.

## As 10 tabelas sem `account_id`

Não é esquecimento: são tabelas-filhas, escopadas pelo pai via RLS. O
custo é que **você não pode filtrar por conta diretamente** — precisa
do join.

| Tabela | Escopo via | Ler | Escrever |
| --- | --- | --- | --- |
| `automation_steps` | `automations.account_id` | agent | agent |
| `messages` | `conversations.account_id` | agent | agent |
| `message_reactions` | `messages` → `conversations.account_id` | agent | agent |
| `pipeline_stages` | `pipelines.account_id` | membro | **admin** |
| `contact_tags` | `contacts.account_id` | agent | agent |
| `contact_custom_values` | `contacts.account_id` | agent | agent |
| `flow_nodes` | `flows.account_id` | agent | agent |
| `flow_run_events` | `flow_runs.account_id` | membro | — |
| `broadcast_recipients` | `broadcasts.account_id` | agent | agent |
| `automation_stalled_dispatches` | — ver abaixo | ninguém | ninguém |

"membro" = `is_account_member(account_id)` sem papel mínimo, ou seja,
qualquer um da conta, incluindo `viewer`.

### As três que mordem

**`pipeline_stages`** é a mais traiçoeira. A migration 017 acrescentou
`account_id` a 15 tabelas e **pulou esta**. Quem escreve
`.eq('account_id', accountId)` numa query de etapas recebe erro de
coluna inexistente; quem esquece o escopo por completo lê as etapas de
todos os inquilinos. O caminho correto é o join:

```ts
supabase
  .from('pipeline_stages')
  .select('id, name, pipeline_id, pipelines!inner(account_id)')
  .eq('pipelines.account_id', accountId)
```

Some-se a isso que nomes de etapa se repetem entre funis ("Triagem",
"Fechado"), então **etapa só faz sentido dentro de um funil** — nunca
resolva uma etapa por nome globalmente.

**`messages`** também não tem `account_id`, e é a tabela mais volumosa
do sistema. Toda leitura passa por `conversations`.

**`automation_stalled_dispatches`** tem RLS **ligado e nenhuma
política** (migration 042, linha 353). No Postgres isso nega tudo
exceto para o service-role. É seguro e provavelmente intencional — só
o cron escreve nela — mas é uma armadilha silenciosa: ler pelo cliente
do dashboard devolve **zero linhas sem erro nenhum**. Se você estiver
depurando "sumiu meu dado", é aqui.

## As 28 com `account_id`

`accounts`, `account_invitations`, `profiles`, `contacts`,
`contact_notes`, `custom_fields`, `tags`, `conversations`,
`whatsapp_config`, `message_templates`, `quick_replies`, `pipelines`,
`deals`, `deal_stage_events`, `broadcasts`, `automations`,
`automation_logs`, `automation_pending_executions`, `flows`,
`flow_runs`, `notifications`, `member_presence`, `api_keys`,
`webhook_endpoints`, `ai_configs`, `ai_usage_log`,
`ai_knowledge_documents`, `ai_knowledge_chunks`, `zapsign_credentials`,
`zapsign_documents`.

Nestas, `.eq('account_id', ctx.accountId)` funciona direto. Vale
escrevê-lo **mesmo sob RLS**: é redundante hoje, e continua de pé se
alguém trocar o cliente por service-role amanhã.

Duas ressalvas nas mais novas (migration 044):

- **`zapsign_credentials` tem `account_id` como chave primária**, não
  como coluna comum — é uma credencial por conta, e o banco garante
  isso. `maybeSingle()` é o acesso natural; um `insert` numa conta que
  já configurou o ZapSign viola a PK em vez de criar uma segunda linha.
- **`zapsign_documents` só tem política de SELECT.** Nenhum
  `INSERT`/`UPDATE`/`DELETE` para o papel `authenticated`, de propósito:
  quem escreve é o motor de automações e a rota de webhook, ambos por
  service-role. Mesmo desenho de `deal_stage_events` e
  `automation_stalled_dispatches`. Uma tela que tentar gravar ali recebe
  erro de política, não linha criada.

## Papéis

Hierarquia: `owner > admin > agent > viewer`. Os predicados vivem em
`src/lib/auth/roles.ts` (`hasMinRole`, `canManageMembers`) e espelham
o helper SQL `is_account_member(account_id, min_role)` da migration
017. Use os mesmos predicados no guard da rota e no gate da UI.

Repare que **`pipeline_stages` exige `admin` para escrita** (política
`pipeline_stages_modify`), embora a leitura seja aberta a qualquer
membro (`pipeline_stages_select`). Uma rota que deixa um `agent` mexer
em etapas passa no código e falha no banco. O mesmo vale para `tags`,
`custom_fields` e `pipelines`, todas com escrita restrita a `admin`
desde a migration 017.

## Duas exceções ao padrão de guarda

- As 9 rotas em `src/app/api/whatsapp/*` (fora o webhook) são
  anteriores à convenção e chamam `supabase.auth.getUser()` direto.
  Ao editá-las, não presuma que existe `ctx`.
- Sem sessão de usuário: `/api/*/cron` autentica por `x-cron-secret`;
  `/api/whatsapp/webhook` valida HMAC;
  `/api/invitations/[token]/peek` é público por desenho.
