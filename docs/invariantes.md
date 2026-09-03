# Invariantes por subsistema

O `CLAUDE.md` responde *"como se faz X neste projeto"*. Este arquivo
responde outra coisa: *"o que é verdade sobre este domínio que o
código não deixa óbvio"*.

São fatos que decidem o desenho. Descobri-los no meio da implementação
custa retrabalho; descobri-los depois do deploy custa mais.

> Confiança: a seção de **automações** foi levantada implementando o
> import/export e verificada contra o banco. **Funis** e **fluxos** são
> mais rasos — tratados como pistas a confirmar, não como verdade
> estabelecida.

---

## Automações

**`validate.ts` é um portão de ativação, não um sanitizador.**
`POST /api/automations` só o chama quando `is_active` é verdadeiro
(route.ts). A premissa era que o único produtor de payload fosse o
builder, que não consegue emitir um `step_type` inexistente. Qualquer
novo produtor — arquivo, API pública, integração — precisa validar por
conta própria, **inclusive rascunhos**. Ver `lib/automations/import.ts`.

**Ninguém checa posse de referência.** `validate.ts` confere que
`tag_id` é não-vazio, nunca que a tag pertence à conta. Como a gravação
usa service-role, um id estrangeiro entra e falha em toda execução, em
silêncio. Ver [mapa-tenancy.md](mapa-tenancy.md).

**`insertSteps` honra `s.id ?? uid()`** (`steps-tree.ts`). Payload que
carrega `id` escolhe a chave primária da linha. Descarte sempre que a
origem não for confiável.

**Os dois `walk` recursivos não têm limite de profundidade** — o de
`steps-tree.ts` e o de `validate.ts` descem por `branches` até acabar.
Uma árvore funda o bastante estoura a pilha *dentro* do validador,
antes que ele consiga recusar a entrada. Qualquer corte precisa vir
**antes** da recursão.

**`condition.operand` é polimórfico por `subject`:**

| `subject` | O que `operand` guarda |
| --- | --- |
| `tag_presence` | **id de uma tag** |
| `contact_field` | nome da coluna |
| `message_content` | trecho de texto |
| `time_of_day` | faixa `"HH:mm-HH:mm"` |

Só o primeiro é referência. Tratar o campo uniformemente quebra em um
dos quatro casos.

**E metade dos sujeitos nem compara `operand`.** `message_content` e
`contact_field` comparam `cfg.value` (engine.ts); `operand` neles é só
o alvo — o trecho procurado e o nome da coluna. Mas `validate.ts` exige
`operand` não-vazio e **não** exige `value`. Uma condição escrita só com
`operand` passa na validação e, em execução, compara contra string
vazia: `message_content` vira sempre verdadeiro, `contact_field` vira
sempre falso. O exemplo `docs/exemplos/01-basico-sem-referencias.json`
carregou esse erro por um tempo. Ao escrever `message_content` ou
`contact_field` fora do builder, emita os dois campos.

**`interpolate()` conhece `message.text`, `vars.*`, `contact.name` e
`contact.first_name` — e nada mais.** Qualquer outro token entre chaves
vira **string vazia**, sem erro e sem log. Os dois tokens de contato
resolvem a partir de `context.contact_name`, que o dispatch preenche
pegando carona na consulta de posse (`runAutomationsForTrigger`) — não
há leitura extra por execução. Consequências: contato **sem nome**
também vira vazio (a saudação precisa sobreviver à ausência); num
resume de passo de espera vale o nome serializado quando a execução
começou; e execuções enfileiradas **antes** dessa mudança não têm
`contact_name` no contexto gravado. Campos além do nome (negócio,
conta, e-mail) continuam inacessíveis por texto.

**`vars` praticamente não é populado nas automações.** O webhook manda
`message_text`, `conversation_id` e `interactive_reply_id`; o motor
acrescenta só `_deal_chain_depth`, e o webhook do ZapSign o
`template_token`. Não existe passo que capture uma resposta de texto e
a guarde. Quem tem isso é **Flows**, com o nó `collect_input`, que
grava em `flow_runs.vars` — e essas variáveis não atravessam para uma
automação. Coletar dado por conversa e usá-lo num passo de automação
não é possível hoje sem estender o produto.

**Dois gatilhos da lista nunca disparam.** `conversation_assigned` e
`time_based` estão em `@/types`, em `import.ts`, em `validate.ts` e no
mapa de rótulos, mas nenhum lugar do código chama
`runAutomationsForTrigger` com eles. Uma automação ligada em qualquer
dos dois fica ligada e inerte. Ver `TRIGGER_META` para a lista dos que
têm despachante de verdade.

