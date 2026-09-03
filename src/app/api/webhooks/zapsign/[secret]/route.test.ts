import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashWebhookSecret } from '@/lib/zapsign/credentials';

const SECRET = 'zapsign_whsec_test-secret';
const SECRET_HASH = hashWebhookSecret(SECRET);

const h = vi.hoisted(() => ({
  state: {
    credsAccountId: null as string | null,
    document: null as Record<string, unknown> | null,
    updateCalls: [] as { table: string; payload: unknown }[],
    /** Força a falha do UPDATE de status, para cobrir o ramo 500. */
    documentUpdateError: null as { message: string } | null,
  },
  runAutomationsForTrigger: vi.fn(async () => {}),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const ops = {
        type: 'select',
        payload: undefined as unknown,
        filters: [] as [string, unknown][],
        excluded: [] as [string, unknown][],
      };
      function resolve() {
        if (table === 'zapsign_credentials') {
          if (ops.type === 'update') {
            h.state.updateCalls.push({ table, payload: ops.payload });
            return { data: null, error: null };
          }
          const wantedHash = ops.filters.find(
            ([k]) => k === 'webhook_secret_hash'
          )?.[1];
          const matches = h.state.credsAccountId && wantedHash === SECRET_HASH;
          return {
            data: matches ? { account_id: h.state.credsAccountId } : null,
            error: null,
          };
        }
        if (table === 'zapsign_documents') {
          if (ops.type === 'select') {
            // A rota busca primeiro por zapsign_token e, não achando,
            // por id (o external_id que devolvemos ao ZapSign). O duplo
            // precisa distinguir as duas para o teste de recuperação não
            // passar por acidente.
            const byToken = ops.filters.find(([k]) => k === 'zapsign_token');
            const byId = ops.filters.find(([k]) => k === 'id');
            const d = h.state.document;
            if (!d) return { data: null, error: null };
            if (byToken) {
              return {
                data: d.zapsign_token === byToken[1] ? d : null,
                error: null,
              };
            }
            if (byId) {
              return { data: d.id === byId[1] ? d : null, error: null };
            }
          }
          if (ops.type === 'update') {
            if (h.state.documentUpdateError) {
              return { data: null, error: h.state.documentUpdateError };
            }
            // Modela a reserva atômica da rota: o UPDATE ... WHERE
            // status <> X só afeta linha se ela AINDA não estiver no
            // status alvo. Sem isso o duplo diria "ganhei" sempre, e o
            // teste de reentrega passaria por acidente.
            const blocked = ops.excluded.some(
              ([col, val]) => h.state.document?.[col] === val
            );
            if (blocked) return { data: null, error: null };
            h.state.updateCalls.push({ table, payload: ops.payload });
            return { data: { id: h.state.document?.id }, error: null };
          }
          return { data: h.state.document, error: null };
        }
        return { data: null, error: null };
      }
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
        eq: (k: string, v: unknown) => (ops.filters.push([k, v]), b),
        neq: (k: string, v: unknown) => (ops.excluded.push([k, v]), b),
        // A cura do token usa `.is('zapsign_token', null)` para só
        // escrever em linha que ainda não tem token.
        is: (k: string, v: unknown) => (ops.filters.push([k, v]), b),
        maybeSingle: () => Promise.resolve(resolve()),
        // Real Supabase query builders are thenable: `await
        // db.from(t).update(p).eq('id', x)` resolves without a
        // trailing .maybeSingle()/.select().
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(onF, onR),
      };
      return b;
    },
  }),
}));

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}));

import { POST } from './route';

