import {
  assertSameConnection,
  externalId,
  type ProviderConnection,
  type ProviderId,
  type WhatsAppProvider,
} from './domain';

export type ProviderRegistry = Partial<
  Record<ProviderId, (connection: ProviderConnection) => WhatsAppProvider>
>;

/** Account is supplied by the authenticated use case, never by the request body. */
export function resolveProvider(
  accountId: string,
  connection: ProviderConnection,
  registry: ProviderRegistry
): WhatsAppProvider {
  externalId(connection, 'validate-connection');
  if (!accountId || accountId !== connection.accountId) {
    throw new Error('WhatsApp connection does not belong to this account');
  }
  if (!Object.hasOwn(registry, connection.provider)) {
    throw new Error(
      `WhatsApp provider is not available: ${connection.provider}`
    );
  }
  const factory = registry[connection.provider];
  if (!factory)
    throw new Error(
      `WhatsApp provider is not available: ${connection.provider}`
    );
  const provider = factory(Object.freeze({ ...connection }));
  assertSameConnection(connection, provider.connection);
  return provider;
}
