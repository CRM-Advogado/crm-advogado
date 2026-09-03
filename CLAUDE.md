@AGENTS.md

# Cérebro CRM — WhatsApp CRM

Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4 + Supabase
(Postgres/Auth/Storage/RLS) + Meta Cloud API. Features: shared inbox,
contacts, Kanban pipelines, broadcasts, no-code automations, visual flows,
AI reply assistant, reporting, public API `/api/v1`, MCP server.

Fork of `ArnasDon/wacrm`. Customizations beyond the upstream include:
migrations `037`–`042`, `src/lib/reports/`, `src/app/(dashboard)/reports/`,
`src/app/api/v1/reports/`, `src/lib/contacts/practice-areas.ts`,
`src/lib/deals/`, `src/app/api/deals/`, and `docs/funil-automatico.md`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server (Turbopack) on :3000 |
| `npm run build` | Production build (includes Next typecheck) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` / `test:watch` | Vitest |

CI (`.github/workflows/ci.yml`): lint → typecheck → test → build. **Does NOT
run `format:check`.** Before closing any change, run `npm run typecheck`
and `npm test`.

## Structure

```
src/app/(auth)/        login, signup, forgot-password
src/app/(dashboard)/   authenticated pages
src/app/api/           dashboard routes — error: { error: string }
src/app/api/v1/        public API by API key — { data } / { error: {code,message} }
src/components/<area>/ components by domain
src/components/ui/     shadcn (base-nova style) over @base-ui/react
src/lib/<domain>/      business logic; most tests live here
src/proxy.ts           session guard + redirects
supabase/migrations/   numbered SQL (001 … 042)
mcp-server/            separate npm package (`wacrm-mcp`), API v1 wrapper
messages/              next-intl: en.json, pt.json, ko.json
docs/                  reference docs — see "Before you start" below
```

Alias: `@/*` → `./src/*`.

## Before you start

This file covers **how we do things** here. What it doesn't cover
— domain-specific rules that you can't deduce from the code alone —
lives in `docs/` for on-demand reading:

| Modifying… | Read first |
| --- | --- |
| any new query, or `supabaseAdmin()` | `docs/mapa-tenancy.md` |
| automations, pipelines, or flows | `docs/invariantes.md` |
| something that looks like a strange bug | `docs/dividas-conhecidas.md` |
| automation import/export | `docs/automacoes-import.md` |
| pipeline triggers, cron | `docs/funil-automatico.md` |
| public API, MCP server | `docs/public-api.md`, `docs/mcp.md` |
| electronic signature (ZapSign) | `docs/zapsign-integration.md` |

The first three take just minutes and prevent the two most expensive failures:
data leakage between accounts and rework from discovering a domain rule too late.

## Authentication and account scoping

Everything is multi-tenant by `account_id`. Roles: `owner > admin > agent > viewer`.

- **Dashboard routes (current convention):** `requireRole('agent')` from
  `@/lib/auth/account` within `try/catch` with `toErrorResponse(err)`.
  When there's no minimum role to enforce, use `getCurrentAccount()`. The `ctx`
  provides `supabase` (SSR client under RLS), `userId`, `accountId`, `role`.
- **Routes `/api/v1`:** `requireApiKey(request, 'contacts:read')` from
  `@/lib/auth/api-context`, with `toApiErrorResponse(err)` from
  `@/lib/api/v1/respond`. The client here is **service-role and bypasses RLS** —
  filter explicitly by `ctx.accountId` in every query.
- **Capabilities** live in `src/lib/auth/roles.ts` (`hasMinRole`,
  `canManageMembers`…). Use the predicates in route guards and UI gates;
  they mirror the SQL helper `is_account_member(account_id, min_role)` from
  migration 017.
- **Known exception:** the 9 routes in `src/app/api/whatsapp/*` (excluding the
  webhook) predate this convention and call `supabase.auth.getUser()` directly.
  When editing them, don't assume `ctx` exists. New routes use `requireRole`.
- **No user session:** `/api/*/cron` authenticates via the `x-cron-secret`
  header against `AUTOMATION_CRON_SECRET`; `/api/whatsapp/webhook` validates
  HMAC (`x-hub-signature-256`); `/api/invitations/[token]/peek` is public by design.

## Supabase clients

Browser: `@/lib/supabase/client` (singleton — don't create another). Server component
or authenticated route: `@/lib/supabase/server` (reads cookies; **never** import in
a client component). Service-role: `supabaseAdmin()` from
`@/lib/flows/admin-client` or `@/lib/automations/admin-client`, only for engines
(cron, webhook, engine), always filtering by `account_id`.

## Migrations

New file numbered in sequence (`043_<slug>.sql`), **idempotent**, with
a commented header explaining why. Never edit an already-applied migration.

**Idempotent includes altering what already exists.** `CREATE TABLE IF NOT
EXISTS` doesn't go back to modify an existing table — if a migration changes
shape before everyone has applied it, the change must also come as an `ALTER`
guarded by a check in `information_schema`. Migration 044 does this with
`zapsign_documents.zapsign_token` and serves as a model.
New table requires RLS with a policy keyed on `is_account_member`. Prettier ignores
`supabase/migrations`.

## i18n

No string literals in the UI. Every key goes into **all three** dictionaries.
`src/i18n/messages.test.ts` compares in both directions and breaks CI both if
a key is missing in `pt`/`ko` and if a key exists that's not in `en`
(`en.json` is the source of truth; there's no per-key fallback). Locale comes from
`NEXT_PUBLIC_APP_LOCALE`, default `en`.

## Tests

Vitest, `node` environment, files named `*.test.ts(x)` colocated with code. Most
tests cover `src/lib`, but there are also route tests
(`src/app/api/**/route.test.ts`), proxy tests, and component tests. Prefer testing
the function in `src/lib` over testing the handler. Fake secrets (`ENCRYPTION_KEY`,
`META_APP_SECRET`) come from `vitest.config.ts` — `lib/whatsapp/encryption.ts` and
`webhook-signature.ts` read them at module load time, and vitest's env takes
precedence in CI tests too (the `ci.yml` defines its own dummies for the
build). No test touches Supabase or Meta for real.

## Environment variables

Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` (32 bytes hex, AES-256-GCM),
`META_APP_SECRET`. Recommended (have defaults): `NEXT_PUBLIC_SITE_URL`
(without it, origin is derived from the request) and `NEXT_PUBLIC_APP_LOCALE`
(default `en`).

