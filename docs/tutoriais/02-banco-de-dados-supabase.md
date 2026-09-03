# Etapa 2 de 5 — Banco de dados (Supabase)

**Objetivo desta etapa:** criar o banco de dados do seu CRM e coletar
3 códigos que vamos usar na Etapa 5.

**Tempo estimado:** 20 minutos.

← [Voltar ao índice](./00-comece-aqui.md)

---

## O que é o Supabase, em uma frase

Todo CRM precisa guardar informação em algum lugar — contatos,
conversas, funis, usuários. O **Supabase** é esse "banco de dados",
já pronto, hospedado, com login de usuários incluído. Você não precisa
saber nada de banco de dados: vamos criar o projeto e rodar um comando
que cria todas as tabelas automaticamente.

## Passo 1 — Criar conta no Supabase

1. Acesse **[supabase.com](https://supabase.com)**.
2. Clique em **Start your project** (ou **Sign in**, no canto superior
   direito, se já tiver conta).
3. O jeito mais rápido é clicar em **Continue with GitHub** e usar a
   conta do GitHub que você criou na Etapa 1 — assim você não precisa
   inventar mais uma senha. Autorize o Supabase quando o GitHub
   perguntar.

## Passo 2 — Criar o projeto (o banco de dados em si)

1. Você vai cair numa tela de **Organizations** (Organizações). Se for
   sua primeira vez, clique em **New organization**, dê um nome
   (ex: o nome do seu escritório) e confirme. Pode deixar o plano
   **Free**.
2. Clique em **New project**.
3. Preencha:
   - **Name** (Nome): algo como `crm-meu-escritorio`.
   - **Database Password** (Senha do banco de dados): clique em
     **Generate a password** para gerar uma senha forte automática.
     **Copie essa senha e cole no seu bloco de notas agora** — ela não
     aparece de novo depois.
   - **Region** (Região): escolha a mais próxima do Brasil disponível
     (procure por algo como `South America (São Paulo)`; se não
     tiver, `US East` é a alternativa mais comum).
   - **Pricing Plan**: deixe **Free**.
4. Clique em **Create new project**.
5. Espere — o Supabase leva de 1 a 3 minutos provisionando o banco.
   Não feche a aba.

## Passo 3 — Copiar as chaves de API

Quando o projeto terminar de ser criado:

1. No menu da esquerda, clique no ícone de engrenagem **Project
   Settings** (Configurações do Projeto), lá embaixo.
2. Clique em **API** (ou **API Keys**, dependendo da versão da tela).
3. Você vai ver algumas informações — copie e cole cada uma no seu
   bloco de notas, com um nome do lado para não confundir:

   | Na tela do Supabase | Anote como |
   |---|---|
   | **Project URL** | `NEXT_PUBLIC_SUPABASE_URL` |
   | **anon** / **public** key (uma sequência longa de letras e números) | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
   | **service_role** key (outra sequência longa — pode estar atrás de um botão "Reveal"/"Mostrar") | `SUPABASE_SERVICE_ROLE_KEY` |

> ⚠️ **A chave `service_role` é tão sensível quanto a senha do banco.**
> Ela ignora todas as travas de segurança do sistema. Nunca a envie por
> WhatsApp, e-mail comum ou a cole em nenhum site além do painel da
> Hostinger (Etapa 4/5). Se algum dia desconfiar que ela vazou, volte
> nesta mesma tela e clique em **Reset**/**Regenerate**.

## Passo 4 — Criar as tabelas do CRM (rodar as "migrations")

O código do CRM vem com 43 arquivos prontos que criam todas as
tabelas, uma por uma, na ordem certa. Chamamos isso de **migrations**.
Você não precisa entender o conteúdo deles — só rodar um comando.

Isso exige o **Node.js** instalado no seu computador (o mesmo programa
que você vai usar para testar o CRM localmente — veja o `README.md`
do projeto, seção "Começando rápido", se ainda não instalou) e o
código do projeto baixado no seu computador (`git clone` do seu fork
da Etapa 1).

Abra um terminal (Prompt de Comando, PowerShell ou Terminal, dentro da
pasta onde você baixou o projeto) e rode, um comando de cada vez:

```bash
npx supabase login
```
Isso abre uma página no navegador pedindo para autorizar — clique em
**Authorize**. Volte ao terminal.

```bash
npx supabase link --project-ref SEU_PROJECT_REF
```
O `SEU_PROJECT_REF` é um código que aparece na URL do seu projeto no
Supabase, por exemplo: se a URL do painel é
`supabase.com/dashboard/project/abcdefghijklmnop`, o `PROJECT_REF` é
`abcdefghijklmnop`. Ele vai pedir a senha do banco (a que você gerou e
guardou no Passo 2) — cole e confirme.

```bash
npx supabase db push
```
Este é o comando que efetivamente cria as 43 tabelas. Ele mostra uma
lista de arquivos que serão aplicados e pergunta se você confirma —
digite `Y` e aperte Enter. Pode levar 1–2 minutos.

Ao final, deve aparecer algo como `Finished supabase db push`.

> 🛟 **Se algum desses comandos der erro:** o caminho alternativo (mais
> manual, mas sem depender de terminal) é abrir, no painel do
> Supabase, o menu **SQL Editor**, e colar o conteúdo de cada arquivo
> da pasta `supabase/migrations/` do projeto, um de cada vez, **na
> ordem numérica** (`001_...sql`, depois `002_...sql`, e assim por
> diante), clicando em **Run** a cada um. É mais trabalhoso (43
> arquivos), mas funciona sempre.

## Passo 5 — Configurar o endereço de confirmação de e-mail

Quando alguém cria uma conta no seu CRM, o Supabase manda um e-mail de
confirmação com um link. Esse link precisa saber para onde apontar.

1. No menu da esquerda, vá em **Authentication** (Autenticação).
2. Clique em **URL Configuration** (Configuração de URL).
3. No campo **Site URL**, digite, por enquanto:
   ```
   http://localhost:3000
   ```
   (Vamos trocar isso pelo endereço definitivo do seu CRM na Etapa 5,
   assim que ele estiver publicado.)
4. Clique em **Save** (Salvar).

> 💡 Dica para testar mais rápido enquanto ainda está tudo em
> desenvolvimento: em **Authentication → Sign In / Providers → Email**,
> existe uma opção **Confirm email**. Deixá-la desligada evita ter que
> confirmar e-mail toda vez que você cria uma conta de teste. **Lembre
> de religar antes de usar com clientes de verdade**, para exigir
> e-mail confirmado.

## ✅ Checklist ao final desta etapa

Confira se você anotou, no seu bloco de notas:

- [ ] `NEXT_PUBLIC_SUPABASE_URL`
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- [ ] `SUPABASE_SERVICE_ROLE_KEY`
- [ ] A senha do banco de dados (Database Password)
- [ ] O `PROJECT_REF` do seu projeto
- [ ] Confirmação de que `npx supabase db push` terminou sem erro

## Problemas comuns

- **"`npx supabase login` não abre nada no navegador"** — copie o link
  que aparece no terminal e cole manualmente no navegador.
- **"Esqueci a senha do banco"** — em **Project Settings → Database**,
  há um botão para gerar uma nova senha. Isso não apaga nenhuma
  tabela, só troca a senha de acesso.
- **"`db push` diz que já existem migrations aplicadas"** — normal se
  você rodar o comando duas vezes; ele simplesmente não repete o que
  já foi feito.

---

**Próxima etapa: [WhatsApp Business (Meta) →](./03-whatsapp-meta.md)**
