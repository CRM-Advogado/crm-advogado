import {
  assertSameConnection,
  externalId,
  ProviderError,
  type OutboundMessage,
  type WhatsAppProvider,
} from './domain';

/** A different recipient spelling is safe only after a definitive Meta sandbox
 * rejection. A matching code inside a 5xx/429/timeout must never replay a send. */
export function canTryRecipientVariant(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    error.connection.provider === 'meta_cloud' &&
    error.code === '131030' &&
    error.outcome === 'rejected' &&
    error.httpStatus !== undefined &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500 &&
    error.httpStatus !== 429
  );
}

/** Application use case: accepts any real adapter satisfying the small port.
 * It never retries, fails over, handles credentials or knows vendor DTOs.
 */
export async function sendOutbound(
  accountId: string,
  provider: WhatsAppProvider,
  message: OutboundMessage
) {
  const connection = provider.connection;
  if (!accountId || connection.accountId !== accountId)
    throw new Error('WhatsApp connection does not belong to this account');
  if (!provider.capabilities.messages.includes(message.kind)) {
    throw new ProviderError(
      'WhatsApp message capability is unavailable',
      connection,
      'send',
      'unsupported_message',
      'rejected'
    );
  }
  const choiceLimit =
    message.kind === 'buttons'
      ? provider.capabilities.maxButtons
      : message.kind === 'list'
        ? provider.capabilities.maxListRows
        : undefined;
  const choiceCount =
    message.kind === 'buttons'
      ? message.buttons.length
      : message.kind === 'list'
        ? message.sections.reduce(
            (total, section) => total + section.rows.length,
            0
          )
        : 0;
  if (
    choiceLimit !== undefined &&
    (!Number.isSafeInteger(choiceLimit) ||
      choiceLimit < 0 ||
      choiceCount > choiceLimit)
  ) {
    throw new ProviderError(
      'WhatsApp message exceeds provider capabilities',
      connection,
      'send',
      'capability_limit',
      'rejected'
    );
  }
  if (message.replyTo) assertSameConnection(connection, message.replyTo);
  if (message.kind === 'reaction')
    assertSameConnection(connection, message.target);
  if (message.kind === 'template')
    for (const slot of message.slots) {
      for (const value of slot.values)
        if (value.kind === 'media' && value.reference)
          assertSameConnection(connection, value.reference);
    }
  const result = await provider.messaging.send(message);
  // A provider may have accepted this send even if its response is malformed.
  try {
    assertSameConnection(connection, result);
    return externalId(connection, result.value);
  } catch {
    throw new ProviderError(
      'WhatsApp provider returned an invalid message reference',
      connection,
      'send',
      'invalid_response',
      'uncertain'
    );
  }
}
