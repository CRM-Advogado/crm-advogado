# Comece aqui — guia de implantação do Cérebro CRM

Este é o ponto de partida para colocar o Cérebro CRM no ar, mesmo que
você nunca tenha mexido com programação. Vamos com calma, um passo de
cada vez, sem pular nada.

## Para quem é este guia

Para advogados e equipes de escritório que querem ter seu próprio CRM
de WhatsApp, sem depender de mensalidade de SaaS, sem precisar
contratar um programador para o básico. Você não precisa saber nada de
código — só precisa conseguir seguir instruções na tela e criar umas
poucas contas gratuitas.

## O que vamos fazer, em 5 etapas

Cada etapa é um documento separado, nesta mesma pasta. Siga na ordem —
uma depende da anterior.

| # | Etapa | O que você ganha ao final | Tempo aproximado |
|---|-------|---------------------------|-------------------|
| 1 | [GitHub](./01-github.md) | Sua própria cópia do projeto | 10 min |
| 2 | [Banco de dados (Supabase)](./02-banco-de-dados-supabase.md) | O "banco" onde ficam contatos, conversas, usuários | 20 min |
| 3 | [WhatsApp Business (Meta)](./03-whatsapp-meta.md) | Um número de WhatsApp conectado à API oficial | 30–60 min |
| 4 | [Hospedagem (Hostinger)](./04-hospedagem-hostinger.md) | Seu CRM publicado, com endereço próprio na internet | 20 min |
| 5 | [Integração final](./05-integracao-final.md) | Tudo ligado e funcionando — primeira mensagem indo e voltando | 20 min |

Total: entre 1h30 e 2h30, dependendo principalmente da etapa da Meta
(que às vezes pede verificações extras).

> 💡 Você não precisa terminar tudo de uma vez. Pode fazer uma etapa
> hoje e continuar amanhã — cada etapa termina com uma lista do que
> anotar para usar mais adiante.

## O que você vai precisar antes de começar

- [ ] Um **computador** com internet (Windows, Mac ou Linux — tanto
      faz).
- [ ] Um **e-mail** que você usa de verdade (vai receber confirmações
      de várias dessas contas).
- [ ] Um **número de WhatsApp** — não precisa ser logo de cara o
      número final do escritório. A Meta te dá um número de teste
      grátis para você experimentar antes de comprometer o número de
      produção (explicado na etapa 3).
- [ ] Um **cartão de crédito** — não é cobrado nada nas contas
      gratuitas que vamos criar (GitHub, Supabase, conta de
      desenvolvedor da Meta), mas a Hostinger é paga (planos a partir
      de poucos dólares por mês). Sem cartão, você não consegue
      concluir a etapa 4.
- [ ] Um **bloco de notas** (pode ser o Bloco de Notas do Windows
      mesmo) para colar e guardar códigos e senhas conforme você for
      gerando — vamos pedir para anotar várias coisas ao longo do
      caminho.

## Contas que você vai criar

Nenhuma delas está ligada à sua conta pessoal de WhatsApp ou às contas
que o seu escritório já usa hoje — são contas novas, só para este
CRM:

1. **GitHub** — onde fica o código do projeto (gratuito).
2. **Supabase** — o banco de dados (gratuito no plano que vamos usar).
3. **Meta for Developers** — para conectar o WhatsApp Business
   (gratuito; a Meta cobra depois pelo uso do WhatsApp, não pela
   conta).
4. **Hostinger** — onde o CRM fica publicado, no ar 24 horas (pago).

## O que este projeto NÃO faz por você

Para não ter surpresa: este é um **template que você mesmo hospeda e
opera**. Isso quer dizer que:

- Você é responsável por manter as contas acima em dia (ex: pagar a
  Hostinger).
- Você é responsável pelo tratamento dos dados dos seus clientes
  (LGPD) — o CRM te dá as ferramentas (dados isolados por conta,
  criptografia de tokens), mas a responsabilidade legal pelo uso é
  sua, como acontece com qualquer sistema que você opera.
- A Meta cobra por conversa de WhatsApp acima de um certo volume
  gratuito mensal — vale conferir os preços atuais da
  [API do WhatsApp Business](https://developers.facebook.com/docs/whatsapp/pricing)
  antes de usar em produção com muitos clientes.

## Pronto para começar?

Vá para a **[Etapa 1 — GitHub →](./01-github.md)**
