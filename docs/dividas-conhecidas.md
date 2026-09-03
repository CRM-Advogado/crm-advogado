# Dívidas conhecidas

Problemas reais já identificados, **ainda não corrigidos**. O objetivo
é que ninguém gaste tempo redescobrindo-os, e que quem for mexer perto
saiba que o terreno já tem um buraco mapeado.

Cada item traz onde está, o que acontece na prática e por que ainda não
foi consertado. Nada aqui é urgente a ponto de parar o trabalho — se
fosse, estaria corrigido em vez de documentado.

---

## 1. Escrita de pai e filho sem transação

**Onde:** `src/app/api/automations/route.ts:129`,
`src/app/api/flows/route.ts:131`, e `src/lib/deals/`.

Os dois primeiros seguem o mesmo padrão: inserem a linha-pai
(`automations` / `flows`), depois os filhos (`automation_steps` /
`flow_nodes`), e se a segunda falhar devolvem 500 **sem apagar o pai**.
O resultado é uma automação ou fluxo sem passo nenhum, que aparece na
lista e não faz nada.

Não há transação em nenhum caminho de escrita do projeto. O cliente
Supabase não expõe transação por HTTP — precisaria de uma função
`SECURITY DEFINER` no banco, ou de delete compensatório na aplicação.

**Contorno já usado:** `POST /api/automations/import` faz o delete
compensatório (as automações criadas são apagadas se os passos
falharem, e `automation_steps.automation_id` é `ON DELETE CASCADE`).
É o padrão a copiar até existir algo melhor.

**Impacto real:** baixo em uso normal — depende de o INSERT dos filhos
falhar logo após o do pai ter sucesso. Vira problema em escrita em
lote, onde a janela é maior.

---

## 2. `validate.ts` roda só na ativação

**Onde:** `src/app/api/automations/route.ts:92`.

Descrito em [invariantes.md](invariantes.md). Fica registrado aqui como
dívida porque **a assimetria é acidental**, não desenhada: a validação
foi escrita quando o builder era o único produtor de payload. Toda vez
que surge um produtor novo, alguém precisa lembrar de validar por conta
própria.

A correção limpa seria mover as regras estruturais (tipos conhecidos,
limites, forma) para fora do portão de ativação, deixando lá só o que é
de fato sobre "esta automação está pronta para rodar". Não foi feito
para não alterar o comportamento de rascunhos existentes, que hoje
podem ser salvos incompletos de propósito.

---

## 3. As 9 rotas de `/api/whatsapp/*` fora da convenção

**Onde:** `src/app/api/whatsapp/*` (exceto o webhook).

São anteriores ao padrão `requireRole` + `toErrorResponse` e chamam
`supabase.auth.getUser()` direto, sem `ctx`. Funcionam, mas cada uma
resolve conta e papel do seu jeito, o que significa que uma mudança na
política de acesso precisa ser replicada nove vezes.

Já está no `CLAUDE.md` como armadilha. Aqui fica como dívida por ser
trabalho pendente, não só uma peculiaridade a conhecer.

---

## 4. Formatação divergente do Prettier

**Onde:** praticamente toda a árvore de `src` — a grande maioria dos
~370 arquivos diverge.

O `.prettierrc` pede ponto-e-vírgula, aspas simples e 80 colunas; a
maior parte do código não segue. O CI **não** checa formatação, então
nada quebra.

O efeito prático é que rodar `npm run format` na árvore inteira produz
um diff que enterra qualquer mudança real, e que arquivos formatados em
momentos diferentes divergem entre si. A recomendação vigente é
formatar só o que você tocou — o que mantém a inconsistência, mas
mantém os diffs legíveis.

Consertar de verdade exigiria um commit de formatação isolado, mais um
`.gitattributes` para o CRLF (ver item 5), coordenado com quem tiver
branch aberta.

**O que acontece quando a recomendação é ignorada:** no commit da
integração ZapSign, alguns arquivos passaram pelo Prettier inteiros.
`automation-builder.tsx` foi ao commit com ~1900 linhas alteradas para
uma mudança real de ~150; `contact-detail-view.tsx`, `validate.ts` e os
testes idem. O código está correto e o CI passa — o custo é que a
mudança real ficou irrecuperável dentro do diff, exatamente o efeito que
esta dívida descreve. Vale como exemplo concreto de por que a
recomendação existe.

---

## 5. CRLF no disco, LF no repositório, sem `.gitattributes`

**Onde:** o repositório inteiro.

`git ls-files --eol` mostra `i/lf w/crlf`. No Windows com
`core.autocrlf=true` funciona e o diff sai correto. Lido de outro
ambiente — Linux, container, agente — o diff aparece inflado com
arquivos inteiros reescritos.

**Como não se enganar:** compare com `git -c core.autocrlf=true diff`
antes de concluir que algo mudou. Já rendeu falso alarme mais de uma
vez.

Um `.gitattributes` com `* text=auto eol=lf` resolveria, mas o commit
de normalização toca quase todo arquivo — mesmo problema de
coordenação do item 4.

---

## 6. `automation_stalled_dispatches` com RLS e sem política

