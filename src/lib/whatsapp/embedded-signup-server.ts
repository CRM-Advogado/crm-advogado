import { isMetaId, type SignupInput } from './embedded-signup';

export class SignupError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

export function getSignupConfig() {
  const {
    META_APP_ID: appId,
    META_APP_SECRET: appSecret,
    META_EMBEDDED_SIGNUP_CONFIG_ID: configId,
    META_EMBEDDED_SIGNUP_ENABLED: enabled,
    META_EMBEDDED_SIGNUP_API_VERSION: version,
    META_WEBHOOK_VERIFY_TOKEN: verifyToken,
    ENCRYPTION_KEY: key,
  } = process.env;
  if (
    enabled !== 'true' ||
    !isMetaId(appId) ||
    !isMetaId(configId) ||
    !appSecret ||
    !verifyToken ||
    !key ||
    !/^[a-fA-F0-9]{64}$/.test(key) ||
    !version ||
    !/^v\d+\.0$/.test(version)
  )
    return null;
  return { appId, appSecret, configId, version, verifyToken };
}

type Config = NonNullable<ReturnType<typeof getSignupConfig>>;

async function graph<T>(
  config: Config,
  path: string,
  init: RequestInit
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      `https://graph.facebook.com/${config.version}/${path}`,
      {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      }
    );
  } catch {
    throw new SignupError(
      'A Meta não respondeu. Reinicie a conexão e tente novamente.',
      502
    );
  }
  // Never forward Meta envelopes: they can contain credentials or request details.
  if (!response.ok)
    throw new SignupError(
      'A Meta recusou esta etapa. Confira as permissões e reinicie a conexão.',
      502
    );
  try {
    return (await response.json()) as T;
  } catch {
    throw new SignupError('Resposta inválida da Meta.', 502);
  }
}

/** Code and secret travel in the POST body, never in our URLs/logs/browser responses. */
export async function exchangeSignupCode(
  config: Config,
  code: string
): Promise<string> {
  const token = await graph<{ access_token?: string }>(
    config,
    'oauth/access_token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
      }),
    }
  );
  if (!token.access_token || typeof token.access_token !== 'string')
    throw new SignupError('A Meta não retornou a autorização.', 502);
  return token.access_token;
}

/** Server checks the token's app/scopes/WABA and phone membership; browser IDs alone grant nothing. */
export async function verifySignupAssets(
  config: Config,
  token: string,
  input: SignupInput
) {
  const debug = await graph<{
    data?: {
      app_id?: string;
      is_valid?: boolean;
      expires_at?: number;
      scopes?: string[];
      granular_scopes?: { scope: string; target_ids?: string[] }[];
    };
  }>(config, `debug_token?input_token=${encodeURIComponent(token)}`, {
    headers: { Authorization: `Bearer ${config.appId}|${config.appSecret}` },
  });
  const data = debug.data;
  const scopes = [
    'whatsapp_business_management',
    'whatsapp_business_messaging',
  ];
  if (
    !data?.is_valid ||
    data.app_id !== config.appId ||
    (data.expires_at && data.expires_at <= Date.now() / 1000) ||
    !scopes.every((scope) => data.scopes?.includes(scope)) ||
    !data.granular_scopes?.some(
      (s) =>
        s.scope === 'whatsapp_business_management' &&
        s.target_ids?.includes(input.wabaId)
    )
  ) {
    throw new SignupError(
      'A autorização não permite conectar esta conta WhatsApp.',
      403
    );
  }
  // Follow cursors on our fixed Graph host, never arbitrary paging.next URLs.
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({
      fields: 'id,display_phone_number',
      limit: '100',
    });
    if (after) query.set('after', after);
    const phones = await graph<{
      data?: { id: string; display_phone_number: string }[];
      paging?: { next?: string; cursors?: { after?: string } };
    }>(config, `${input.wabaId}/phone_numbers?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const phone = phones.data?.find((p) => p.id === input.phoneNumberId);
    if (phone) return phone;
    after = phones.paging?.next ? phones.paging.cursors?.after : undefined;
    if (!after) break;
  }
  throw new SignupError(
    'O número escolhido não pertence à conta WhatsApp autorizada.',
    403
  );
}

export async function activateSignup(
  config: Config,
  token: string,
  input: SignupInput
) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const registered = await graph<{ success?: boolean }>(
    config,
    `${input.phoneNumberId}/register`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ messaging_product: 'whatsapp', pin: input.pin }),
    }
  );
  if (registered.success !== true)
    throw new SignupError('A Meta não confirmou o registro do número.', 502);
  const subscribed = await graph<{ success?: boolean }>(
    config,
    `${input.wabaId}/subscribed_apps`,
    { method: 'POST', headers }
  );
  if (subscribed.success !== true)
    throw new SignupError(
      'A Meta não confirmou o recebimento de mensagens.',
      502
    );
}
