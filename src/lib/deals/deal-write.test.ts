import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createDeal,
  moveDealStage,
  resolveDealForContact,
  stageBelongsToAccount,
} from './deal-write';

const ACCOUNT = 'acct-1';
const OTHER_ACCOUNT = 'acct-2';

/**
 * Mock mínimo do cliente Supabase.
 *
 * Guarda linhas por tabela e aplica os filtros `.eq()` / `.is()` de
 * verdade, em vez de devolver o que foi pedido. Isso importa: o que
 * estes testes precisam provar é justamente que o código FILTRA por
 * `account_id` — um mock que ignorasse filtros passaria de olhos
 * fechados exatamente pelo bug que se quer impedir.
 */
function makeDb() {
  const rows: Record<string, Record<string, unknown>[]> = {
    deals: [],
    pipeline_stages: [],
    pipelines: [],
    contacts: [],
  };
  const writes: { table: string; type: string; payload: unknown }[] = [];

  function builder(table: string) {
    const filters: { op: 'eq' | 'is'; col: string; val: unknown }[] = [];
    let type = 'select';
    let payload: unknown;
    let orderDesc = false;

    function matched() {
      return (rows[table] ?? []).filter((r) =>
        filters.every((f) =>
          f.op === 'is' ? (r[f.col] ?? null) === f.val : r[f.col] === f.val
        )
      );
    }

    function result() {
      if (type === 'update') {
        const hits = matched();
        for (const r of hits) Object.assign(r, payload as object);
        writes.push({ table, type, payload });
        return { data: hits, error: null };
      }
      if (type === 'insert') {
        const row = {
          id: `new-${rows[table].length + 1}`,
          ...(payload as object),
        };
        rows[table].push(row);
        writes.push({ table, type, payload });
        return { data: row, error: null };
      }
      const hits = matched();
      if (orderDesc) hits.reverse();
      return { data: hits, error: null };
    }

    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((type = 'insert'), (payload = p), b),
      update: (p: unknown) => ((type = 'update'), (payload = p), b),
      eq: (col: string, val: unknown) => (
        filters.push({ op: 'eq', col, val }),
        b
      ),
      is: (col: string, val: unknown) => (
        filters.push({ op: 'is', col, val }),
        b
      ),
      order: (_c: string, o?: { ascending?: boolean }) => (
        (orderDesc = o?.ascending === false),
        b
      ),
      limit: () => b,
      maybeSingle: () => {
        const r = result();
        return Promise.resolve({
          data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
          error: r.error,
        });
      },
      single: () => {
        const r = result();
        return Promise.resolve({
          data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
          error: r.error,
        });
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR),
    };
    return b;
  }

  const db = { from: (t: string) => builder(t) } as unknown as SupabaseClient;
  return { db, rows, writes };
}

let mock: ReturnType<typeof makeDb>;

beforeEach(() => {
  mock = makeDb();
  // Um funil da conta e um funil de OUTRA conta, com etapas próprias.
  mock.rows.pipelines.push({ id: 'p1', account_id: ACCOUNT });
  mock.rows.pipelines.push({ id: 'p-alheio', account_id: OTHER_ACCOUNT });
  mock.rows.pipeline_stages.push({ id: 's1', pipeline_id: 'p1' });
  mock.rows.pipeline_stages.push({ id: 's2', pipeline_id: 'p1' });
  mock.rows.pipeline_stages.push({ id: 's-alheia', pipeline_id: 'p-alheio' });
});

// ------------------------------------------------------------
// Posse
//
// O motor roda com service_role, que ATRAVESSA o RLS. Estes testes
// são a única barreira entre uma configuração de automação com um id
// forjado e o funil de outro inquilino.
// ------------------------------------------------------------

describe('stageBelongsToAccount', () => {
  it('aceita etapa que pertence ao funil e à conta', async () => {
    expect(await stageBelongsToAccount(mock.db, ACCOUNT, 'p1', 's1')).toBe(
      true
    );
  });

  it('recusa etapa de OUTRA conta', async () => {
    expect(
      await stageBelongsToAccount(mock.db, ACCOUNT, 'p-alheio', 's-alheia')
    ).toBe(false);
  });

  it('recusa etapa que existe mas é de outro funil — impede misturar funis', async () => {
    expect(
      await stageBelongsToAccount(mock.db, ACCOUNT, 'p1', 's-alheia')
    ).toBe(false);
  });

  it('recusa etapa inexistente', async () => {
    expect(
      await stageBelongsToAccount(mock.db, ACCOUNT, 'p1', 'fantasma')
    ).toBe(false);
  });
});

