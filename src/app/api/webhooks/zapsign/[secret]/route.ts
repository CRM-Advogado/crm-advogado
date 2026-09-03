import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { hashWebhookSecret } from '@/lib/zapsign/credentials';
import { runAutomationsForTrigger } from '@/lib/automations/engine';

type Params = { params: Promise<{ secret: string }> };

// Lazy-initialized, mirrors src/app/api/whatsapp/webhook/route.ts —
// avoids a build-time crash when env vars are absent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

/**
 * POST /api/webhooks/zapsign/[secret]
 *
 * Public by design, no session (migration 044 / docs/zapsign-integration.md)
 * — mirrors /api/whatsapp/webhook and /api/invitations/[token]/peek in
 * CLAUDE.md's "no user session" table. ZapSign does not document an
 * HMAC signature on its webhooks (unlike Meta's x-hub-signature-256), so
 * `[secret]` IS the authentication: an unguessable, per-account token
 * folded into the URL at credential-save time (see POST /api/zapsign/config),
 * checked here by hashing and comparing against `webhook_secret_hash`.
 *
 * Always resolves 200 quickly, even for a payload we don't recognise —
 * ZapSign retries on non-200, and a document created outside wacrm (or
 * a future event type we don't handle yet) is not an error, just a
 * no-op. Business logic never lives here: a `signed` event only updates
 * the tracking row and dispatches the `document_signed` trigger — the
 * user's own automation decides what happens next (move the deal,
 * notify the team), same separation the `tag_added` / `practice_area_set`
 * triggers already use.
 */
export async function POST(request: Request, { params }: Params) {
  const { secret } = await params;
  const db = supabaseAdmin();

  const { data: creds, error: credsErr } = await db
    .from('zapsign_credentials')
    .select('account_id')
    .eq('webhook_secret_hash', hashWebhookSecret(secret))
    .maybeSingle();

  // Generic 404 — same reasoning as an unknown API key: don't confirm or
  // deny that a secret is "close", which would help an attacker narrow
  // a guess.
  if (credsErr || !creds) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const documentToken =
    typeof body?.token === 'string' ? body.token : undefined;
  const rawStatus = typeof body?.status === 'string' ? body.status : undefined;
  // Confirmado contra um payload real do sandbox (evento doc_created):
  // o corpo é o objeto documento inteiro, com `token` e `status` na
  // raiz, MAIS um `event_type` que nomeia o evento. `status` manda
  // quando vem preenchido; `event_type` é a rede de segurança para o
  // caso de ele faltar. A ordem importa: um documento de vários
  // signatários pode receber `doc_signed` com `status: 'pending'`
  // enquanto ainda falta alguém assinar — e aí quem tem razão é o
  // `status`.
  const eventType =
    typeof body?.event_type === 'string' ? body.event_type : undefined;
  const status =
    rawStatus ??
    (eventType === 'doc_signed'
      ? 'signed'
      : eventType === 'doc_refused'
        ? 'refused'
        : undefined);

  // Nosso id, devolvido pelo ZapSign. É a chave reserva de quando a
  // resposta da criação se perdeu e a linha ficou sem token (migration
  // 044). Só aceitamos no formato de UUID: o campo é texto livre no
  // ZapSign, e um valor qualquer viraria erro de tipo na consulta.
  const externalId =
    typeof body?.external_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      body.external_id
    )
      ? body.external_id
      : undefined;

  if (!documentToken && !externalId) {
    console.warn(
      '[zapsign webhook] payload without a document token or external_id',
      body
    );
    return NextResponse.json({ ok: true });
  }

  const SELECT = 'id, contact_id, deal_id, template_token, name, status';
  let doc: {
    id: string;
    contact_id: string;
    deal_id: string | null;
    template_token: string;
    name: string;
    status: string;
  } | null = null;

  if (documentToken) {
    const { data } = await db
      .from('zapsign_documents')
      .select(SELECT)
      .eq('account_id', creds.account_id)
      .eq('zapsign_token', documentToken)
      .maybeSingle();
    doc = data;
  }

  // Não achou pelo token: pode ser um documento cuja criação ficou em
  // dúvida — mandamos, não soubemos a resposta, e a linha ficou com o
  // token nulo. O aviso do ZapSign traz o nosso id de volta, então dá
  // para reencontrá-la e, de quebra, gravar o token que faltava.
  if (!doc && externalId) {
    const { data } = await db
      .from('zapsign_documents')
      .select(SELECT)
      .eq('account_id', creds.account_id)
      .eq('id', externalId)
      .maybeSingle();
    doc = data;

    if (doc && documentToken) {
      const { error: healErr } = await db
        .from('zapsign_documents')
        .update({ zapsign_token: documentToken })
        .eq('id', doc.id)
        .is('zapsign_token', null);
      if (healErr) {
        console.error('[zapsign webhook] could not heal token:', healErr);
      } else {
        console.info(
          '[zapsign webhook] recovered an unconfirmed document',
          doc.id
        );
      }
    }
  }

  // Unknown document — created outside wacrm, or from a deleted account
  // row. Not an error: acknowledge and move on.
  if (!doc) {
    return NextResponse.json({ ok: true });
  }

  if (status === 'signed' || status === 'refused') {
    // Reserva atômica, mesmo desenho do claim de `scanStalledDeals` no
    // cron: a transição só vale se a linha AINDA estava no status
    // anterior, e é o banco que decide quem ganha. Ler-depois-escrever
    // deixava duas entregas simultâneas — e a ZapSign reentrega em toda
    // resposta ≠ 200 — dispararem `document_signed` duas vezes, o que
    // numa automação que cria negócio ou manda WhatsApp duplica de
    // verdade.
    const { data: claimed, error: updateErr } = await db
      .from('zapsign_documents')
      .update(
        status === 'signed'
          ? { status: 'signed', signed_at: new Date().toISOString() }
          : { status: 'refused' }
      )
      .eq('id', doc.id)
      .neq('status', status)
      .select('id')
      .maybeSingle();

    if (updateErr) {
      // Sem a transição gravada não podemos disparar: o gatilho ficaria
      // sem a marca que impede a reentrega de disparar de novo. Devolver
      // erro faz a ZapSign reentregar, que é o comportamento correto.
      console.error('[zapsign webhook] status update failed:', updateErr);
      return NextResponse.json({ error: 'update failed' }, { status: 500 });
    }

    // Perdeu a corrida (ou é reentrega de um evento já processado).
    // Quem ganhou já disparou o gatilho.
    if (!claimed) return NextResponse.json({ ok: true });

    if (status === 'signed') {
      await runAutomationsForTrigger({
        accountId: creds.account_id,
        triggerType: 'document_signed',
        contactId: doc.contact_id,
        context: {
          deal_id: doc.deal_id ?? undefined,
          vars: {
            document_name: doc.name,
            template_token: doc.template_token,
          },
        },
      });
    }
  } else {
    // Único ponto cego da integração: se o corpo da ZapSign não trouxer
    // o status onde esperamos, tudo aqui vira um 200 silencioso e o
    // gatilho nunca dispara, sem nada onde olhar. Registrar o que chegou
    // é o que transforma "a automação não roda" num diagnóstico de um
    // minuto.
    console.info(
      '[zapsign webhook] unhandled status for document',
      documentToken,
      status ?? '(absent)',
      eventType ?? '(no event_type)'
    );
  }

  return NextResponse.json({ ok: true });
}
