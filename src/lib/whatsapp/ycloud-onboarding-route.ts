import { NextResponse } from 'next/server';
import {
  requireRole,
  UnauthorizedError,
  ForbiddenError,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { IngressError } from '@/lib/whatsapp/durable/ingress';
import {
  assertYCloudMutationOrigin,
  runYCloudCustomerLink,
  type YCloudLinkOperation,
} from '@/lib/whatsapp/ycloud-customer-link';

const headers = { 'Cache-Control': 'no-store' };

/** No selectors or credentials accepted from the browser. */
export async function handleYCloudOnboarding(
  operation: YCloudLinkOperation,
  request?: Request
) {
  try {
    const ctx = await requireRole('admin');
    if (process.env.YCLOUD_CUSTOMER_LINK_ENABLED !== 'true')
      throw new IngressError(404, 'disabled');
    if (request)
      assertYCloudMutationOrigin(
        request,
        process.env.NEXT_PUBLIC_SITE_URL ?? ''
      );
    const result = await runYCloudCustomerLink(
      operation,
      { accountId: ctx.accountId, userId: ctx.userId },
      {
        enabled: true,
        endpointNamespace: process.env.YCLOUD_WEBHOOK_ENDPOINT_NAMESPACE ?? '',
      },
      supabaseAdmin
    );
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof IngressError)
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers }
      );
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError)
      return NextResponse.json(
        { error: 'onboarding_forbidden' },
        { status: error.status, headers }
      );
    return NextResponse.json(
      { error: 'onboarding_storage_failed' },
      { status: 503, headers }
    );
  }
}
