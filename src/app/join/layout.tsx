// ============================================================
// /join/[token] layout — branded entrance shell.
//
// The route group sits outside both `(auth)` and `(dashboard)`
// because it's hybrid: the page must render for anonymous
// visitors (to show "Sign up to join Acme") *and* for signed-in
// users (to show "Accept invite"). Reusing `(auth)`'s layout
// would funnel signed-in users through the middleware's auth-
// page redirect; reusing `(dashboard)` would funnel anonymous
// visitors through its login redirect. A dedicated layout
// avoids both.
//
// Referrer-Policy: no-referrer
//   The plaintext invite token lives in the URL path. Without
//   this header, any externally-loaded resource (third-party
//   font, CDN script, image) would receive the full join URL in
//   its `Referer` header. The /join page doesn't currently load
//   anything external, but `Referrer-Policy: no-referrer` is a
//   cheap belt-and-braces guard against future regressions
//   accidentally leaking tokens. Per Next.js 16's `metadata`
//   export, this surfaces as `<meta name="referrer" content="no-referrer">`.
// ============================================================

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { BrandAmbient } from '@/components/layout/brand-ambient';
import { ThemeToggle } from '@/components/layout/theme-toggle';

export const metadata: Metadata = {
  referrer: 'no-referrer',
  // Belt-and-braces against an invite URL ending up in search
  // results if a join page is ever crawled.
  robots: { index: false, follow: false },
};

export default function JoinLayout({ children }: { children: ReactNode }) {
  return (
    <div className="crm-ambient relative isolate flex min-h-svh flex-col">
      <BrandAmbient />
      <div className="relative z-20 flex justify-end px-4 pt-4 sm:px-6">
        <ThemeToggle />
      </div>
      <div className="crm-enter relative z-10 grid flex-1 place-items-center px-4 py-8">{children}</div>
    </div>
  );
}
