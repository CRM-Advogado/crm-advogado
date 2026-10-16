import type { SupabaseClient } from '@supabase/supabase-js';
import { externalId, type ProviderConnection } from './domain';

export interface MetaDeliveryStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}
type DispatchStatus = (
  accountId: string,
  payload: {
    whatsapp_message_id: string;
    conversation_id: string;
    status: string;
  }
) => Promise<void>;

const LADDER = ['sending', 'pending', 'sent', 'delivered', 'read', 'replied'];
function advances(current: string, incoming: string): boolean {
  if (incoming === 'failed')
    return ['sending', 'pending', 'sent'].includes(current);
  return (
    current !== 'failed' && LADDER.indexOf(incoming) > LADDER.indexOf(current)
  );
}
function predecessors(incoming: string): string[] {
  return incoming === 'failed'
    ? ['sending', 'pending', 'sent']
    : LADDER.slice(0, LADDER.indexOf(incoming));
}

/** Legacy tables have raw Meta IDs. Scope through their parents before using
 * those IDs; Meta message IDs are not globally unique (migration 009).
 * The current schema permits one connection per account. Multiple connections
 * require persisting connection_id before enabling that product capability.
 */
export async function handleMetaStatusUpdate(
  db: SupabaseClient,
  connection: ProviderConnection,
  status: MetaDeliveryStatus,
  dispatch: DispatchStatus
): Promise<void> {
  if (connection.provider !== 'meta_cloud')
    throw new Error('Meta status requires a Meta connection');
  externalId(connection, status.id);
  const milliseconds = Number(status.timestamp) * 1000;
  if (
    !['sent', 'delivered', 'read', 'failed'].includes(status.status) ||
    !status.timestamp ||
    !Number.isFinite(milliseconds) ||
    Number.isNaN(new Date(milliseconds).getTime())
  )
    return;

  const { data: messages, error: messageError } = await db
    .from('messages')
    .select('id, status, conversation_id, conversations!inner(account_id)')
    .eq('message_id', status.id)
    .eq('conversations.account_id', connection.accountId);
  if (messageError)
    throw new Error('Failed to resolve account-scoped delivery status');

  const changedConversations = new Set<string>();
  for (const message of messages ?? []) {
    if (!advances(message.status, status.status)) continue;
    const { data: updated, error } = await db
      .from('messages')
      .update({ status: status.status })
      .eq('id', message.id)
      .in('status', predecessors(status.status))
      .select('id');
    if (error) throw new Error('Failed to persist message delivery status');
    if (updated?.length) changedConversations.add(message.conversation_id);
  }

  const { data: recipients, error: recipientError } = await db
    .from('broadcast_recipients')
    .select('id, status, broadcasts!inner(account_id)')
    .eq('whatsapp_message_id', status.id)
    .eq('broadcasts.account_id', connection.accountId);
  if (recipientError)
    throw new Error('Failed to resolve account-scoped broadcast status');

  for (const recipient of recipients ?? []) {
    if (!advances(recipient.status, status.status)) continue;
    const update: Record<string, unknown> = { status: status.status };
    if (status.status !== 'failed')
      update[`${status.status}_at`] = new Date(milliseconds).toISOString();
    const { error } = await db
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)
      .in('status', predecessors(status.status));
    if (error) throw new Error('Failed to persist broadcast delivery status');
  }

  for (const conversationId of changedConversations) {
    await dispatch(connection.accountId, {
      whatsapp_message_id: status.id,
      conversation_id: conversationId,
      status: status.status,
    });
  }
}