**Passo desconhecido interrompe a execução.** O `default` do `switch`
de `runStep` lança, o laço marca `failed` e para. Foi o contrário por
um tempo — devolvia uma string e a execução seguia com o log verde,
que era a dívida #7; se você estiver lendo um build antigo, é isso que
vai ver. As duas causas de um passo desconhecido — configuração vinda
de um produtor que não é o builder, ou código mais velho que o dado —
são justamente as que precisam ser barulhentas.

**`assign_conversation.agent_id` guarda `profiles.user_id`, não
`profiles.id`.** É o que o motor grava em
`conversations.assigned_agent_id` e o que o modo `round_robin` lê.

**Campos personalizados são endereçados como `custom:<uuid>`** e
gravados em `contact_custom_values`, não como coluna. O prefixo é o que
distingue os dois caminhos de escrita.

**Nem toda coluna de `contacts` é gravável por automação.** A lista
fechada está em `contact-fields.ts`, com o porquê de cada exclusão —
`phone` é chave de deduplicação, os campos `ad_*` são atribuição de
primeiro toque escrita só pelo webhook. Escrever fora da lista falha
registrando **sucesso**.

**`practice_area` tem CHECK no banco** (migration 039). Um valor com
erro de digitação só é recusado em tempo de execução, a menos que
alguém valide antes.

---

## Assinatura eletrônica

O guia de uso está em [zapsign-integration.md](zapsign-integration.md).
Aqui ficam só os fatos que decidem desenho e que não se deduzem lendo o
código.

**Sandbox e produção são hosts diferentes com tokens diferentes.** Não
há flag `sandbox: true` no corpo da requisição, como em outros
provedores — a coluna `sandbox` escolhe a base URL, e o token só
funciona contra o host dele. Um token trocado falha com 401 na
validação, não com um erro que diga "ambiente errado".

**O corpo do webhook é o documento inteiro, com `token` e `status` na
raiz — e mais um `event_type` que a documentação da ZapSign não
menciona.** Confirmado contra payloads reais do sandbox (`doc_created` e
`doc_signed`). `status` tem a palavra final; o `event_type` só é
consultado quando `status` vem ausente. A ordem importa: num documento
de vários signatários, o evento `doc_signed` pode chegar com
`status: 'pending'` porque ainda falta alguém assinar.

**O token do documento não muda entre os eventos.** É o que permite
casar o aviso da assinatura com a linha gravada lá atrás, na criação.

**`zapsign_documents.zapsign_token` nulo não é dado faltando, é um
estado**: "mandamos e não sabemos se chegou". A linha nasce antes da
chamada e o `id` dela viaja como `external_id`, justamente para que o
aviso da assinatura consiga reencontrá-la quando a resposta da criação
se perdeu. Qualquer consulta que assuma token preenchido precisa tratar
esse caso — a rota do PDF assinado devolve 409 nele.

**Falha de transporte e recusa da API pedem tratamentos opostos.**
`ZapsignApiError` (tem status HTTP) significa que a ZapSign decidiu não
criar: a linha sai. `ZapsignTransportError` (sem resposta) significa que
não se sabe: a linha fica. Colapsar os dois num `catch` genérico
reintroduz o documento órfão.

**Os links de arquivo da ZapSign duram 60 minutos.** Vale para
`original_file` e `signed_file`. É documentado, e foi conferido num
payload real. Guardar essas URLs em coluna produz links mortos; o certo
é pedir um novo na hora do uso.

**`send_via_whatsapp` ausente vale LIGADO**, e três lugares leem esse
campo — motor, `validate.ts` e o builder. Enquanto discordaram, um JSON
importado sem o campo gerava o documento e não mandava o link, com o log
verde. Qualquer leitura nova precisa usar `!== false`.

**`{{signer_url}}` é trocado ANTES de `interpolate()`**, porque
`interpolate()` zera todo token que não conhece. O padrão tolera espaços
e casa todas as ocorrências.

**O passo exige que o contato tenha nome** — vai para o documento como
nome do signatário — e, quando manda por WhatsApp, exige conversa já
existente. As duas checagens acontecem **antes** da chamada externa, de
propósito: falhar depois gastaria cota.

