# Integração ZapSign — assinatura eletrônica

Migration 044. Permite que uma automação gere um documento no ZapSign a
partir de um modelo já cadastrado lá e mande o link de assinatura pelo
WhatsApp do escritório, e reaja quando o documento volta assinado.

## As duas peças

- **Passo `send_signature_request`** (`src/lib/automations/engine.ts`):
  cria o documento (`POST /models/create-doc/`), grava uma linha em
  `zapsign_documents`, e — quando `send_via_whatsapp` está ligado (padrão)
  — manda o `sign_url` pela conversa existente do contato, usando o
  mesmo caminho que `send_message` já usa (`engineSendText`).

  **`send_via_whatsapp` ausente vale LIGADO**, nos três lugares que leem
  o campo: motor, `validate.ts` e builder. O builder sempre grava o
  campo; quem pode omiti-lo é um JSON importado. Enquanto os três
  discordaram, um payload sem o campo abria no builder com a chave
  ligada, passava na validação sem exigir texto e não mandava nada — o
  documento era gerado, a cota gasta, e o log ficava verde.

  **A conversa é resolvida ANTES da chamada ao ZapSign.** O passo
  alcança contatos que nunca conversaram (`document_signed`,
  `tag_added`, `deal_stage_changed`), e falhar depois de criar o
  documento deixava um documento pago lá e uma linha `pending` que
  ninguém fecha. Com `send_via_whatsapp` desligado nenhuma conversa é
  exigida.

  **`{{signer_url}}` tolera espaços e repetição.** `{{ signer_url }}` e
  duas ocorrências no mesmo texto funcionam. A troca acontece antes de
  `interpolate()`, que zeraria o token por não conhecê-lo.

  **A linha do banco nasce ANTES da chamada, e o `id` dela viaja como
  `external_id`.** É o que torna recuperável a falha de transporte: sem
  resposta, não dá para saber se o ZapSign criou ou não o documento. Com
  a linha já gravada (token nulo), o aviso de assinatura chega trazendo
  o nosso id de volta, o webhook reencontra a linha e grava o token que
  faltava — o caso se fecha sozinho. Os dois desfechos da falha são
  distintos de propósito:

  | Falha | O que se sabe | O que acontece com a linha |
  | --- | --- | --- |
  | `ZapsignApiError` (tem status HTTP) | o ZapSign recusou | **apagada** — não há dúvida a registrar |
  | `ZapsignTransportError` (sem resposta) | não se sabe | **fica**, com token nulo |

  Token nulo significa exatamente "mandamos e não sabemos se chegou". A
  aba Documentos mostra isso como *envio não confirmado*.
- **Gatilho `document_signed`**: disparado pelo webhook de entrada
  quando a ZapSign avisa `status: 'signed'`. Não decide nada sozinho —
  quem decide o que acontece depois (mover o negócio, avisar o time) é
  a automação que a conta monta a partir dele, mesmo desenho de
  `tag_added` / `practice_area_set`.

## Coletar CPF, endereço e afins: use o formulário do modelo

O ZapSign tem formulário próprio, e é onde os dados do cliente devem
ser colhidos — não num Google Forms à parte.

O passo aceita `signer_has_incomplete_fields`. Ligado, ele vai no corpo
de `POST /models/create-doc/` e o signatário é levado ao formulário do
modelo **antes** de assinar, para completar o que `variables` não
preencheu. O que o Cérebro CRM mandou em `data` chega pré-preenchido e não é
redigitado. Os campos são configurados uma vez por modelo, dentro do
ZapSign, com validação por tipo (CPF, CNPJ, telefone brasileiro, data,
valor, e-mail) e obrigatoriedade por campo.

Omitir o parâmetro mantém o comportamento anterior — automação já
configurada não muda de rota por causa de um campo que ninguém marcou.

A alternativa seria um formulário externo, e ela é pior por um motivo
estrutural, não de gosto: o Cérebro CRM **não tem como coletar texto pela
conversa e entregá-lo ao ZapSign**. `interpolate()` só resolve
`{{ message.text }}`, `{{ vars.* }}` e `{{ contact.name }}` /
`{{ contact.first_name }}`, e `vars` não é populado nas
automações (ver [invariantes.md](invariantes.md)). Um formulário fora
exigiria um serviço no meio chamando a API do ZapSign por conta
própria. Dentro do modelo, o dado nasce no documento.

## "Contrato e procuração": um envelope, não dois passos

`extra_template_tokens` no passo anexa outros modelos ao MESMO envelope
do principal (`POST /models/{doc_token}/upload-extra-doc/`). O
signatário recebe **um** link, preenche o formulário **uma vez** e assina
todos os documentos de uma vez.

Que o formulário seja pedido uma vez só para o envelope inteiro não está
documentado pela ZapSign — foi verificado num teste de ponta a ponta, com
contrato e procuração reais, antes de a opção existir. É o motivo de ela
existir: dois passos em sequência geram dois documentos independentes,
com dois links e **duas** rodadas do mesmo formulário de qualificação, e
é aí que o cliente idoso desiste.

O que o corpo do anexo leva é só modelo e variáveis — signatário,
`external_id`, idioma e configuração de envio são herdados do
principal. As mesmas `variables` alimentam todos os documentos, porque
contrato e procuração se qualificam com os mesmos dados.

**Os anexos entram antes de o link sair do motor**, e a ordem não é
estética: `upload-extra-doc` responde 400 depois que o principal foi
assinado, então um envelope que chegou ao signatário incompleto não tem
mais como ser completado.

