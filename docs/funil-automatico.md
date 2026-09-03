# Automatic pipeline movement

Before migration 042, the CRM pipeline was a **passive destination**. The automation
engine could create a deal but never touched it afterward; no trigger could see the
pipeline; and dragging cards on the board wrote directly from the browser, with no
server in the loop to hook reactions to. Practical consequence: every lead had to be
moved by hand, card by card.

This document describes what migration 042 enables and how to set it up.

---

## Four-step setup

### 1. Apply the migration

```bash
supabase db push
```

Migration `042` installs the mechanism for deal movement triggered by automations.

To seed your own pipelines and automation rules, you can write SQL after the migration
is applied. An example seed function (`seed_custom_pipeline`) can be created to match
your business process.

### 2. Enable the cron

Without this, inactivity triggers **never fire** — and the wait steps (`wait`) in all
your automations stay blocked, just as they did before this change.

The secret is already in `.env.local.example` as `AUTOMATION_CRON_SECRET`. It also
needs to be in your **hosting** environment variables — `.env.local` lives on your
machine and does not upload on deploy.

> **Don't use `crontab`.** This app runs on managed hosting (e.g., Hostinger Managed
> Node.js). There's no VPS, no SSH, no shell where a crontab could exist. Scheduling
> is done by HTTP, from outside the app.

There are **two** tasks, every five minutes, both with the same secret
— the flows endpoint reuses `AUTOMATION_CRON_SECRET` on purpose,
so you only have to store one key:

```
*/5 * * * * curl -s -H "x-cron-secret: YOUR_SECRET" https://YOUR-DOMAIN/api/automations/cron
*/5 * * * * curl -s -H "x-cron-secret: YOUR_SECRET" https://YOUR-DOMAIN/api/flows/cron
```

**Option A — Cron Jobs in your hosting panel.** Look for Cron Jobs in Advanced settings.
If your plan offers it for Node apps, this is the simplest path.

**Option B — External HTTP scheduler.** If the panel doesn't offer it, use a scheduling
service that supports **custom headers** — `x-cron-secret` is required, and without it
the route returns `401`. Method `GET`, every 5 minutes, the same two URLs.

To verify it responded, in PowerShell:

```powershell
curl.exe -s -H "x-cron-secret: YOUR_SECRET" https://YOUR-DOMAIN/api/automations/cron
```

Use `curl.exe`, not `curl`: in PowerShell, `curl` is an alias for
`Invoke-WebRequest`, which doesn't understand the `-H` syntax.

#### Testing on your machine before publishing

With `npm run dev` running, the scan can be called by hand — you don't need a
scheduler at all to see the inactivity trigger work:

```powershell
curl.exe -s -H "x-cron-secret: $env:AUTOMATION_CRON_SECRET" http://localhost:3000/api/automations/cron
```

If the call returns `200` and your browser still shows the original content without
error, the route accepted the secret and ran the scan.

### 3. Create your pipeline

In the dashboard, create a new pipeline with the stages that match your business:
**Inquiry** → **Qualification** → **Proposal** → **Negotiation** → **Won** (example).

### 4. Wire up the automations

In the automation builder, use the **Deal stage changed** trigger and **Move deal to stage**
action to connect your process. For example:

- When a conversation is tagged "qualified", move the deal to "Qualification".
- When 30 days pass without a reply, move to "Stale" and send a reminder.

---

## Migration 042: What it does

- Adds webhooks to the automation engine so deals can move on certain events
  (tags added, messages received, time elapsed, other deals moved).
- Adds the **Move deal to stage** action step to automations.
- Updates the front-end pipeline view to show deal counts per stage in real time.

The seeding of a specific pipeline shape (stages, initial automations) is not included
in the migration — you build that in the dashboard or with your own seed function.
