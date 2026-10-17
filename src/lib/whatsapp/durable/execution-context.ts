import { AsyncLocalStorage } from 'node:async_hooks';

export interface DurableConnectionContext {
  accountId: string;
  connectionId: string;
  phoneNumberId: string;
  wabaId: string | null;
  deadlineMs: number;
}
const context = new AsyncLocalStorage<DurableConnectionContext>();
export const withDurableConnection = <T>(
  connection: DurableConnectionContext,
  callback: () => Promise<T>
) => context.run(Object.freeze({ ...connection }), callback);
export function assertDurableConnection(config: {
  account_id: string;
  id: string;
  phone_number_id: string;
  waba_id?: string | null;
}) {
  assertDurableLease();
  const expected = context.getStore();
  if (
    expected &&
    (config.account_id !== expected.accountId ||
      config.id !== expected.connectionId ||
      config.phone_number_id !== expected.phoneNumberId ||
      (config.waba_id ?? null) !== expected.wabaId)
  ) {
    throw new Error('durable_dispatch_connection_changed');
  }
}

export function assertDurableLease() {
  const expected = context.getStore();
  if (
    expected &&
    (!Number.isFinite(expected.deadlineMs) || Date.now() >= expected.deadlineMs)
  ) {
    throw new Error('durable_dispatch_lease_expired');
  }
}
