import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const INDEPENDENT_API_ROUTES = new Set([
  '/api/automations/cron',
  '/api/flows/cron',
  '/api/whatsapp/ingress/cron',
  '/api/whatsapp/webhook',
  '/api/whatsapp/ycloud/webhook',
])

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

function protectDashboardMutation(request: NextRequest): NextResponse | undefined {
  const path = request.nextUrl.pathname.replace(/\/$/, '')
  if (SAFE_METHODS.has(request.method) || !path.startsWith('/api/')) return
  if (
    path.startsWith('/api/v1/') ||
    INDEPENDENT_API_ROUTES.has(path) ||
    /^\/api\/webhooks\/zapsign\/[^/]+$/.test(path)
  ) return

  // Use the configured public origin behind a reverse proxy. Without an
  // override use the request URL, never client-supplied forwarded headers.
  const target = httpOrigin(process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.url)
  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')
  const source = origin ?? (referer ? httpOrigin(referer) : null)
  const site = request.headers.get('sec-fetch-site')

  if (!target || source !== target || (site !== null && site !== 'same-origin')) {
    return NextResponse.json({ error: 'Forbidden request origin' }, { status: 403 })
  }

  const contentType = request.headers.get('content-type')
  const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase()
  const hasDeclaredBody = Number(request.headers.get('content-length')) > 0 ||
    request.headers.has('transfer-encoding')

  // Existing bodyless actions send neither Content-Type nor a payload.
  if (mediaType !== 'application/json' && (contentType !== null || hasDeclaredBody)) {
    return NextResponse.json({ error: 'Expected application/json' }, { status: 415 })
  }
}

export async function proxy(request: NextRequest) {
  const denied = protectDashboardMutation(request)
  if (denied) return denied

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/api/:path*',
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
