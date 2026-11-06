import type { SupabaseClient } from '@supabase/supabase-js';
import { IngressError } from './durable/ingress';

export interface YCloudCustomerLinkConfig {
  enabled: boolean;
  endpointNamespace: string;
}
export type YCloudLinkOperation = 'reserve' | 'reconcile' | 'status';
export interface YCloudLinkContext {
  accountId: string;
  userId: string;
}
const states = [
  'not_started',
  'reserved',
  'expired',
  'evidence_matched',
  'manual_review',
] as const;
type Status = (typeof states)[number];

/** Cookie mutations require a configured canonical application origin. A
 * caller's Host, forwarded headers, body or Origin cannot set this authority. */
export function assertYCloudMutationOrigin(request: Request, siteUrl: string) {
  let canonical: URL;
  try {
    canonical = new URL(siteUrl);
  } catch {
    throw new IngressError(503, 'server_configuration_incomplete');
  }
  if (
    canonical.username ||
    canonical.password ||
    canonical.pathname !== '/' ||
    canonical.search ||
    canonical.hash ||
    !(
      canonical.protocol === 'https:' ||
      (canonical.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(canonical.hostname))
    )
  )
    throw new IngressError(503, 'server_configuration_incomplete');
  if (
    request.headers.get('origin') !== canonical.origin ||
    (request.headers.has('sec-fetch-site') &&
      !['same-origin', 'none'].includes(request.headers.get('sec-fetch-site')!))
  )
    throw new IngressError(403, 'invalid_request_origin');
  // No browser-selected account, namespace, customer, WABA or session IDs.
  if (request.body !== null)
    throw new IngressError(400, 'request_body_not_allowed');
}

/** Service-only RPCs recheck actor membership in PostgreSQL. Only safe local
 * status metadata crosses this boundary; matching is not authorization. */
export async function runYCloudCustomerLink(
  operation: YCloudLinkOperation,
  context: YCloudLinkContext,
  config: YCloudCustomerLinkConfig,
  database: () => SupabaseClient
) {
  if (!config.enabled) throw new IngressError(404, 'disabled');
  const endpointNamespace = config.endpointNamespace;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(endpointNamespace))
    throw new IngressError(503, 'server_configuration_incomplete');
  if (!context.accountId || !context.userId)
    throw new IngressError(403, 'onboarding_forbidden');
  const rpc = {
    reserve: 'reserve_ycloud_onboarding',
    reconcile: 'reconcile_ycloud_onboarding',
    status: 'get_ycloud_onboarding_status',
  }[operation];
  if (!rpc) throw new IngressError(400, 'invalid_onboarding_operation');
  const { data, error } = await database().rpc(rpc, {
    p_account_id: context.accountId,
    p_actor_id: context.userId,
    p_endpoint_namespace: endpointNamespace,
  });
  if (error) {
    const status =
      error.code === 'YC403' ? 403 : error.code === 'YC409' ? 409 : 503;
    const code =
      status === 403
        ? 'onboarding_forbidden'
        : status === 409
          ? 'onboarding_manual_review_required'
          : 'onboarding_storage_failed';
    throw new IngressError(status, code);
  }
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !states.includes(data.status) ||
    data.operational !== false ||
    data.coexistenceVerified !== false
  )
    throw new IngressError(503, 'invalid_onboarding_status');
  const status = data.status as Status;
  if (status === 'not_started')
    return { status, operational: false, coexistenceVerified: false };
  if (
    typeof data.sessionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      data.sessionId
    ) ||
    typeof data.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(data.expiresAt))
  )
    throw new IngressError(503, 'invalid_onboarding_status');
  return {
    status,
    sessionId: data.sessionId as string,
    expiresAt: new Date(data.expiresAt).toISOString(),
    operational: false,
    coexistenceVerified: false,
  };
}