**Onde:** migration 042, linha 353.

RLS ligado, nenhuma política criada. No Postgres isso nega tudo exceto
service-role. É provavelmente intencional — só o cron escreve na tabela
— mas nada registra a intenção.

O risco não é vazamento, é **confusão**: uma leitura pelo cliente do
dashboard devolve zero linhas sem erro nenhum. Bastaria um comentário
na migration, ou uma política explícita de SELECT para membros da
conta.

---

## 7. Passo desconhecido é registrado como SUCESSO — **CORRIGIDO**

**Onde:** `src/lib/automations/engine.ts`, `default` do `switch` de
`runStep`.

> Corrigido: o `default` agora **lança**, o laço marca a execução como
> `failed` e interrompe, e `engine.test.ts` fixa a expectativa
> (`describe("passo desconhecido")`). O registro abaixo fica porque a
> forma de falha é instrutiva — e porque explica logs verdes de
> execuções anteriores à correção.

O `default` do `switch` de `runStep` fazia
`return \`unknown step: ${step.step_type}\`` — devolvia uma string em vez
de lançar. O passo entrava em `automation_logs` com
`status: 'success'` e essa frase no detalhe, o `break` do laço nunca
acontecia, e a automação seguia para os passos seguintes como se nada
tivesse ocorrido.

**Como apareceu:** uma automação com `move_deal_stage` rodando contra
um build anterior à migration 042. O negócio nunca foi criado, o
WhatsApp seguinte foi enviado normalmente, e a execução ficou marcada
como bem-sucedida. Do lado de fora, o funil simplesmente não mexia —
sem erro, sem aviso, sem nada a investigar além do texto do log.

**Por que importa:** passo desconhecido não é passo sem efeito, é
automação quebrada. As duas causas plausíveis — configuração vinda de
um produtor que não é o builder, ou código mais velho que o dado —
são exatamente as que precisam ser barulhentas.

**Conserto aplicado:** o `return` virou `throw`, que já era o que o
laço esperava para marcar a execução como `failed` e interromper.
Muda o comportamento de automações que hoje carregam um passo que este
código não conhece: em vez de seguirem em frente em silêncio, elas
param e aparecem como falha no log — que é o ponto.

---

## 8. Documento "não confirmado" que ninguém varre

**Onde:** `zapsign_documents` com `zapsign_token IS NULL`.

A linha é gravada antes da chamada ao ZapSign para que uma falha de
transporte seja recuperável: o aviso da assinatura chega trazendo o
`external_id`, o webhook reencontra a linha e grava o token que faltava.
Isso resolve o caso em que **o documento existe e é assinado**.

Os outros dois casos ficam em aberto:

- o ZapSign nunca criou o documento (a requisição morreu antes de
  chegar) — a linha fica em dúvida para sempre;
- criou, mas o cliente nunca assina — mesma coisa.

Em ambos, a aba Documentos do contato mostra *envio não confirmado*
indefinidamente. Não é falso positivo — a dúvida é real —, mas não há
nada que a resolva sozinha.

**O conserto natural** é uma varredura no cron: para cada linha sem
token com mais de alguns minutos, consultar a ZapSign e ou completar o
token, ou marcar como falha definitiva. Não foi feito porque exige uma
busca por `external_id` na API, ainda não verificada contra o serviço
real, e porque o volume atual é baixo demais para justificar.

**Contorno:** conferir no painel do ZapSign e apagar a linha à mão.

---

## 9. Um signatário por documento

**Onde:** `src/lib/automations/engine.ts`, passo
`send_signature_request` — lê `doc.signers[0]`.

O passo manda um signatário só, o do contato, e lê o `sign_url` do
primeiro do array. Um modelo do ZapSign configurado com dois
signatários (cliente e testemunha, por exemplo) cria o documento, mas
só o primeiro recebe link pelo Cérebro CRM.

Some-se a isso que, com vários signatários, o evento `doc_signed` chega
a cada assinatura, e é o campo `status` que distingue "um assinou" de
"todos assinaram". O código já respeita essa precedência (ver
[invariantes.md](invariantes.md)), mas nunca foi exercitado contra um
documento real de dois signatários.

**Por que ainda não foi feito:** o caso de uso do escritório é
procuração e contrato de honorários, ambos de um signatário. Vale
verificar antes de prometer o contrário a alguém.

---

## 10. `.next/dev/types` corrompe ao matar o dev server

**Onde:** ambiente, não código.

Encerrar o processo do `next dev` no meio da escrita dos tipos gerados
deixa `.next/dev/types/routes.d.ts` e `validator.ts` truncados. O
sintoma é um erro de sintaxe bizarro num arquivo que ninguém escreveu:

```
.next/dev/types/routes.d.ts:155:1
Type error: Unexpected keyword or identifier.
```

Rodar `build` e `dev` ao mesmo tempo causa a mesma coisa, pelos dois
processos regenerarem o arquivo.

**Conserto:** apagar `.next/dev/types` (ou o `.next` inteiro) e rodar
de novo. Nunca é o seu código. `.next` é gitignorado, então nada disso
chega a um commit.
