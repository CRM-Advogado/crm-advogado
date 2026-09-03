# Etapa 3 de 5 — WhatsApp Business (Meta)

**Objetivo desta etapa:** conectar um número de WhatsApp à API oficial
da Meta e coletar 4 códigos que vamos usar na Etapa 5.

**Tempo estimado:** 30 a 60 minutos (a Meta às vezes pede verificações
extras que fogem do nosso controle).

← [Voltar ao índice](./00-comece-aqui.md)

---

## O que é isso, em uma frase

O WhatsApp normal (o aplicativo no seu celular) não conversa com
sistemas externos. Para um CRM enviar e receber mensagens
automaticamente, é preciso usar a **API oficial do WhatsApp Business**,
que é da própria Meta (dona do WhatsApp, Facebook e Instagram). Esta
etapa é sobre criar acesso a essa API — não sobre configurar o
aplicativo de WhatsApp do seu celular.

> 💡 **Boa notícia para testar sem compromisso:** a Meta libera um
> **número de teste gratuito**, sem precisar de CNPJ nem de um número
> de telefone próprio, para você experimentar tudo antes de usar o
> número de verdade do escritório. Vamos usar esse número de teste
> primeiro.

## Antes de começar, você precisa de:

- [ ] Uma conta pessoal no **Facebook** (é o login usado para acessar
      o painel de desenvolvedor — se você não tem, crie uma em
      [facebook.com](https://facebook.com); não precisa ser uma conta
      "profissional" chamativa, pode ser discreta).
- [ ] Um **celular à mão**, para receber a mensagem de teste mais
      tarde.

## Passo 1 — Criar uma conta de desenvolvedor na Meta

1. Acesse **[developers.facebook.com](https://developers.facebook.com)**.
2. Clique em **Fazer login** (canto superior direito) e entre com sua
   conta do Facebook.
3. Se for a primeira vez, a Meta vai pedir para **"Tornar-se
   desenvolvedor"** — aceite os termos e confirme seu e-mail/telefone
   se solicitado.

## Passo 2 — Criar um App

Um "App" aqui não é um aplicativo de celular — é só o "espaço de
trabalho" dentro da Meta onde ficam as configurações do seu WhatsApp.

1. No painel, clique em **Meus Apps** (My Apps), no menu superior.
2. Clique em **Criar App** (Create App).
3. Quando perguntar o tipo de app, selecione **Empresa** (Business).
4. Preencha:
   - **Nome do app**: algo como `CRM Escritório [seu nome]`.
   - **E-mail de contato**: o seu e-mail.
   - Se pedir para vincular uma **Conta Comercial** (Business
     Portfolio) e você ainda não tiver uma, escolha a opção de criar
     uma nova — pode usar o nome do seu escritório.
5. Clique em **Criar app**. Pode pedir para confirmar sua senha do
   Facebook novamente.

## Passo 3 — Adicionar o produto WhatsApp

1. Dentro do painel do seu app recém-criado, procure a lista de
   **produtos** (na página inicial do app, ou no menu **Adicionar
   Produto**).
2. Encontre o card **WhatsApp** e clique em **Configurar**.
3. A Meta vai te guiar por um assistente rápido — se pedir para
   escolher/criar uma Conta Comercial, use a mesma do passo anterior.

Ao terminar, você cai numa tela chamada **WhatsApp → Configuração da
API** (API Setup). Essa tela já vem com:

- Um **número de teste** da própria Meta, pronto para usar (grátis,
  sem precisar verificar nada ainda).
- Um campo para adicionar **números de destinatário de teste** — aqui
  você deve **adicionar o seu próprio celular**, confirmando com o
  código de SMS que a Meta manda, para poder receber mensagens de
  teste nele.

## Passo 4 — Copiar as credenciais da API

Ainda na tela **WhatsApp → Configuração da API**:

| Na tela da Meta | Anote como |
|---|---|
| **Phone number ID** (ID do número de telefone) | `PHONE_NUMBER_ID` |
| **WhatsApp Business Account ID** (ID da Conta Comercial do WhatsApp) | `WABA_ID` |

Copie os dois para o seu bloco de notas.

## Passo 5 — Gerar um token de acesso permanente

A tela de configuração mostra, por padrão, um **token temporário** que
expira em 24 horas — ele serve só para testar rapidinho ali mesmo, não
para o CRM usar de verdade (ele pararia de funcionar todo dia). Vamos
gerar um **token permanente**, através de um "Usuário de Sistema":

1. Saia da tela do App e vá para o
   **[Business Settings](https://business.facebook.com/settings)**
   (Configurações da Empresa) da sua Conta Comercial.
2. No menu da esquerda, em **Usuários**, clique em **Usuários do
   Sistema** (System Users).
3. Clique em **Adicionar** (Add), dê um nome (ex: `crm-integracao`),
   escolha a função **Admin**, confirme.
4. Com o usuário criado, clique nele e depois em **Adicionar Ativos**
   (Add Assets):
   - Selecione **Apps**, marque o app que você criou no Passo 2, dê
     permissão de controle total (**Manage app**).
5. Ainda na tela do usuário de sistema, clique em **Gerar novo token**
   (Generate New Token):
   - Selecione o app criado no Passo 2.
   - Marque as permissões: `whatsapp_business_messaging` e
     `whatsapp_business_management`.
   - Defina a expiração como **Nunca** (Never), se essa opção
     aparecer.
   - Clique em **Gerar token**.
6. **Copie o token imediatamente e cole no seu bloco de notas** — ele
   só aparece uma vez nessa tela. Anote como `ACCESS_TOKEN`.

## Passo 6 — Copiar o "App Secret"

1. Volte ao painel do seu App (developers.facebook.com → Meus Apps →
   o app que você criou).
2. No menu da esquerda, vá em **Configurações do App → Básico**
   (App Settings → Basic).
3. Ao lado de **Chave Secreta do App** (App Secret), clique em
   **Mostrar** (pode pedir sua senha do Facebook de novo).
4. Copie o valor e anote como `META_APP_SECRET`.

## O que fica para depois (Etapa 5)

Duas coisas da configuração da Meta só dá para terminar **depois** que
o seu CRM já estiver publicado na internet (Etapa 4), porque elas
pedem o endereço do seu site:

- Configurar o **Webhook** (para a Meta avisar seu CRM quando chegar
  mensagem).
- Testar o envio e recebimento de mensagens de verdade.

Isso está detalhado no início da **[Etapa 5 — Integração final](./05-integracao-final.md)**.

## ✅ Checklist ao final desta etapa

Anote no seu bloco de notas:

- [ ] `PHONE_NUMBER_ID`
- [ ] `WABA_ID`
- [ ] `ACCESS_TOKEN` (o permanente, gerado via Usuário de Sistema —
      **não** o temporário de 24h)
- [ ] `META_APP_SECRET`
- [ ] Seu celular cadastrado como número de teste para receber
      mensagens

## Problemas comuns

- **"Meu token parou de funcionar depois de um dia"** — você copiou o
  token temporário da tela inicial, não o permanente do Usuário de
  Sistema. Refaça o Passo 5.
- **"Não acho a opção 'Usuários do Sistema'"** — ela fica nas
  **Configurações do Negócio** (business.facebook.com/settings), não
  dentro do painel do App. São duas telas diferentes da Meta.
- **"A Meta está pedindo verificação da empresa (Business
  Verification)"** — isso normalmente só é exigido quando você quer
  usar um número de telefone de produção (não o de teste) ou passar de
  um certo volume de mensagens. Para testar tudo com o número de
  teste, geralmente não é necessário ainda. Se pedir, a Meta guia você
  pelo processo (envio de CNPJ, comprovante, etc.) — pode levar de
  horas a poucos dias para aprovar.
- **"Não sei se o número de teste tem custo"** — não tem. A cobrança
  da Meta só começa quando você usa um número de telefone de produção
  além do volume gratuito mensal.

---

**Próxima etapa: [Hospedagem (Hostinger) →](./04-hospedagem-hostinger.md)**
