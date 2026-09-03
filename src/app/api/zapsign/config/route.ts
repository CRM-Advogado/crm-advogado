import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { generateWebhookSecret } from '@/lib/zapsign/credentials';
import { listTemplates, ZapsignApiError } from '@/lib/zapsign/client';

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * GET /api/zapsign/config
 *
 * Any member may read the config so the automation builder can tell
 * whether the send_signature_request step is usable. The token is
 * NEVER returned — only a `has_token` flag, mirroring `GET /api/ai/config`.
 * The webhook URL itself is also never re-exposed here: it was shown
 * once, at creation/regeneration (see POST below), same "reveal once"
 * contract as `webhook_endpoints` and API keys.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const { data, error } = await supabase
      .from('zapsign_credentials')
      .select('sandbox, api_token, webhook_secret_hash')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[zapsign/config GET] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load ZapSign configuration' },
        { status: 500 }
      );
    }

    if (!data) return NextResponse.json({ configured: false });
    return NextResponse.json({
      configured: true,
      has_token: !!data.api_token,
      sandbox: !!data.sandbox,
      has_webhook: !!data.webhook_secret_hash,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/zapsign/config  (admin+)
 *
 * Upsert the account's ZapSign token. Validates it against ZapSign
 * (GET /templates/) before persisting — same "verify with the provider
 * before save" discipline as /api/ai/config — so a typo'd token fails
 * loudly here instead of silently on the next automation run.
 *
 * `regenerate_webhook: true` (re)generates the inbound webhook secret;
 * the resulting URL is returned in the response body ONLY on this call
 * — it is never stored in plaintext and never returned again by GET.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(
      `zapsign-config:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid request body');

    const rawToken =
      typeof body.api_token === 'string' ? body.api_token.trim() : '';
    const regenerateWebhook = body.regenerate_webhook === true;

    const { data: existing } = await supabase
      .from('zapsign_credentials')
      .select('api_token, sandbox')
      .eq('account_id', accountId)
      .maybeSingle();

    // Campo ausente HERDA o valor salvo; só um booleano explícito muda
    // o ambiente. Com `body.sandbox === true`, quem postasse apenas
    // `{ api_token }` ou `{ regenerate_webhook: true }` — um script, o
    // MCP, uma tela futura — derrubava a conta de sandbox para produção
    // em silêncio, e a validação seguinte ainda batia no host errado com
    // o token de teste e devolvia um 400 sem explicação.
    const sandbox =
      typeof body.sandbox === 'boolean' ? body.sandbox : !!existing?.sandbox;

    let tokenPlain: string;
    if (rawToken) {
      tokenPlain = rawToken;
    } else if (existing?.api_token) {
      try {
        tokenPlain = decrypt(existing.api_token);
      } catch {
        return bad(
          'Stored token could not be decrypted — re-enter your API token.'
        );
      }
    } else {
      return bad('api_token is required');
    }

    // Only spend a round-trip to ZapSign when the credentials that
    // affect reachability actually changed (mirrors /api/ai/config).
    const credentialsChanged =
      !existing || rawToken !== '' || sandbox !== !!existing.sandbox;

    if (credentialsChanged) {
      try {
        await listTemplates({ apiToken: tokenPlain, sandbox });
      } catch (err) {
        if (err instanceof ZapsignApiError) {
          // A ZapSign explica a recusa no corpo da resposta, e
          // descartá-lo transformava todo problema no mesmo número
          // opaco. O log guarda a resposta inteira; a mensagem devolve
          // um trecho, porque quem está configurando a integração
          // normalmente não tem acesso ao log do servidor.
          console.error(
            '[zapsign/config POST] validation refused:',
            err.status,
            err.body
          );
          const detail = err.body?.trim().slice(0, 200);
          // 403 contra produção é quase sempre conta sem plano de API:
          // a ZapSign só exige plano no ambiente de produção, o sandbox
          // é livre. É exatamente o que acontece ao colar um token de
          // teste com a chave Sandbox desligada.
          const hint =
            err.status === 403 && !sandbox
              ? ' Production requires a paid ZapSign API plan — if this is a sandbox token, turn the Sandbox switch on before saving.'
              : '';
          return bad(
            `Could not validate the token with ZapSign (${err.status}).${hint}${
              detail ? ` ZapSign said: ${detail}` : ''
            }`
          );
        }
        console.error('[zapsign/config POST] validation error:', err);
        return bad('Could not reach ZapSign to validate the token.');
      }
    }

    const shared: Record<string, unknown> = { sandbox };
    let webhookUrl: string | undefined;

    if (regenerateWebhook || !existing) {
      const { plaintext, hash } = generateWebhookSecret();
      shared.webhook_secret_hash = hash;
      const origin =
        process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;
      webhookUrl = `${origin}/api/webhooks/zapsign/${plaintext}`;
    }

    if (existing) {
      const { error: upErr } = await supabase
        .from('zapsign_credentials')
        .update(rawToken ? { ...shared, api_token: encrypt(rawToken) } : shared)
        .eq('account_id', accountId);
      if (upErr) {
        console.error('[zapsign/config POST] update error:', upErr);
        return NextResponse.json(
          { error: 'Failed to save ZapSign configuration' },
          { status: 500 }
        );
      }
    } else {
      const { error: insErr } = await supabase
        .from('zapsign_credentials')
        .insert({
          account_id: accountId,
          created_by: userId,
          api_token: encrypt(tokenPlain),
          ...shared,
        });
      if (insErr) {
        console.error('[zapsign/config POST] insert error:', insErr);
        return NextResponse.json(
          { error: 'Failed to save ZapSign configuration' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ success: true, webhook_url: webhookUrl });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/zapsign/config  (admin+)
 *
 * Removes the account's ZapSign credentials (send_signature_request
 * starts failing with a clear "not configured" error; already-sent
 * documents in zapsign_documents are untouched — this only disables
 * future sends and the webhook lookup).
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { error } = await supabase
      .from('zapsign_credentials')
      .delete()
      .eq('account_id', accountId);
    if (error) {
      console.error('[zapsign/config DELETE] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete ZapSign configuration' },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
