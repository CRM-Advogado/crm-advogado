import { describe, expect, it } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  generateWebhookSecret,
  getZapsignCredentials,
  hashWebhookSecret,
  ZAPSIGN_WEBHOOK_SECRET_PREFIX,
} from './credentials'

function fakeDb(row: Record<string, unknown> | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('generateWebhookSecret / hashWebhookSecret', () => {
  it('produces a self-identifying, hashable secret', () => {
    const { plaintext, hash } = generateWebhookSecret()
    expect(plaintext.startsWith(ZAPSIGN_WEBHOOK_SECRET_PREFIX)).toBe(true)
    expect(hash).toBe(hashWebhookSecret(plaintext))
  })

  it('never repeats a plaintext across calls', () => {
    const a = generateWebhookSecret()
    const b = generateWebhookSecret()
    expect(a.plaintext).not.toBe(b.plaintext)
    expect(a.hash).not.toBe(b.hash)
  })
})

describe('getZapsignCredentials', () => {
  it('decrypts the stored token and returns the sandbox flag', async () => {
    const db = fakeDb({ api_token: encrypt('plain-token'), sandbox: true })
    const creds = await getZapsignCredentials(db, 'account-1')
    expect(creds).toEqual({ apiToken: 'plain-token', sandbox: true })
  })

  it('returns null when the account has no credentials row', async () => {
    const db = fakeDb(null)
    const creds = await getZapsignCredentials(db, 'account-1')
    expect(creds).toBeNull()
  })
})
