# Cérebro CRM no Cloudflare Workers

O app Next.js roda como Worker pelo OpenNext. As APIs, o proxy de autenticação e os assets do app são publicados juntos. A landing do Cloudflare Pages tem publicação independente.

Use Node.js 22 para as ferramentas do Cloudflare. Configure `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL` e `NEXT_PUBLIC_APP_LOCALE=pt` no ambiente de build. A chave publicável é a única chave do Supabase usada nessa etapa.

```sh
npm ci
npm run build:cloudflare
npx wrangler deploy --dry-run
```

No Worker de destino, configure `SUPABASE_SERVICE_ROLE_KEY` e `ENCRYPTION_KEY` como segredos de execução. Reutilize a chave de criptografia do ambiente se já houver credenciais criptografadas. As credenciais dos provedores só são necessárias para os recursos que forem ativados nesse ambiente.

A migração `048_dashboard_metrics.sql` deve estar aplicada ao Supabase de destino antes da publicação. Use o [fluxo de branches do CRM](branches-e-ambientes.md) e publique o build validado na conta e no projeto corretos:

```sh
npx wrangler deploy
```

Confirme que o domínio do Worker está autorizado nos redirecionamentos do Supabase Auth. No domínio publicado, verifique o login e o redirecionamento anônimo em `/dashboard`, confirme o HTTP 401 em `/api/whatsapp/config` sem sessão e teste Painel, Contatos e Funis com uma conta autorizada.
