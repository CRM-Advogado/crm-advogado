import { isYCloudE164 } from './ycloud';

/** Server-supplied own-account diagnostic. This is not delegated onboarding. */
export interface YCloudPreflightConfig {
  enabled: boolean;
  accountId: string;
  apiKey: string;
  wabaId: string;
  phoneNumber: string;
}

export class YCloudPreflightError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

type Resource = Record<string, unknown>;
const object = (value: unknown): value is Resource =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** No IDs, tokens, customer content or provider error bodies leave this port.
 * Availability through a key proves neither coexistence nor tenant ownership.
 */
export async function preflightYCloudOwnAccount(
  accountId: string,
  config: YCloudPreflightConfig
) {
  if (!config.enabled) throw new YCloudPreflightError(404, 'disabled');
  if (!config.accountId || accountId !== config.accountId)
    throw new YCloudPreflightError(403, 'account_not_allowed');
  if (
    !config.apiKey.trim() ||
    !/^\d+$/.test(config.wabaId) ||
    !isYCloudE164(config.phoneNumber)
  )
    throw new YCloudPreflightError(503, 'server_configuration_incomplete');

  // Snapshot credentials and selectors before any asynchronous operation.
  const { apiKey, wabaId, phoneNumber } = config;
  async function read(path: string): Promise<Resource | null> {
    let response: Response;
    try {
      response = await fetch(`https://api.ycloud.com/v2${path}`, {
        method: 'GET',
        headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new YCloudPreflightError(502, 'provider_unavailable');
    }
    if (response.status === 404) return null;
    if (!response.ok)
      throw new YCloudPreflightError(
        response.status === 429 ? 503 : 502,
        response.status === 401 || response.status === 403
          ? 'provider_access_denied'
          : 'provider_unavailable'
      );
    // A bounded reader also prevents accidentally buffering an unlimited body.
    const reader = response.body?.getReader();
    if (!reader)
      throw new YCloudPreflightError(502, 'invalid_provider_response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 64 * 1024) {
          await reader.cancel();
          throw new Error('limit');
        }
        chunks.push(value);
      }
      const body = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(body)
      );
      if (!object(value)) throw new Error('shape');
      return value;
    } catch {
      throw new YCloudPreflightError(502, 'invalid_provider_response');
    } finally {
      reader.releaseLock();
    }
  }

  const waba = await read(
    `/whatsapp/businessAccounts/${encodeURIComponent(wabaId)}`
  );
  const missing = {
    status: 'awaiting_authorization' as const,
    resourcesVerified: false,
    coexistenceVerified: false,
    customerBindingVerified: false,
    operational: false,
  };
  if (!waba) return missing;
  if (waba.id !== wabaId)
    throw new YCloudPreflightError(502, 'resource_mismatch');
  const phone = await read(
    `/whatsapp/phoneNumbers/${encodeURIComponent(wabaId)}/${encodeURIComponent(phoneNumber)}`
  );
  if (!phone) return missing;
  if (
    phone.wabaId !== wabaId ||
    phone.phoneNumber !== phoneNumber ||
    typeof phone.id !== 'string' ||
    !/^\d+$/.test(phone.id)
  )
    throw new YCloudPreflightError(502, 'resource_mismatch');
  const active =
    phone.status === 'CONNECTED' && phone.codeVerificationStatus === 'VERIFIED';
  return {
    ...missing,
    status: active
      ? ('resource_verified' as const)
      : ('awaiting_authorization' as const),
    resourcesVerified: true,
  };
}
