import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  serializeContact,
  findOrCreateContact,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      attribution: {
        ad_source_id: null,
        ad_source_type: null,
        ad_headline: null,
        ad_source_url: null,
        ctwa_clid: null,
        first_seen_at: null,
      },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('exposes the click-to-WhatsApp referral columns under attribution', () => {
    const row = {
      id: 'c3',
      phone: '+5585999990000',
      name: 'Lead do anúncio',
      email: null,
      company: null,
      avatar_url: null,
      ad_source_id: '120210000000000000',
      ad_source_type: 'ad',
      ad_headline: 'BPC negado? Você pode recorrer',
      ad_source_url: 'https://fb.me/xyz',
      ctwa_clid: 'ARB1cl1d',
      first_seen_at: '2026-02-01T12:00:00Z',
      created_at: '2026-02-01T12:00:00Z',
      updated_at: '2026-02-01T12:00:00Z',
    };
    expect(serializeContact(row).attribution).toEqual({
      ad_source_id: '120210000000000000',
      ad_source_type: 'ad',
      ad_headline: 'BPC negado? Você pode recorrer',
      ad_source_url: 'https://fb.me/xyz',
      ctwa_clid: 'ARB1cl1d',
      first_seen_at: '2026-02-01T12:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });
});
