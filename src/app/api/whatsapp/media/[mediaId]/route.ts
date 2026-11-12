import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { externalId } from '@/lib/whatsapp/providers/domain'
import { resolveLegacyMetaProvider } from '@/lib/whatsapp/providers/legacy-meta-connection'
import { decrypt } from '@/lib/whatsapp/encryption'

const MAX_CONCURRENT_DOWNLOADS_PER_ACCOUNT = 2
// Each worker instance limits the downloads it is buffering for this account.
const activeDownloads = new Map<string, number>()

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Authorize: this mediaId must belong to a message the caller can
    // already see. The webhook stores inbound media as
    // `/api/whatsapp/media/<mediaId>` in messages.media_url (see
    // src/app/api/whatsapp/webhook/route.ts), and `messages_select`
    // RLS (migration 017) already scopes rows to the caller's account
    // via conversations.account_id — so this lookup on the user's own
    // RLS-scoped client returns nothing for another tenant's media,
    // even if that tenant's WhatsApp config happens to be reachable
    // via a shared Meta app. Without this check, any authenticated
    // user could fetch any mediaId using their own account's access
    // token, regardless of which account's conversation it belongs to.
    const mediaPath = `/api/whatsapp/media/${mediaId}`
    const { data: ownedMessage, error: ownedMessageError } = await supabase
      .from('messages')
      .select('id')
      .eq('media_url', mediaPath)
      .limit(1)
      .maybeSingle()

    if (ownedMessageError || !ownedMessage) {
      return NextResponse.json(
        { error: 'Media not found' },
        { status: 404 }
      )
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const provider = resolveLegacyMetaProvider(accountId, config, decrypt(config.access_token))
    if (!provider.media) throw new Error('WhatsApp media download unavailable')

    const active = activeDownloads.get(accountId) ?? 0
    if (active >= MAX_CONCURRENT_DOWNLOADS_PER_ACCOUNT) {
      return NextResponse.json(
        { error: 'Too many concurrent media downloads' },
        { status: 429, headers: { 'Retry-After': '1', 'Cache-Control': 'private, no-store' } },
      )
    }

    activeDownloads.set(accountId, active + 1)
    try {
      const reference = externalId(provider.connection, mediaId)
      const { bytes, contentType } = await provider.media.retrieve(reference)

      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'private, no-store',
        },
      })
    } finally {
      const remaining = (activeDownloads.get(accountId) ?? 1) - 1
      if (remaining === 0) activeDownloads.delete(accountId)
      else activeDownloads.set(accountId, remaining)
    }
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
