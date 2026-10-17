import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { drainMetaIngress } from '@/lib/whatsapp/durable/worker';
import { createMetaOutboxExecutor } from '@/lib/whatsapp/durable/dispatch';

export const maxDuration = 60;
export async function GET(request: Request) {
  if (
    !['true', 'paused'].includes(
      process.env.WHATSAPP_DURABLE_INGRESS_ENABLED ?? ''
    )
  )
    return NextResponse.json(
      { error: 'durable ingress disabled' },
      { status: 503 }
    );
  const expected = process.env.AUTOMATION_CRON_SECRET,
    supplied = request.headers.get('x-cron-secret') ?? '';
  if (!expected)
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  const a = Buffer.from(expected),
    b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const db = supabaseAdmin();
    return NextResponse.json(
      await drainMetaIngress(db, createMetaOutboxExecutor(db))
    );
  } catch {
    return NextResponse.json(
      { error: 'durable worker failed' },
      { status: 503 }
    );
  }
}
