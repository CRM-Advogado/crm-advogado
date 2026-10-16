import { createMetaCloudProvider } from './meta-cloud';
import { resolveProvider } from './registry';

interface LegacyMetaConfig {
  id: string;
  account_id: string;
  phone_number_id: string;
  provider?: unknown;
}

/** Anti-corruption boundary for the existing one-Meta-config-per-account schema.
 * Caller reads config with .eq('account_id', authenticatedAccountId).
 * Never use this mapping for YCloud/Gupshup rows or infer identity from phone IDs.
 */
export function resolveLegacyMetaProvider(
  accountId: string,
  config: LegacyMetaConfig,
  accessToken: string
) {
  if (config.provider !== undefined && config.provider !== 'meta_cloud') {
    throw new Error('Legacy WhatsApp configuration is not a Meta connection');
  }
  return resolveProvider(
    accountId,
    {
      accountId: config.account_id,
      connectionId: config.id,
      provider: 'meta_cloud',
    },
    {
      meta_cloud: (connection) =>
        createMetaCloudProvider(connection, {
          phoneNumberId: config.phone_number_id,
          accessToken,
        }),
    }
  );
}
