import { NextResponse, type NextRequest } from "next/server";
import { getBaseUrl } from "@/lib/http/base-url";
import { createClient } from "@/lib/supabase/server";

// Lands here after Supabase's magic link / password recovery email —
// resetPasswordForEmail() in forgot-password/page.tsx points redirectTo
// at this route with `next=/reset-password`. Supabase's PKCE flow hands
// back a `code`, which only becomes a real session once exchanged here;
// visiting /reset-password directly without this exchange leaves the
// user with no session to call updateUser() against.
//
// Base URL comes from getBaseUrl(), not `new URL(request.url).origin`:
// on Hostinger Managed Node.js the latter resolves to the app's
// internal bind address (`http://0.0.0.0:3000`), which Supabase then
// mails to the user as the redirect target — a link no browser can
// open (ERR_ADDRESS_INVALID).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";
  const base = getBaseUrl(request, "[GET /auth/callback]");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${base}${next}`);
    }
  }

  return NextResponse.redirect(`${base}/login?error=auth_callback_failed`);
}
