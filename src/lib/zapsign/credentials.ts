// ============================================================
// zapsign_credentials — read + secret helpers.
//
// The one place that decrypts `zapsign_credentials.api_token`, reused by
// both the automation engine (server-side send) and the settings API
// route (server-side validate-before-save). Mirrors
// `src/lib/automations/meta-send.ts` decrypting `whatsapp_config.access_token`
// inline rather than exposing plaintext credentials from more than one spot.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { decrypt } from '@/lib/whatsapp/encryption';
import type { ZapsignCredentials } from './client';

/** Self-identifying prefix, same idea as `wacrm_live_` / `whsec_`. */
export const ZAPSIGN_WEBHOOK_SECRET_PREFIX = 'zapsign_whsec_';

/**
 * Devolve `null` APENAS quando a conta não configurou o ZapSign. Uma
 * falha de banco lança: colapsar as duas coisas fazia o motor acusar
 * "ZapSign is not configured for this account" numa indisponibilidade
 * passageira, mandando o usuário reconfigurar uma integração que já
 * estava certa.
 */
export async function getZapsignCredentials(
  db: SupabaseClient,
  accountId: string
): Promise<ZapsignCredentials | null> {
  const { data, error } = await db
    .from('zapsign_credentials')
    .select('api_token, sandbox')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    throw new Error(`could not read ZapSign credentials: ${error.message}`);
  }
  if (!data) return null;
  return {
    apiToken: decrypt(data.api_token as string),
    sandbox: Boolean(data.sandbox),
  };
}

/**
 * Fresh webhook secret + its hash. The plaintext is returned to the
 * caller to show the admin ONCE (folded into the webhook URL); only the
 * hash is persisted. Same discipline as `generateApiKey()` in
 * `src/lib/api-keys/keys.ts` — full-entropy opaque token, no KDF needed,
 * SHA-256 + unique index is the right shape for an O(1) lookup by secret.
 */
export function generateWebhookSecret(): { plaintext: string; hash: string } {
  const body = randomBytes(32).toString('base64url');
  const plaintext = `${ZAPSIGN_WEBHOOK_SECRET_PREFIX}${body}`;
  return { plaintext, hash: hashWebhookSecret(plaintext) };
}

export function hashWebhookSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
