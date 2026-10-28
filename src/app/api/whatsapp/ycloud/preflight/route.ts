import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  preflightYCloudOwnAccount,
  YCloudPreflightError,
} from '@/lib/whatsapp/providers/ycloud-preflight';

export const runtime = 'nodejs';

/** Read-only, explicitly allowlisted own-account diagnostic. No browser
 * selectors or credentials are accepted and no connection is persisted.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin');
    const result = await preflightYCloudOwnAccount(accountId, {
      enabled: process.env.YCLOUD_OWN_ACCOUNT_PREFLIGHT_ENABLED === 'true',
      accountId: process.env.YCLOUD_OWN_ACCOUNT_ID ?? '',
      apiKey: process.env.YCLOUD_API_KEY ?? '',
      wabaId: process.env.YCLOUD_OWN_WABA_ID ?? '',
      phoneNumber: process.env.YCLOUD_OWN_PHONE_NUMBER ?? '',
    });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof YCloudPreflightError)
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } }
      );
    const response = toErrorResponse(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
