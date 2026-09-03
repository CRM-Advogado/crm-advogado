# Etapa 4 de 5 — Hospedagem (Hostinger)

**Objetivo desta etapa:** ter um site publicado na internet, ligado ao
seu fork do GitHub — ainda sem as configurações finais preenchidas
(isso vem na Etapa 5).

**Tempo estimado:** 20 minutos.

← [Voltar ao índice](./00-comece-aqui.md)

---

## O que é a Hostinger, em uma frase

Até agora, tudo o que você criou (GitHub, Supabase, Meta) mora "nos
bastidores" — nada disso, sozinho, é um site que alguém consegue
abrir no navegador. A **Hostinger** é onde o CRM efetivamente roda,
24 horas por dia, com um endereço próprio na internet. É a única
etapa deste guia que é paga.

## Passo 1 — Criar conta na Hostinger

1. Acesse **[hostinger.com](https://www.hostinger.com/web-apps-hosting)**.
2. Escolha um plano de **hospedagem Node.js** (procure por "Web
   Apps Hosting" ou "Node.js Hosting"). Qualquer plano **Premium**,
   **Business** ou **Cloud** funciona.
3. Complete a compra com seu cartão (ou outro método de pagamento
   aceito). Você recebe acesso ao **hPanel**, o painel de controle da
   Hostinger.

## Passo 2 — Criar o site (aplicação Node.js)

1. Dentro do **hPanel**, vá em **Websites** (Sites).
2. Clique em **Create** (Criar) → escolha a opção de aplicação
   **Node.js**.
3. Quando perguntar a origem do código, escolha **Connect Git
   repository** (Conectar repositório Git).
4. Autorize a Hostinger a acessar sua conta do GitHub (vai abrir uma
   tela do próprio GitHub pedindo permissão — clique em **Authorize**
   ou **Install**).
5. Selecione o repositório que você criou na Etapa 1:
   `SEU-USUARIO/crm-aberto`, e a branch `main`.

## Passo 3 — Configurar como o site é publicado

Nas opções de build/deploy da aplicação:

- **Node.js version**: escolha **20** ou mais recente (o projeto
  exige no mínimo a versão 20).
- **Build command** (comando de build): `npm run build`
- **Start command** (comando de início): `npm run start`
- **Install command**, se pedir: `npm install`
- **Root directory** (diretório raiz): deixe em branco / `/` (o
  projeto está na raiz do repositório).

Se a Hostinger detectar automaticamente que é um projeto Next.js, ela
pode já preencher esses campos sozinha — nesse caso, só confirme que
batem com o que está acima.

## Passo 4 — Onde ficam as variáveis de ambiente (não preencha ainda)

Procure, no painel do seu site, uma seção chamada **Environment
Variables** (Variáveis de Ambiente) — geralmente em **Advanced**
(Avançado) ou dentro das configurações do próprio Node.js app. É aqui
que, na **Etapa 5**, vamos colar todos os códigos que você já anotou
(Supabase, Meta) mais alguns novos.

Por enquanto, **não precisa preencher nada aqui** — só confirme que
você sabe onde fica essa tela, porque vamos voltar a ela na próxima
etapa.

## Passo 5 — Domínio e HTTPS

Você tem duas opções, e pode trocar depois sem problema:

- **Usar um subdomínio grátis da Hostinger** (algo como
  `seu-site.hostingersite.com`) — mais rápido para começar a testar.
- **Conectar um domínio próprio** (ex: `crm.seuescritorio.com.br`) —
  se você já tem um domínio, vá em **Domains** (Domínios) no hPanel e
  siga o assistente para apontá-lo para este site.

De qualquer forma, a Hostinger emite um certificado **SSL grátis**
automaticamente (o cadeado de HTTPS) — não precisa fazer nada manual
para isso, só aguardar alguns minutos após criar/apontar o domínio.

> ⚠️ O WhatsApp da Meta **exige HTTPS** para o webhook (Etapa 5).
> Sem SSL ativo, a integração com o WhatsApp não funciona — mais um
> motivo para confirmar que o cadeado apareceu antes de avançar.

## Passo 6 — Primeiro deploy (publicação)

1. Clique em **Deploy** (ou **Publish**) — pode já estar publicando
   sozinho depois que você conectou o repositório.
2. Acompanhe os **Logs** (Registros) do processo de build. É normal
   levar alguns minutos.
3. **Neste momento, o build provavelmente vai falhar ou o site vai
   abrir com erro** — isso é esperado! Ainda faltam as variáveis de
   ambiente (Supabase, Meta), que preenchemos na próxima etapa. Não se
   preocupe com esse erro agora.

## ✅ Checklist ao final desta etapa

Anote no seu bloco de notas:

- [ ] O endereço do seu site (subdomínio ou domínio próprio):
      `https://________________`
- [ ] Confirmação de que o site está com **HTTPS** ativo (cadeado)
- [ ] Você sabe onde fica a tela **Environment Variables** no painel

## Problemas comuns

- **"A Hostinger não encontra meu repositório do GitHub"** — confirme
  que autorizou o acesso da Hostinger à conta certa do GitHub (se você
  tem mais de uma conta, pode ter autorizado a errada). Em
  **github.com/settings/installations** dá para conferir e ajustar as
  permissões do app da Hostinger.
- **"O build falhou com um erro sobre variável de ambiente
  faltando"** — normal nesta etapa, como avisado no Passo 6. Vamos
  resolver isso na Etapa 5.
- **"Não sei qual plano da Hostinger escolher"** — qualquer um que
  mencione **Node.js** no nome/descrição serve; os planos maiores só
  dão mais capacidade de acessos simultâneos, não mudam o passo a
  passo.

---

**Próxima etapa: [Integração final →](./05-integracao-final.md)**
