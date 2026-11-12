import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { GET } from './route'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'meta-test-token' }))

const mediaId = 'media-1'
const mediaPath = `/api/whatsapp/media/${mediaId}`
const cdnUrl = 'https://lookaside.fbsbx.com/whatsapp/media-1'
const fetchMock = vi.fn<typeof fetch>()

function mockSupabase(owned: boolean) {
  const profileQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { account_id: 'acct-1' } }),
  }
  const messageQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: owned ? { id: 'msg-1' } : null }),
  }
  const configQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: {
        id: 'cfg-1',
        account_id: 'acct-1',
        phone_number_id: 'phone-1',
        access_token: 'encrypted-token',
      },
    }),
  }
  const queries = { profiles: profileQuery, messages: messageQuery, whatsapp_config: configQuery }
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: keyof typeof queries) => queries[table],
  } as unknown as Awaited<ReturnType<typeof createClient>>)
  return { messageQuery, configQuery }
}

function getMedia() {
  return GET(new Request(`https://crm.example.test${mediaPath}`), {
    params: Promise.resolve({ mediaId }),
  })
}

describe('authenticated WhatsApp media proxy', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('downloads owned media through Meta and prevents shared caching', async () => {
    const { messageQuery, configQuery } = mockSupabase(true)
    fetchMock
      .mockResolvedValueOnce(Response.json({ url: cdnUrl }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'image/jpeg' },
      }))

    const result = await getMedia()

    expect(messageQuery.eq).toHaveBeenCalledWith('media_url', mediaPath)
    expect(configQuery.eq).toHaveBeenCalledWith('account_id', 'acct-1')
    expect(result.status).toBe(200)
    expect(result.headers.get('Content-Type')).toBe('image/jpeg')
    expect(result.headers.get('Cache-Control')).toBe('private, no-store')
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, `https://graph.facebook.com/v21.0/${mediaId}`,
      expect.objectContaining({ headers: { Authorization: 'Bearer meta-test-token' } }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, cdnUrl,
      expect.objectContaining({ redirect: 'error' }))
  })

  it('does not look up credentials or contact the provider when RLS hides the media', async () => {
    const { configQuery } = mockSupabase(false)

    const result = await getMedia()

    expect(result.status).toBe(404)
    expect(configQuery.eq).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
