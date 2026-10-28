import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { IngressError } from '@/lib/whatsapp/durable/ingress';
import { acceptYCloudOnboardingEvidence } from '@/lib/whatsapp/ycloud-onboarding-evidence';

export const runtime = 'nodejs';

/** Narrow onboarding evidence receiver; never a general message webhook. */
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    return NextResponse.json(
      await acceptYCloudOnboardingEvidence(
        request,
        {
          enabled: process.env.YCLOUD_ONBOARDING_EVIDENCE_ENABLED === 'true',
          endpointNamespace:
            process.env.YCLOUD_WEBHOOK_ENDPOINT_NAMESPACE ?? '',
          webhookSecret: process.env.YCLOUD_WEBHOOK_SECRET ?? '',
        },
        supabaseAdmin
      ),
      { headers }
    );
  } catch (error) {
    if (error instanceof IngressError)
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers }
      );
    return NextResponse.json(
      { error: 'durable_acceptance_failed' },
      { status: 503, headers }
    );
  }
}
