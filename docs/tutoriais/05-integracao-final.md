# Etapa 5 de 5 — Integração final

**Objetivo desta etapa:** juntar tudo o que você criou nas etapas
anteriores, publicar de verdade e mandar a primeira mensagem de
WhatsApp através do seu CRM.

**Tempo estimado:** 20 minutos.

← [Voltar ao índice](./00-comece-aqui.md)

---

## Antes de começar, confira se você tem em mãos

Do seu bloco de notas, das etapas anteriores:

- **Da Etapa 2 (Supabase):** `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Da Etapa 3 (Meta):** `PHONE_NUMBER_ID`, `WABA_ID`, `ACCESS_TOKEN`,
  `META_APP_SECRET`
- **Da Etapa 4 (Hostinger):** o endereço do seu site publicado (ex:
  `https://meucrm.hostingersite.com`)

Se faltar algum, volte na etapa correspondente antes de continuar.

## Passo 1 — Gerar a chave de criptografia

O CRM guarda o token de acesso do WhatsApp de forma criptografada
dentro do banco de dados — para isso, ele precisa de uma chave só
sua, que nunca sai do seu servidor.

Se você tem o Node.js instalado no seu computador, abra um terminal e
rode:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Isso imprime uma sequência de 64 caracteres (letras e números). Copie
e anote como `ENCRYPTION_KEY`.

> 🛟 **Não tem Node.js instalado?** Peça para alguém de confiança gerar
> para você, ou use um gerador de "hexadecimal aleatório de 32 bytes /
> 64 caracteres" — o importante é que seja aleatório e que **só você**
> tenha essa chave. Guarde-a com o mesmo cuidado que a senha do banco:
> se ela mudar depois, todo mundo precisa reconectar o WhatsApp de novo.

## Passo 2 — Preencher as variáveis de ambiente na Hostinger

1. Volte ao **hPanel** → seu site → **Environment Variables** (a tela
   que você localizou na Etapa 4).
2. Adicione, uma por uma (nome exato à esquerda, valor à direita):

   | Nome da variável | Valor |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | o que você anotou na Etapa 2 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | o que você anotou na Etapa 2 |
   | `SUPABASE_SERVICE_ROLE_KEY` | o que você anotou na Etapa 2 |
   | `ENCRYPTION_KEY` | o que você gerou no Passo 1 acima |
   | `META_APP_SECRET` | o que você anotou na Etapa 3 |
   | `NEXT_PUBLIC_SITE_URL` | o endereço do seu site (Etapa 4), ex: `https://meucrm.hostingersite.com` — **sem barra no final** |
   | `NEXT_PUBLIC_APP_LOCALE` | `pt` |

   > `PHONE_NUMBER_ID`, `WABA_ID` e `ACCESS_TOKEN` (da Meta) **não vão
   > aqui** — eles são colados dentro do próprio CRM, no Passo 5. Só
   > `META_APP_SECRET` é variável de ambiente.

3. Salve e **publique/reinicie** o site (procure um botão
   **Redeploy**, **Restart** ou similar — variáveis de ambiente só
   valem a partir do próximo início da aplicação).
4. Acompanhe os **Logs** de novo. Desta vez o build deve terminar sem
   erro.

## Passo 3 — Atualizar o endereço de confirmação no Supabase

Agora que você tem o endereço definitivo do site, volte ao Supabase e
corrija o que deixamos como provisório na Etapa 2:

1. No painel do Supabase, **Authentication → URL Configuration**.
2. Troque o campo **Site URL** de `http://localhost:3000` para o
   endereço real do seu site (o mesmo que você colocou em
   `NEXT_PUBLIC_SITE_URL` acima).
3. Salve.

## Passo 4 — Criar sua conta de dono (owner) no CRM

1. Abra o endereço do seu site no navegador.
2. Você deve ver a tela de **login**. Clique em **Cadastre-se** /
   **Criar conta**.
3. Preencha seu nome, e-mail e uma senha.
4. Se a confirmação de e-mail estiver ativa (Etapa 2), confira sua
   caixa de entrada e clique no link de confirmação.
5. Faça login. Você deve cair no **Dashboard** do CRM, vazio — é
   esperado, ainda não conectamos o WhatsApp.

## Passo 5 — Conectar o WhatsApp dentro do CRM

