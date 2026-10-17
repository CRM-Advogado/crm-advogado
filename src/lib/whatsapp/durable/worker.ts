import type { SupabaseClient } from '@supabase/supabase-js';

export interface OutboxClaim {
  id: string;
  event_id: string;
  account_id: string;
  connection_id: string;
  claim_token: string;
  lease_until: string;
  payload: Record<string, unknown>;
}
export type ExecuteOutbox = (
  claim: OutboxClaim,
  payload: Record<string, unknown>
) => Promise<void>;
async function rpc(
  db: SupabaseClient,
  name: string,
  args: Record<string, unknown>
) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error('durable_worker_database_failed');
  return data;
}
/** DB materialization is retryable; after the outbox start checkpoint the
 * entire legacy dispatch pipeline is conservative/uncertain on any failure.
 * It is never replayed automatically, even if only part of it ran.
 */
export async function drainMetaIngress(
  db: SupabaseClient,
  execute: ExecuteOutbox,
  limit = 10
) {
  const deadline = Date.now() + 45_000;
  const summary = {
    materialized: 0,
    cancelled: 0,
    failed: 0,
    dispatched: 0,
    uncertain: 0,
  };
  for (let processed = 0; processed < limit;) {
    if (Date.now() >= deadline) break;
    const jobs = (await rpc(db, 'claim_whatsapp_ingress', {
      p_limit: limit - processed,
      p_lease_seconds: 60,
    })) as { id: string; claim_token: string }[];
    if (!jobs?.length) break;
    for (const job of jobs) {
      if (Date.now() >= deadline) break;
      processed++;
      try {
        const result = await rpc(db, 'materialize_whatsapp_ingress', {
          p_event_id: job.id,
          p_claim_token: job.claim_token,
        });
        if (result?.cancelled) summary.cancelled++;
        else summary.materialized++;
      } catch {
        summary.failed++;
        await rpc(db, 'fail_whatsapp_ingress', {
          p_event_id: job.id,
          p_claim_token: job.claim_token,
        });
      }
    }
  }
  // One reservation at a time: an earlier slow dispatch cannot expire a whole
  // batch of unstarted effects. The SQL function also recovers expired starts
  // into uncertain, without returning them for re-execution.
  for (let n = 0; n < limit; n++) {
    if (Date.now() >= deadline) break;
    const claims = (await rpc(db, 'claim_whatsapp_ingress_outbox', {
      p_limit: 1,
      p_lease_seconds: 300,
    })) as OutboxClaim[];
    const claim = claims?.[0];
    if (!claim) break;
    const payload = await rpc(db, 'start_whatsapp_ingress_outbox', {
      p_outbox_id: claim.id,
      p_claim_token: claim.claim_token,
    });
    if (!payload) {
      summary.cancelled++;
      continue;
    }
    try {
      await execute(claim, payload);
      const finished = await rpc(db, 'finish_whatsapp_ingress_outbox', {
        p_outbox_id: claim.id,
        p_claim_token: claim.claim_token,
        p_succeeded: true,
      });
      if (finished) summary.dispatched++;
      else summary.uncertain++;
    } catch {
      summary.uncertain++;
      // A failed checkpoint update is also safe: SQL marks expired starts as
      // uncertain on the next sweep. No catch branch resends the effect.
      try {
        await rpc(db, 'finish_whatsapp_ingress_outbox', {
          p_outbox_id: claim.id,
          p_claim_token: claim.claim_token,
          p_succeeded: false,
        });
      } catch {
        /* remains started */
      }
    }
  }
  return summary;
}