Optional (commented in `.env.local.example`): `AUTOMATION_CRON_SECRET`,
`ALLOWED_INVITE_HOSTS`, `META_APP_ID`, `WHATSAPP_TEMPLATES_DRY_RUN`,
`AI_REQUEST_TIMEOUT_MS`, `AI_CONTEXT_MESSAGE_LIMIT`. `ALLOWED_DEV_ORIGINS` is
read in `next.config.ts` and doesn't appear in the example file. The `WACRM_*`
vars belong to `mcp-server/`, which has its own `.env.example`.

The endpoints `/api/automations/cron` and `/api/flows/cron` require an external
HTTP scheduler (managed hosting, no crontab) — see
`docs/funil-automatico.md`.

## Pitfalls

- **Next.js 16 has breaking changes** from what the docs may say.
  Check `node_modules/next/dist/docs/` before writing framework code
  (see `AGENTS.md`).
- **`src/components/ui/` is shadcn over `@base-ui/react`, not Radix.** The usual
  `@radix-ui/*` patterns don't apply; follow the pattern of the neighboring component.
- **Don't run `npm run format` on the entire tree.** 353 of 362 `src` files
  diverge from `.prettierrc` (semicolons, quotes, and line endings) —
  formatting everything generates a diff that buries the real change. CI doesn't
  check formatting. Format only the files you touched.
- **CRLF on disk, LF in the repo** (`git ls-files --eol` → `i/lf w/crlf`),
  no `.gitattributes`. On Windows with `core.autocrlf=true` it works and the diff
  is correct. Reading the folder from another environment (Linux, container, agent),
  the diff appears inflated with entire files rewritten — compare with
  `git -c core.autocrlf=true diff` before concluding something changed.
- **`src/proxy.ts`** (was `middleware.ts` — renamed to the Next 16 `proxy`
  convention): every new response (redirect or JSON) must pass through
  `withRefreshedCookies()`, or the rotated refresh token is lost and the
  session freezes.
- **CSP is in `Report-Only`** (`next.config.ts`). New external origins need to
  be reflected there.