function req(body: unknown) {
  return new Request('http://localhost/api/webhooks/zapsign/x', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function params(secret: string) {
  return { params: Promise.resolve({ secret }) };
}

beforeEach(() => {
  h.state.credsAccountId = null;
  h.state.document = null;
  h.state.updateCalls = [];
  h.state.documentUpdateError = null;
  h.runAutomationsForTrigger.mockClear();
});

describe('POST /api/webhooks/zapsign/[secret]', () => {
  it('returns 404 when the secret hash does not match a registered account', async () => {
    h.state.credsAccountId = 'acct-1'; // a real account exists, just under the real SECRET
    const res = await POST(
      req({ token: 'doc1', status: 'signed' }),
      params('wrong-secret')
    );
    expect(res.status).toBe(404);
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it('acknowledges (200) a document it does not recognise, without erroring', async () => {
    h.state.credsAccountId = 'acct-1';
    h.state.document = null;

    const res = await POST(
      req({ token: 'unknown-doc', status: 'signed' }),
      params(SECRET)
    );
    expect(res.status).toBe(200);
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it('marks the document signed and dispatches document_signed on a signed event', async () => {
    h.state.credsAccountId = 'acct-1';
    h.state.document = {
      id: 'doc-row-1',
      zapsign_token: 'doc1',
      contact_id: 'contact-1',
      deal_id: 'deal-1',
      template_token: 'template-1',
      name: 'Contrato',
      status: 'pending',
    };

    const res = await POST(
      req({ token: 'doc1', status: 'signed' }),
      params(SECRET)
    );
    expect(res.status).toBe(200);

    const docUpdate = h.state.updateCalls.find(
      (c) => c.table === 'zapsign_documents'
    );
    expect(docUpdate?.payload).toMatchObject({ status: 'signed' });

    expect(h.runAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        triggerType: 'document_signed',
        contactId: 'contact-1',
        context: expect.objectContaining({
          deal_id: 'deal-1',
          vars: { document_name: 'Contrato', template_token: 'template-1' },
        }),
      })
    );
  });

  it('does not re-dispatch when the document is already marked signed', async () => {
    h.state.credsAccountId = 'acct-1';
    h.state.document = {
      id: 'doc-row-1',
      zapsign_token: 'doc1',
      contact_id: 'contact-1',
      deal_id: null,
      template_token: 'template-1',
      name: 'Contrato',
      status: 'signed',
    };

    const res = await POST(
      req({ token: 'doc1', status: 'signed' }),
      params(SECRET)
    );
    expect(res.status).toBe(200);
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    // Perdeu a reserva: nem a linha foi reescrita.
    expect(h.state.updateCalls).toHaveLength(0);
  });

  // A ZapSign reentrega em toda resposta ≠ 200. Se a transição não foi
  // gravada, disparar assim mesmo faria a reentrega disparar de novo —
  // então o certo é devolver erro e deixar ela tentar outra vez.
  it('answers 500 without dispatching when the status update fails', async () => {
    h.state.credsAccountId = 'acct-1';
    h.state.document = {
      id: 'doc-row-1',
      zapsign_token: 'doc1',
      contact_id: 'contact-1',
      deal_id: null,
      template_token: 'template-1',
      name: 'Contrato',
      status: 'pending',
    };
    h.state.documentUpdateError = { message: 'connection reset' };

    const res = await POST(
      req({ token: 'doc1', status: 'signed' }),
      params(SECRET)
    );
    expect(res.status).toBe(500);
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it('records the refusal without dispatching document_signed', async () => {
    h.state.credsAccountId = 'acct-1';
    h.state.document = {
      id: 'doc-row-1',
      zapsign_token: 'doc1',
      contact_id: 'contact-1',
      deal_id: null,
      template_token: 'template-1',
      name: 'Contrato',
      status: 'pending',
    };

    const res = await POST(
      req({ token: 'doc1', status: 'refused' }),
      params(SECRET)
    );
    expect(res.status).toBe(200);
    expect(
      h.state.updateCalls.find((c) => c.table === 'zapsign_documents')?.payload
    ).toMatchObject({ status: 'refused' });
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  // Payload real do sandbox: o corpo é o documento inteiro, com
  // `event_type` nomeando o evento. Se algum dia o `status` vier ausente,
  // é o event_type que salva o disparo.
  it('falls back to event_type when the payload carries no status', async () => {
    h.state.credsAccountId = 'acct-1';
    h.state.document = {
      id: 'doc-row-1',
      zapsign_token: 'doc1',
      contact_id: 'contact-1',
      deal_id: null,
      template_token: 'template-1',
      name: 'Contrato',
      status: 'pending',
    };

    const res = await POST(
      req({ token: 'doc1', event_type: 'doc_signed' }),
      params(SECRET)
    );
    expect(res.status).toBe(200);
    expect(
      h.state.updateCalls.find((c) => c.table === 'zapsign_documents')?.payload
    ).toMatchObject({ status: 'signed' });
    expect(h.runAutomationsForTrigger).toHaveBeenCalledTimes(1);
  });

  // Documento de vários signatários: o ZapSign pode anunciar doc_signed
  // com o documento ainda pendente. Quem tem razão é o `status`, senão o
  // gatilho dispara antes de o contrato estar de fato assinado.
  it('trusts an explicit status over event_type', async () => {
    h.state.credsAccountId = 'acct-1';
    h.state.document = {
      id: 'doc-row-1',
      zapsign_token: 'doc1',
      contact_id: 'contact-1',
      deal_id: null,
      template_token: 'template-1',
      name: 'Contrato',
      status: 'pending',
    };

    const res = await POST(
      req({ token: 'doc1', status: 'pending', event_type: 'doc_signed' }),
      params(SECRET)
    );
    expect(res.status).toBe(200);
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  // O caso que o external_id existe para resolver: a criação não teve
  // resposta, a linha ficou sem token, e é o aviso da assinatura que
  // reencontra o documento e fecha o caso sozinho.
  it('recovers a document whose creation was never confirmed, via external_id', async () => {
    h.state.credsAccountId = 'acct-1';
    h.state.document = {
      id: '0f4f4b6e-2a11-4a4a-9f6e-1c2d3e4f5a6b',
      zapsign_token: null,
      contact_id: 'contact-1',
      deal_id: null,
      template_token: 'template-1',
      name: 'Contrato',
      status: 'pending',
    };

    const res = await POST(
      req({
        token: 'doc-token-que-nunca-vimos',
        status: 'signed',
        external_id: '0f4f4b6e-2a11-4a4a-9f6e-1c2d3e4f5a6b',
      }),
      params(SECRET)
    );
    expect(res.status).toBe(200);

    // Gravou o token que faltava…
    expect(h.state.updateCalls).toContainEqual({
      table: 'zapsign_documents',
      payload: { zapsign_token: 'doc-token-que-nunca-vimos' },
    });
    // …e disparou o gatilho, que era o ponto.
    expect(h.runAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: 'document_signed' })
    );
  });

  it('ignores an external_id that is not a UUID', async () => {
    h.state.credsAccountId = 'acct-1';
    h.state.document = {
      id: 'doc-row-1',
      zapsign_token: null,
      contact_id: 'contact-1',
      deal_id: null,
      template_token: 'template-1',
      name: 'Contrato',
      status: 'pending',
    };

    const res = await POST(
      req({ token: 'outro-token', status: 'signed', external_id: '../../etc' }),
      params(SECRET)
    );
    expect(res.status).toBe(200);
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  // Ponto cego da integração: um corpo cujo status não reconhecemos vira
  // 200 e nada acontece. Sem log, "a automação não roda" não tem por
  // onde começar a ser investigado.
  it('logs the payload when the status is one it does not handle', async () => {
    h.state.credsAccountId = 'acct-1';
    h.state.document = {
      id: 'doc-row-1',
      zapsign_token: 'doc1',
      contact_id: 'contact-1',
      deal_id: null,
      template_token: 'template-1',
      name: 'Contrato',
      status: 'pending',
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const res = await POST(
      req({ token: 'doc1', status: 'doc_deleted' }),
      params(SECRET)
    );
    expect(res.status).toBe(200);
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('unhandled status'),
      'doc1',
      'doc_deleted',
      expect.any(String)
    );
    info.mockRestore();
  });
});