**Falha ao anexar não apaga a linha, ao contrário da falha de criação.**
Lá não há dúvida a registrar; aqui o documento principal existe e já foi
cobrado, e apagar o registro orfanaria um documento real. A linha fica
com o `zapsign_token` — para o documento ser rastreável na aba
Documentos e cancelável no painel — e **sem** `sign_url`, para que
ninguém mande à mão um envelope incompleto. Não há retentativa
automática: anexo não pode ser removido depois de adicionado, então uma
segunda tentativa sobre um anexo parcialmente aceito duplicaria o
documento sem desfazer. O caminho é cancelar no painel e rodar de novo.

Limites da plataforma, cobrados em `validate.ts` no save e não em tempo
de execução: até 14 anexos por envelope (`MAX_EXTRA_DOCS`), sem modelo
repetido e sem o principal repetido como anexo. Cada anexo consome um
crédito igual ao de um documento principal — o envelope único melhora a
experiência do signatário, não o custo.

### Uma armadilha do formulário: `signer_fullname`

O tipo de campo `signer_fullname` do formulário do modelo **não é
perguntado**: ele vem do `signer_name` da chamada da API, que aqui é
`contact.name` — o nome do perfil do WhatsApp. Num contrato isso passa;
numa procuração é defeito de qualificação, e silencioso, porque o
signatário não vê o campo para corrigir. Para documento que qualifica
parte, o campo do nome no modelo deve ser `input`, e não
`signer_fullname`.

## Configuração (Settings → ZapSign)

Token de API guardado criptografado (AES-256-GCM, mesmo par
`encrypt()`/`decrypt()` de `whatsapp_config.access_token`). `sandbox`
decide o HOST usado pelo cliente (`src/lib/zapsign/client.ts`) —
`sandbox.api.zapsign.com.br` vs `api.zapsign.com.br` — não é um campo no
corpo da requisição; sandbox e produção têm hosts E tokens diferentes.

## Webhook de entrada

`POST /api/webhooks/zapsign/[secret]` — sem sessão, público por desenho
(mesma classe de `/api/whatsapp/webhook`). A ZapSign **não documenta
assinatura HMAC** nos webhooks, então o segredo na própria URL é a
autenticação: gerado com `randomBytes(32)`, mostrado em texto puro **uma
única vez** na tela de configurações (igual API keys / webhook_endpoints),
e guardado só como hash SHA-256 em `zapsign_credentials.webhook_secret_hash`.

Se a URL for perdida, "Regenerar URL do webhook" na tela de
configurações gera um novo segredo — lembre de colar a nova URL nas
configurações de webhook da conta ZapSign também, senão os eventos
param de chegar.

Um documento cujo token não bate com nenhuma linha de
`zapsign_documents` da conta (criado fora do Cérebro CRM, ou de uma conta já
excluída) não é erro: o endpoint responde 200 e ignora — a ZapSign
reenvia em qualquer resposta não-200.

**A transição de status é uma reserva atômica.** O UPDATE carrega
`.neq('status', <alvo>)` e só dispara `document_signed` se afetou
linha, mesmo desenho do claim de `scanStalledDeals` no cron. Ler o
status e depois escrever deixava duas entregas simultâneas — e elas
acontecem, porque a ZapSign reentrega — dispararem o gatilho duas
vezes. Se a gravação falhar, o endpoint devolve **500 de propósito**:
sem a marca gravada, disparar faria a reentrega disparar de novo.

**Status que não reconhecemos é registrado.** Um corpo cujo `status`
não é `signed` nem `refused` sai por um `console.info` com o token e o
que veio. É o único ponto cego possível da integração — se o formato do
webhook mudar, o sintoma é "a automação não roda" e o log é o que dá
por onde começar.

## Import/export de automações

O par é importável e exportável pelo JSON de
[automacoes-import.md](automacoes-import.md). Não era: as listas fechadas
de `src/lib/automations/import.ts` são duplicadas à mão dos tipos de
`@/types`, e a 044 acrescentou o gatilho e o passo ao motor e a
`validate.ts` sem tocá-las. O sintoma era um round-trip quebrado —
`export.ts` não tem lista fechada e emitia a automação sem obstáculo, e o
import a recusava como `unknown_type`. Ao acrescentar tipo, os três
arquivos mudam juntos.

## Onde os documentos aparecem

Aba **Documentos** no painel de detalhe do contato
(`contact-detail-view.tsx`): nome, status, data e — enquanto pendente —
o link de assinatura. É leitura pura sob RLS; a escrita em
`zapsign_documents` continua exclusiva do service-role (motor e
webhook). Sem essa aba, o que foi enviado e o que falta assinar só
existia no detalhe de `automation_logs`.

Depois de assinado, o botão **Baixar assinado** chama
`GET /api/zapsign/documents/[id]/signed-file`, que pede o link ao
ZapSign **na hora** e devolve a URL para o navegador abrir.

**O link nunca é guardado, e isso não é descuido.** A ZapSign documenta
que `original_file` e `signed_file` duram **60 minutos** — conferido num
payload real, onde o `Expires` da URL batia exatamente uma hora depois
de emitida. Uma coluna com esse link seria uma coluna de links mortos.
O PDF também não passa pelo servidor: são arquivos grandes, a URL já é
secreta e expira sozinha, então intermediar só gastaria banda.

## Fora do escopo atual

- Upload de PDF avulso pelo Cérebro CRM — só modelo com variáveis.
- Múltiplos signatários / testemunhas por documento.
- Gatilho `document_refused` / cancelamento de documento. A falha ao
  anexar depende disso: hoje ela avisa e deixa o cancelamento para a
  mão, no painel.
- Botão manual de "enviar para assinatura" fora de uma automação.