// ------------------------------------------------------------
// Mover
// ------------------------------------------------------------

describe('moveDealStage', () => {
  function seedDeal(over: Record<string, unknown> = {}) {
    mock.rows.deals.push({
      id: 'd1',
      account_id: ACCOUNT,
      pipeline_id: 'p1',
      stage_id: 's1',
      contact_id: 'c1',
      practice_area: null,
      status: 'open',
      created_at: '2026-01-01',
      ...over,
    });
  }

  it('move e informa a etapa de origem', async () => {
    seedDeal();
    const r = await moveDealStage({
      db: mock.db,
      accountId: ACCOUNT,
      dealId: 'd1',
      toStageId: 's2',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stageChanged).toBe(true);
    expect(r.fromStageId).toBe('s1');
    expect(mock.rows.deals[0].stage_id).toBe('s2');
  });

  it('não faz nada quando já está na etapa de destino', async () => {
    seedDeal();
    const r = await moveDealStage({
      db: mock.db,
      accountId: ACCOUNT,
      dealId: 'd1',
      toStageId: 's1',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('same_stage');
    // Nenhuma escrita: é isto que impede um salvamento de formulário
    // de se passar por passagem de etapa e acordar automações.
    expect(mock.writes.filter((w) => w.type === 'update')).toHaveLength(0);
  });

  it('recusa um negócio de OUTRA conta, mesmo com o id correto', async () => {
    seedDeal({ account_id: OTHER_ACCOUNT });
    const r = await moveDealStage({
      db: mock.db,
      accountId: ACCOUNT,
      dealId: 'd1',
      toStageId: 's2',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
    expect(mock.rows.deals[0].stage_id).toBe('s1');
  });

  it('recusa mover para uma etapa de outra conta', async () => {
    seedDeal();
    const r = await moveDealStage({
      db: mock.db,
      accountId: ACCOUNT,
      dealId: 'd1',
      toStageId: 's-alheia',
      toPipelineId: 'p-alheio',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('stage_not_in_account');
    expect(mock.rows.deals[0].stage_id).toBe('s1');
  });

  it('perde a corrida em silêncio quando outro escritor moveu antes', async () => {
    seedDeal();
    // Simula o intervalo entre a leitura e a escrita: alguém arrastou
    // o cartão para 's2' enquanto esta chamada ainda decidia. A trava
    // otimista (`.eq('stage_id', fromStageId)`) faz o update casar
    // zero linhas.
    const original = mock.db.from.bind(mock.db);
    let first = true;
    (mock.db as unknown as { from: (t: string) => unknown }).from = (
      t: string
    ) => {
      if (t === 'deals' && first) {
        first = false;
        const b = original(t);
        // Depois de servir a leitura, move o negócio por fora.
        queueMicrotask(() => {
          mock.rows.deals[0].stage_id = 's2';
        });
        return b;
      }
      return original(t);
    };

    const r = await moveDealStage({
      db: mock.db,
      accountId: ACCOUNT,
      dealId: 'd1',
      toStageId: 's2',
    });

    // Nem erro nem sucesso falso: o estado final já é o que o outro
    // escritor quis, então não havia o que fazer.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('same_stage');
    expect(mock.rows.deals[0].stage_id).toBe('s2');
  });

  it('encerra o negócio sem passagem de etapa quando só o status muda', async () => {
    seedDeal();
    const r = await moveDealStage({
      db: mock.db,
      accountId: ACCOUNT,
      dealId: 'd1',
      toStageId: 's1',
      setStatus: 'won',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A escrita valeu, mas não houve passagem de etapa para anunciar.
    expect(r.stageChanged).toBe(false);
    expect(mock.rows.deals[0].status).toBe('won');
  });
});

// ------------------------------------------------------------
// Escolher qual negócio — o casamento por tese
// ------------------------------------------------------------

describe('resolveDealForContact', () => {
  function seed(deals: Record<string, unknown>[]) {
    for (const d of deals) {
      mock.rows.deals.push({
        account_id: ACCOUNT,
        pipeline_id: 'p1',
        stage_id: 's1',
        contact_id: 'c1',
        status: 'open',
        ...d,
      });
    }
  }

  it('casa o negócio da MESMA tese e ignora o da outra', async () => {
    seed([
      { id: 'd-bpc', practice_area: 'bpc', created_at: '2026-01-01' },
      {
        id: 'd-apos',
        practice_area: 'aposentadoria',
        created_at: '2026-02-01',
      },
    ]);
    const hit = await resolveDealForContact({
      db: mock.db,
      accountId: ACCOUNT,
      contactId: 'c1',
      pipelineId: 'p1',
      practiceArea: 'bpc',
    });
    // Sem casamento por tese, o mais recente ('d-apos') venceria — e
    // o caso de aposentadoria seria empurrado pelo funil do BPC.
    expect(hit?.id).toBe('d-bpc');
  });

  it('adota o negócio ainda SEM tese quando não há um da tese pedida', async () => {
    seed([{ id: 'd-sem-tese', practice_area: null, created_at: '2026-01-01' }]);
    const hit = await resolveDealForContact({
      db: mock.db,
      accountId: ACCOUNT,
      contactId: 'c1',
      pipelineId: 'p1',
      practiceArea: 'bpc',
    });
    // O lead que abriu conversa antes da triagem. Adotá-lo é melhor
    // que abrir um segundo negócio para a mesma pessoa e o mesmo caso.
    expect(hit?.id).toBe('d-sem-tese');
  });

  it('não devolve negócio de tese diferente quando não há candidato sem tese', async () => {
    seed([
      {
        id: 'd-apos',
        practice_area: 'aposentadoria',
        created_at: '2026-01-01',
      },
    ]);
    const hit = await resolveDealForContact({
      db: mock.db,
      accountId: ACCOUNT,
      contactId: 'c1',
      pipelineId: 'p1',
      practiceArea: 'bpc',
    });
    expect(hit).toBeNull();
  });

  it('ignora negócios encerrados', async () => {
    seed([
      {
        id: 'd-ganho',
        practice_area: 'bpc',
        status: 'won',
        created_at: '2026-01-01',
      },
    ]);
    const hit = await resolveDealForContact({
      db: mock.db,
      accountId: ACCOUNT,
      contactId: 'c1',
      pipelineId: 'p1',
      practiceArea: 'bpc',
    });
    expect(hit).toBeNull();
  });

  it('sem tese em lugar nenhum, cai para o negócio aberto mais recente', async () => {
    mock.rows.contacts.push({
      id: 'c1',
      account_id: ACCOUNT,
      practice_area: null,
    });
    seed([
      { id: 'd-velho', practice_area: null, created_at: '2026-01-01' },
      { id: 'd-novo', practice_area: null, created_at: '2026-03-01' },
    ]);
    const hit = await resolveDealForContact({
      db: mock.db,
      accountId: ACCOUNT,
      contactId: 'c1',
      pipelineId: 'p1',
    });
    expect(hit?.id).toBe('d-novo');
  });

  it('devolve nulo sem contato — negócio órfão não pode ser casado', async () => {
    expect(
      await resolveDealForContact({
        db: mock.db,
        accountId: ACCOUNT,
        contactId: null,
        pipelineId: 'p1',
      })
    ).toBeNull();
  });
});

// ------------------------------------------------------------
// Criar
// ------------------------------------------------------------

describe('createDeal', () => {
  it('copia a tese do contato — a cópia que a migration 039 previa e ninguém fazia', async () => {
    mock.rows.contacts.push({
      id: 'c1',
      account_id: ACCOUNT,
      practice_area: 'bpc',
    });
    const r = await createDeal({
      db: mock.db,
      accountId: ACCOUNT,
      userId: 'u1',
      pipelineId: 'p1',
      stageId: 's1',
      contactId: 'c1',
      title: 'Lead',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.practiceArea).toBe('bpc');
    // Sem esta cópia, `deals.practice_area` seguiria sempre nula e o
    // casamento por tese nunca acharia nada.
    expect(mock.rows.deals[0].practice_area).toBe('bpc');
  });

  it('recusa criar numa etapa de outra conta', async () => {
    const r = await createDeal({
      db: mock.db,
      accountId: ACCOUNT,
      userId: 'u1',
      pipelineId: 'p-alheio',
      stageId: 's-alheia',
      contactId: 'c1',
      title: 'Lead',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('stage_not_in_account');
    expect(mock.rows.deals).toHaveLength(0);
  });

  it('nasce aberto', async () => {
    mock.rows.contacts.push({
      id: 'c1',
      account_id: ACCOUNT,
      practice_area: null,
    });
    await createDeal({
      db: mock.db,
      accountId: ACCOUNT,
      userId: 'u1',
      pipelineId: 'p1',
      stageId: 's1',
      contactId: 'c1',
      title: 'Lead',
    });
    expect(mock.rows.deals[0].status).toBe('open');
  });
});