**Nomes de variável de modelo podem ter espaço** (`NOME COMPLETO`,
`ESTADO CIVIL`). São chaves de um `Record`, então duas iguais se fundem
silenciosamente ao salvar — o editor do builder avisa, mas nada no banco
impede.

## Funis e negócios

**`pipeline_stages` não tem `account_id`** e exige papel **admin** —
ver [mapa-tenancy.md](mapa-tenancy.md).

**Nomes não são únicos.** `tags.name`, `pipelines.name` e
`pipeline_stages.name` não têm constraint UNIQUE (migration 001).
Qualquer resolução por nome precisa decidir o que fazer com homônimos.
Há duas políticas conflitantes no código hoje, ambas deliberadas:
`contacts/resolve-import-tags.ts` fica com o primeiro;
`automations/import.ts` trata como erro duro. A diferença é o custo de
errar — um contato mal etiquetado se conserta ao ser visto, uma
automação ligada na tag errada dispara errado para sempre.

**`deals.status` tem CHECK** (`open` / `won` / `lost`).

**O quadro de funis não filtra, não busca e não mostra etiqueta.**
`pipeline-board.tsx` e `deal-card.tsx` renderizam colunas e cartões e
nada mais. Etiqueta só aparece na tela de Contatos. Um alerta desenhado
como etiqueta é invisível exatamente onde a equipe olha todo dia — se o
sinal precisa ser visto no quadro, ele tem de ser etapa.

**O quadro abre no funil mais antigo.** `pipelines/page.tsx` ordena por
`created_at` e seleciona `list[0]`. Numa conta semeada pela 043, o
Funil Previdenciário nasce antes de qualquer funil que o usuário crie
depois — então a tela abre nele, e um negócio criado no funil novo
parece não ter sido criado. É a primeira hipótese a descartar quando
alguém diz que a automação não moveu o cartão.

**`match_by` do passo `move_deal_stage`** resolve *qual* negócio mover
quando o contato tem mais de um. Ausente vale `auto`. O modo `context`
só move o negócio que disparou o gatilho e nunca cria — combiná-lo com
`create_if_missing` é contradição, e o validador recusa.

**Não há transação em nenhum caminho de escrita de negócios**
(`lib/deals/`). Ver [dividas-conhecidas.md](dividas-conhecidas.md).

---

## Fluxos

Estrutura paralela à de automações, com módulos de mesmo nome
(`engine.ts`, `validate.ts`, `templates.ts`, `admin-client.ts`) — mas
são implementações **separadas**, não compartilhadas. Corrigir um bug
em `automations/engine.ts` provavelmente exige o mesmo conserto em
`flows/engine.ts`.

`flow_nodes.node_type` tem CHECK no banco, ampliado por migration
(ex.: `send_media` na 016). Acrescentar um tipo de nó exige migration,
não só mudança de TypeScript.

---

## IA de resposta

**A IA se cala quando existe automação de mensagem ativa na conta.**
Antes de gerar qualquer coisa, `lib/ai/auto-reply.ts` consulta se há
alguma automação `is_active` com gatilho `new_message_received` ou
`keyword_match` e, havendo **uma**, retorna em silêncio para não
escrever duas vezes ao cliente. É por conta, não por conversa nem por
automação: ligar a primeira triagem por palavra-chave desliga a
auto-resposta para todo mundo. Quem for depurar "a IA parou de
responder" começa por aqui.

**A IA não escreve nada estruturado.** `generateReply` devolve
`{ text, handoff, usage }`. Ela não etiqueta, não grava tese, não move
negócio. O único efeito não-textual é o handoff: desliga a si mesma na
conversa, atribui ao agente configurado e grava
`ai_handoff_summary`. Não existe passo de automação que a invoque —
classificar mensagem por IA exige sair pelo `send_webhook` e voltar
pela API v1.

---

## Convenções que valem em todo lugar

**Os dois motores dependem de agendador HTTP externo.**
`/api/automations/cron` e `/api/flows/cron` não rodam sozinhos — a
hospedagem é gerenciada, sem crontab. Ver `funil-automatico.md`.

**Gatilho por palavra-chave sem `match_type` vale `contains`**, tanto
em `automations/engine.ts` quanto em `flows/engine.ts`. Validação que
exija o campo quebra automações que hoje funcionam.

**`send_webhook` tem guard de SSRF no motor** (`isDeliverableUrl`, em
`lib/webhooks/ssrf.ts`), chamado na hora de entregar. Um endereço
interno pode ser **gravado** sem obstáculo e só falha na execução —
quem aceita URL de fora deve checar na entrada.
