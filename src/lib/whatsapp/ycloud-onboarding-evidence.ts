import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IngressError, readDurableMetaBody } from './durable/ingress';
import { verifyYCloudWebhookSignature } from './providers/ycloud-webhook';

export interface YCloudEvidenceConfig {
  enabled: boolean;
  endpointNamespace: string;
  webhookSecret: string;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** Records signed provider evidence only. No tenant binding, phone registration,
 * messaging, resource lookup or operational connection is created here. */
export async function acceptYCloudOnboardingEvidence(
  request: Request,
  config: YCloudEvidenceConfig,
  database: () => SupabaseClient
) {
  if (!config.enabled) throw new IngressError(404, 'disabled');
  const { endpointNamespace, webhookSecret } = config;
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(endpointNamespace) ||
    !webhookSecret.trim()
  )
    throw new IngressError(503, 'server_configuration_incomplete');

  // Shared bounded byte-preserving UTF-8 reader (also used by Meta).
  const rawBody = await readDurableMetaBody(request);
  if (
    !verifyYCloudWebhookSignature(
      rawBody,
      request.headers.get('ycloud-signature'),
      webhookSecret
    )
  )
    throw new IngressError(401, 'invalid_webhook_signature');

  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    throw new IngressError(400, 'invalid_webhook_json');
  }
  if (
    !record(envelope) ||
    envelope.apiVersion !== 'v2' ||
    !identifier(envelope.id)
  )
    throw new IngressError(400, 'invalid_webhook_envelope');
  if (envelope.type !== 'whatsapp.business_account.updated')
    throw new IngressError(422, 'unsupported_webhook_event');
  const account = envelope.whatsappBusinessAccount;
  if (!record(account))
    throw new IngressError(400, 'invalid_onboarding_evidence');
  if (account.updateEvent !== 'PARTNER_ADDED')
    throw new IngressError(422, 'unsupported_business_account_update');
  if (
    typeof account.id !== 'string' ||
    !/^\d{1,100}$/.test(account.id) ||
    !identifier(account.partnerCustomerId) ||
    typeof account.paymentMethodAttached !== 'boolean'
  )
    throw new IngressError(400, 'invalid_onboarding_evidence');

  const { data, error } = await database().rpc(
    'record_ycloud_onboarding_evidence',
    {
      p_endpoint_namespace: endpointNamespace,
      p_event_id: envelope.id,
      p_waba_id: account.id,
      p_partner_customer_id: account.partnerCustomerId,
      p_payment_method_attached: account.paymentMethodAttached,
      p_payload_digest: createHash('sha256')
        .update(rawBody, 'utf8')
        .digest('hex'),
    }
  );
  if (error) {
    if (error.code === 'YC409')
      throw new IngressError(409, 'evidence_identity_conflict');
    throw new IngressError(503, 'durable_acceptance_failed');
  }
  if (!record(data) || typeof data.inserted !== 'boolean')
    throw new IngressError(503, 'durable_acceptance_failed');
  return { received: true, duplicate: !data.inserted, operational: false };
}
