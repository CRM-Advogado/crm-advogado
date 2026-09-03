import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getZapsignCredentials } from '@/lib/zapsign/credentials';
import { listTemplates } from '@/lib/zapsign/client';

/**
 * GET /api/zapsign/templates  (agent+)
 *
 * Proxies ZapSign's template list so the automation builder's
 * send_signature_request / document_signed pickers can offer a
 * dropdown instead of a raw token field. `agent+` because editing an
 * automation already requires that role; returns an empty list (not an
 * error) when the account hasn't configured ZapSign yet — the builder
 * falls back to a plain token input in that case.
 */
export async function GET() {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(
      `zapsign-templates:${userId}`,
      RATE_LIMITS.zapsignTemplates
    );
    if (!limit.success) return rateLimitResponse(limit);

    const creds = await getZapsignCredentials(supabase, accountId);
    if (!creds) return NextResponse.json({ templates: [] });

    const templates = await listTemplates(creds);
    return NextResponse.json({
      templates: templates
        .filter((tpl) => tpl.active)
        .map((tpl) => ({ token: tpl.token, name: tpl.name })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
