// Shared validation only: no secrets or server imports in this module.
export interface SignupAssets {
  wabaId: string;
  phoneNumberId: string;
}

/** Terminal events can arrive without the SDK login callback (e.g. popup closed). */
export function readSignupTermination(
  origin: string,
  payload: unknown
): 'cancelled' | 'error' | 'unsupported' | null {
  if (
    !['https://www.facebook.com', 'https://web.facebook.com'].includes(origin)
  )
    return null;
  try {
    const event = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (event?.type !== 'WA_EMBEDDED_SIGNUP') return null;
    if (event.event === 'CANCEL') return 'cancelled';
    if (event.event === 'ERROR') return 'error';
    if (
      ['FINISH_ONLY_WABA', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'].includes(
        event.event
      )
    )
      return 'unsupported';
  } catch {
    /* Ignore unrelated or malformed messages. */
  }
  return null;
}

export function isMetaId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,32}$/.test(value);
}

/** Ignore untrusted origins and incomplete/non-Cloud-API completion events. */
export function readSignupEvent(
  origin: string,
  payload: unknown
): SignupAssets | null {
  if (
    !['https://www.facebook.com', 'https://web.facebook.com'].includes(origin)
  )
    return null;
  try {
    const event = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (event?.type !== 'WA_EMBEDDED_SIGNUP' || event?.event !== 'FINISH')
      return null;
    const data = event.data;
    if (!isMetaId(data?.waba_id) || !isMetaId(data?.phone_number_id))
      return null;
    return { wabaId: data.waba_id, phoneNumberId: data.phone_number_id };
  } catch {
    return null;
  }
}

export interface SignupInput extends SignupAssets {
  code: string;
  state: string;
  pin: string;
}

export function readSignupInput(value: unknown): SignupInput | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    !isMetaId(v.wabaId) ||
    !isMetaId(v.phoneNumberId) ||
    typeof v.code !== 'string' ||
    !v.code.trim() ||
    v.code.length > 4096 ||
    typeof v.state !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.state) ||
    typeof v.pin !== 'string' ||
    !/^\d{6}$/.test(v.pin)
  )
    return null;
  return {
    wabaId: v.wabaId,
    phoneNumberId: v.phoneNumberId,
    code: v.code,
    state: v.state,
    pin: v.pin,
  };
}