1. Dentro do CRM, vá em **Configurações → Conexão do WhatsApp**
   (menu de Configurações, ícone de engrenagem).
2. Preencha os campos com o que você anotou na **Etapa 3**:
   - **ID do Número de Telefone** → `PHONE_NUMBER_ID`
   - **ID da Conta Comercial do WhatsApp** → `WABA_ID`
   - **Token de Acesso Permanente** → `ACCESS_TOKEN`
   - **Token de Verificação do Webhook** → invente uma senha qualquer,
     só para essa finalidade (ex: uma frase aleatória sem espaços,
     tipo `verifica-crm-8k2p9`). Anote-a — você vai usar de novo daqui
     a pouco.
   - **PIN de verificação em duas etapas**: deixe em branco (só é
     necessário para número de produção real, não para o número de
     teste da Meta).
3. Clique em **Salvar Configuração**.
4. A tela agora mostra uma **URL de Callback do Webhook** — algo como:
   ```
   https://meucrm.hostingersite.com/api/whatsapp/webhook
   ```
   **Copie essa URL inteira.**

## Passo 6 — Configurar o Webhook na Meta

1. Volte ao painel da Meta
   ([developers.facebook.com](https://developers.facebook.com)) → seu
   App → **WhatsApp → Configuração**.
2. Na seção **Webhook**, clique em **Editar**.
3. Preencha:
   - **Callback URL**: cole a URL que você copiou no Passo 5.
   - **Verify token**: digite **exatamente** a mesma senha que você
     inventou no Passo 5 (o "Token de Verificação do Webhook").
4. Clique em **Verificar e salvar** (Verify and Save). Se der certo,
   a Meta confirma na hora — se der erro, veja "Problemas comuns"
   abaixo.
5. Ainda nessa tela, em **Webhook fields** (campos do webhook),
   encontre `messages` e clique em **Inscrever-se** (Subscribe).

## Passo 7 — Teste de verdade

1. Pegue o celular que você cadastrou como número de teste na
   **Etapa 3**.
2. Envie uma mensagem de WhatsApp para o número de teste da Meta
   (o número aparece na tela **WhatsApp → Configuração da API**).
3. Volte ao seu CRM, na **Caixa de entrada** (Inbox) — a mensagem deve
   aparecer em poucos segundos.
4. Responda pela própria tela do CRM.
5. Confira no celular que a resposta chegou.

**Se os dois passos acima funcionaram — parabéns, seu CRM está no ar e
funcionando de ponta a ponta.** 🎉

## Próximos passos (opcionais)

- **Convide sua equipe**: Configurações → Equipe → convidar por link.
- **Explore as automações**: crie a primeira automação de boas-vindas
  em Automações → Nova Automação.
- **Quando quiser usar o número de produção do escritório** (em vez do
  número de teste da Meta): volte à Etapa 3, adicione o número real na
  Meta, gere o PIN de verificação em duas etapas nele (Business
  Manager → Contas do WhatsApp → Números de Telefone → Verificação em
  duas etapas) e cole esse PIN na tela **Configurações → Conexão do
  WhatsApp** do CRM antes de salvar de novo.

## Problemas comuns

- **"A Meta não conseguiu verificar o webhook"** — as causas mais
  comuns, em ordem de frequência:
  1. O **Verify token** digitado na Meta não é idêntico, caractere
     por caractere, ao salvo no CRM (maiúscula/minúscula importa).
  2. O site ainda não tem certificado **HTTPS** válido (confira o
     cadeado no navegador).
  3. A variável `NEXT_PUBLIC_SITE_URL` está errada ou com uma barra
     `/` sobrando no final.
- **"As mensagens chegam no CRM, mas não aparecem como 'Registrado'
  nas Configurações"** — normalmente é o PIN de verificação em duas
  etapas faltando (só é obrigatório para número de produção, não para
  o de teste). Veja "Próximos passos" acima.
- **"Não recebi o e-mail de confirmação ao criar minha conta no
  CRM"** — confira o Passo 3 desta etapa (Site URL do Supabase
  correto) e o Passo 5 da Etapa 2 (opção Confirm Email).
- **"Mudei uma variável de ambiente e não fez efeito"** — variáveis de
  ambiente só são lidas quando a aplicação **reinicia**. Sempre clique
  em Redeploy/Restart depois de qualquer alteração.

---

← [Voltar ao índice](./00-comece-aqui.md)
