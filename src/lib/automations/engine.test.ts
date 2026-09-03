import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    // `practice_area` entra aqui porque o motor passou a ler o valor
    // ANTERIOR da tese antes de escrever, para só anunciar
    // `practice_area_set` quando ela muda de fato (migration 042).
    // Esta mesma linha serve de resposta tanto à guarda de posse
    // quanto a essa leitura.
    owned: null as {
      id: string;
      practice_area?: string;
      name?: string;
      email?: string;
      phone?: string;
    } | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as {
      table: string;
      filters: [string, string, unknown][];
    }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    logInserts: [] as Record<string, unknown>[],
    logUpdates: [] as Record<string, unknown>[],
    zapsignDocInserts: [] as Record<string, unknown>[],
    zapsignDocUpdates: [] as Record<string, unknown>[],
    zapsignDocDeletes: [] as [string, string, unknown][][],
  },
}));

vi.mock('./admin-client', () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === 'contacts') {
      if (type === 'update') {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      // ownership guard / condition read
      return { data: state.owned, error: null };
    }
    if (table === 'custom_fields') {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === 'contact_custom_values') {
      if (type === 'upsert') {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === 'automations')
      return { data: state.automations, error: null };
    if (table === 'automation_logs') {
      if (type === 'insert') {
        state.logInserts.push(ops.payload as Record<string, unknown>);
        return { data: { id: 'log1' }, error: null };
      }
      if (type === 'update') {
        state.logUpdates.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: { steps_executed: [], status: 'success' }, error: null };
    }
    if (table === 'automation_steps') return { data: state.steps, error: null };
    if (table === 'zapsign_documents') {
      if (type === 'insert') {
        state.zapsignDocInserts.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      // A linha nasce sem token e é confirmada num segundo passo, então
      // o duplo registra update e delete para os testes conseguirem
      // distinguir "criou e confirmou", "criou e ficou em dúvida" e
      // "não criou".
      if (type === 'update') {
        state.zapsignDocUpdates.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      if (type === 'delete') {
        state.zapsignDocDeletes.push(ops.filters);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: 'select',
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      delete: () => ((ops.type = 'delete'), b),
      upsert: (p: unknown) => ((ops.type = 'upsert'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      gte: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
}));

vi.mock('@/lib/zapsign/credentials', () => ({
  getZapsignCredentials: vi.fn(async () => ({
    apiToken: 'test-token',
    sandbox: false,
  })),
}));

// As classes de erro vêm do módulo REAL: o motor decide o que fazer com
// a linha do banco por `instanceof`, e um dublê com classes próprias
// deixaria o teste verde comparando contra o erro errado.
vi.mock('@/lib/zapsign/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/zapsign/client')>(
    '@/lib/zapsign/client'
  );
  return {
    ZapsignApiError: actual.ZapsignApiError,
    ZapsignTransportError: actual.ZapsignTransportError,
    createDocumentFromTemplate: vi.fn(async () => ({
      token: 'doc-token-1',
      open_id: 1,
      status: 'pending',
      name: 'Contrato',
      signers: [
        {
          token: 's1',
          sign_url: 'https://app.zapsign.com.br/verificar/s1',
          status: 'new',
          name: 'Lead',
        },
      ],
    })),
    attachExtraDocumentFromTemplate: vi.fn(async () => ({
      token: 'extra-token-1',
      name: 'Procuracao',
    })),
  };
});

import { runAutomationsForTrigger, triggerMatches } from './engine';
import { MAX_DEAL_CHAIN_DEPTH } from '@/lib/deals/deal-chain';
import { getZapsignCredentials } from '@/lib/zapsign/credentials';
import {
  attachExtraDocumentFromTemplate,
  createDocumentFromTemplate,
  ZapsignApiError,
  ZapsignTransportError,
} from '@/lib/zapsign/client';
import { engineSendText } from './meta-send';
import type { Automation } from '@/types';

const ACCOUNT = 'acct-1';

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.logInserts = [];
  h.state.logUpdates = [];
  h.state.zapsignDocInserts = [];
  h.state.zapsignDocUpdates = [];
  h.state.zapsignDocDeletes = [];
  vi.mocked(getZapsignCredentials).mockClear();
  vi.mocked(createDocumentFromTemplate).mockClear();
  vi.mocked(engineSendText).mockClear();
});

describe('runAutomationsForTrigger — tenant isolation', () => {
  it('refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)', async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'victim-contact-uuid',
      context: { message_text: 'manual trigger' },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain('contacts');
    expect(h.state.fromCalls).not.toContain('automations');
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it('proceeds past the guard when the contact belongs to the account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.fromCalls).toContain('automations');
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(['eq', 'id', 'c1']);
    expect(filters).toContainEqual(['eq', 'account_id', ACCOUNT]);
  });
});

describe('automation_logs — status is seeded pessimistically (issue #409)', () => {
  it("writes the log row as 'failed' before any step runs", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // The insert happens before execution, so a run killed mid-flight must
    // not leave behind a row that claims it succeeded.
    expect(h.state.logInserts).toHaveLength(1);
    expect(h.state.logInserts[0]).toMatchObject({
      status: 'failed',
      steps_executed: [],
    });
  });

  it("still promotes the log to 'success' once the steps complete", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // The seed is only a floor — the outermost scope still writes the real
    // verdict, so a completed run reports success as it always did.
    const withStatus = h.state.logUpdates.filter((u) => 'status' in u);
    expect(withStatus.at(-1)).toMatchObject({ status: 'success' });
  });
});

describe('update_contact_field — custom fields', () => {
  it('upserts contact_custom_values when the field is account-owned', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', 'Premium')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: 'c1',
      custom_field_id: 'cf1',
      value: 'Premium',
    });
  });

  it('interpolates {{ vars.* }} into the custom value', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', '{{ vars.source }}')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { vars: { source: 'WhatsApp Ad' } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect((h.state.upsertCalls[0].payload as { value: string }).value).toBe(
      'WhatsApp Ad'
    );
  });

  it('interpolates {{ contact.name }} into the custom value', async () => {
    h.state.owned = { id: 'c1', name: 'Maria Silva Santos' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', '{{ contact.name }}')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect((h.state.upsertCalls[0].payload as { value: string }).value).toBe(
      'Maria Silva Santos'
    );
  });

  it('refuses to write a custom field from another account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:foreign-cf', 'x')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

describe('update_contact_field — built-in columns', () => {
  it('writes practice_area, the column migration 039 declares automation-filled', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('practice_area', 'bpc')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // Escreve na coluna do contato, não em contact_custom_values.
    expect(h.state.updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(h.state.updateCalls[0].filters).toContainEqual(['eq', 'id', 'c1']);
    expect(h.state.upsertCalls).toHaveLength(0);
  });

  // Definir a tese passou a anunciar `practice_area_set` (migration
  // 042) — é o gatilho da triagem, o que permite a automação empurrar
  // o negócio para a etapa seguinte assim que o caso é classificado.
  it('dispara practice_area_set quando a tese muda de vazia para um valor', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('practice_area', 'bpc')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // O mock devolve a mesma automação para QUALQUER trigger_type
    // (ignora o filtro `.eq('trigger_type', …)` que o código real
    // aplica), então o despacho reentra e a automação roda de novo.
    // Em produção isso não ocorre — mas aqui serve para provar que a
    // guarda de profundidade fecha o ciclo: sem ela, este teste não
    // terminaria.
    expect(h.state.updateCalls.length).toBeGreaterThan(1);
    expect(h.state.updateCalls.length).toBeLessThanOrEqual(
      MAX_DEAL_CHAIN_DEPTH + 1
    );
  });

  it('NÃO dispara practice_area_set quando a tese é reescrita com o mesmo valor', async () => {
    // Contato já classificado. A leitura do valor anterior devolve
    // este mesmo objeto, então o motor vê 'bpc' -> 'bpc'.
    h.state.owned = { id: 'c1', practice_area: 'bpc' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('practice_area', 'bpc')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // Exatamente uma escrita: sem reentrada, porque nada mudou. Sem
    // esta guarda, toda reexecução da automação de triagem
    // reempurraria o lead pelo funil.
    expect(h.state.updateCalls).toHaveLength(1);
  });

  it('FAILS the step for a column outside the allowlist instead of reporting success', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    // Lead attribution is webhook-written only — an automation must not
    // be able to forge it (migrations 040/041).
    h.state.steps = [customStep('ad_source_id', 'forged')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(0);
    const stepResults = h.state.logUpdates
      .map((u) => u.steps_executed as { status: string; detail: string }[])
      .filter(Boolean)
      .at(-1);
    expect(stepResults?.at(-1)).toMatchObject({ status: 'failed' });
    expect(String(stepResults?.at(-1)?.detail)).toContain('not writable');
  });
});

describe('send_webhook — SSRF guard (GHSA-8jqh-598v-rfxc)', () => {
  it('refuses a private / link-local destination and never calls fetch', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    // Aimed at the cloud metadata endpoint — the classic SSRF target.
    h.state.steps = [webhookStep('http://169.254.169.254/latest/meta-data/')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // The automation matched and its steps were loaded (so we genuinely
    // reached the send_webhook case)...
    expect(h.state.fromCalls).toContain('automation_steps');
    // ...yet the guard blocked it before any outbound request left the box.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

function webhookStep(url: string) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'send_webhook',
    position: 0,
    parent_step_id: null,
    step_config: {
      url,
      headers: { 'Metadata-Flavor': 'Google' },
      body_template: '{}',
    },
  };
}

function automationWithUpdateStep() {
  return {
    id: 'a1',
    account_id: ACCOUNT,
    user_id: 'u1',
    trigger_type: 'new_message_received',
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field: 'company', value: 'pwned-by-automation' },
  };
}

function customStep(field: string, value: string) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

describe('triggerMatches — interactive_reply', () => {
  function automation(reply_ids: string[]): Automation {
    return {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      name: 'menu step',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids },
      is_active: true,
      execution_count: 0,
      created_at: '',
      updated_at: '',
    };
  }

  it('matches when the tapped id is in reply_ids (exact)', () => {
    expect(
      triggerMatches(automation(['yes', 'no']), { interactive_reply_id: 'yes' })
    ).toBe(true);
  });

  it('does not match a different id', () => {
    expect(
      triggerMatches(automation(['yes']), { interactive_reply_id: 'maybe' })
    ).toBe(false);
  });

  it('does not match on a substring (exact only)', () => {
    expect(
      triggerMatches(automation(['yes']), {
        interactive_reply_id: 'yes_please',
      })
    ).toBe(false);
  });

  it('does not match when no reply id is present or config is empty', () => {
    expect(triggerMatches(automation(['yes']), {})).toBe(false);
    expect(
      triggerMatches(automation([]), { interactive_reply_id: 'yes' })
    ).toBe(false);
  });
});

describe('triggerMatches — tag_added', () => {
  function automation(tagId?: string): Automation {
    return {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      name: 'tag follow-up',
      trigger_type: 'tag_added',
      trigger_config: tagId ? { tag_id: tagId } : {},
      is_active: true,
      execution_count: 0,
      created_at: '',
      updated_at: '',
    };
  }

  it('matches only the exact tag id', () => {
    expect(triggerMatches(automation('tag-a'), { tag_id: 'tag-a' })).toBe(true);
    expect(triggerMatches(automation('tag-a'), { tag_id: 'tag-ab' })).toBe(
      false
    );
  });

  it('fails closed when the config or event tag is missing', () => {
    expect(triggerMatches(automation(), { tag_id: 'tag-a' })).toBe(false);
    expect(triggerMatches(automation('tag-a'), {})).toBe(false);
    expect(triggerMatches(automation('tag-a'), undefined)).toBe(false);
  });
});

describe('tag_added — conversation policy', () => {
  it('records a clear failed step when the contact has no conversation', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'tag outreach',
        trigger_type: 'tag_added',
        trigger_config: { tag_id: 'tag-a' },
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'send_message',
        position: 0,
        parent_step_id: null,
        step_config: { text: 'Hello' },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'tag_added',
      contactId: 'c1',
      context: { tag_id: 'tag-a' },
    });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error_message:
          'tag_added automation cannot send: contact has no existing conversation',
      })
    );
  });
});

// ------------------------------------------------------------
// Gatilhos de funil (migration 042)
//
// `triggerMatches` termina em `return true`, então um gatilho sem
// ramo próprio casaria com TUDO. Para eventos de funil isso seria
// desastroso: uma automação de "entrou em Contrato Assinado"
// dispararia em toda passagem de etapa do funil inteiro. Estes testes
// existem sobretudo para travar esse comportamento.
// ------------------------------------------------------------

function dealAutomation(
  trigger_type: Automation['trigger_type'],
  trigger_config: Record<string, unknown>
): Automation {
  return {
    id: 'a1',
    account_id: ACCOUNT,
    user_id: 'u1',
    name: 'funil',
    trigger_type,
    trigger_config,
    is_active: true,
    execution_count: 0,
    created_at: '',
    updated_at: '',
  };
}

describe('triggerMatches — deal_stage_changed', () => {
  const ctx = {
    deal_id: 'd1',
    pipeline_id: 'p1',
    from_stage_id: 's1',
    to_stage_id: 's2',
  };

  it('sem filtro nenhum, casa com qualquer passagem de etapa', () => {
    expect(triggerMatches(dealAutomation('deal_stage_changed', {}), ctx)).toBe(
      true
    );
  });

  it('casa quando a etapa de destino é a configurada', () => {
    expect(
      triggerMatches(
        dealAutomation('deal_stage_changed', { to_stage_id: 's2' }),
        ctx
      )
    ).toBe(true);
  });

  it('NÃO casa quando o destino é outra etapa', () => {
    expect(
      triggerMatches(
        dealAutomation('deal_stage_changed', { to_stage_id: 's9' }),
        ctx
      )
    ).toBe(false);
  });

  it('NÃO casa quando o funil é outro', () => {
    expect(
      triggerMatches(
        dealAutomation('deal_stage_changed', { pipeline_id: 'p9' }),
        ctx
      )
    ).toBe(false);
  });

  it('filtra também pela etapa de origem', () => {
    expect(
      triggerMatches(
        dealAutomation('deal_stage_changed', { from_stage_id: 's1' }),
        ctx
      )
    ).toBe(true);
    expect(
      triggerMatches(
        dealAutomation('deal_stage_changed', { from_stage_id: 's9' }),
        ctx
      )
    ).toBe(false);
  });

  it('combina os filtros por E, não por OU', () => {
    // Destino certo, origem errada: não deve casar.
    expect(
      triggerMatches(
        dealAutomation('deal_stage_changed', {
          to_stage_id: 's2',
          from_stage_id: 's9',
        }),
        ctx
      )
    ).toBe(false);
  });

  it('NÃO casa sem contexto de negócio — evita disparar em evento alheio', () => {
    expect(triggerMatches(dealAutomation('deal_stage_changed', {}), {})).toBe(
      false
    );
    expect(
      triggerMatches(dealAutomation('deal_stage_changed', {}), undefined)
    ).toBe(false);
  });
});

describe('triggerMatches — deal_created', () => {
  it('casa com qualquer funil quando o filtro está vazio', () => {
    expect(
      triggerMatches(dealAutomation('deal_created', {}), {
        deal_id: 'd1',
        pipeline_id: 'p1',
      })
    ).toBe(true);
  });

  it('respeita o filtro de funil', () => {
    expect(
      triggerMatches(dealAutomation('deal_created', { pipeline_id: 'p9' }), {
        deal_id: 'd1',
        pipeline_id: 'p1',
      })
    ).toBe(false);
  });

  it('NÃO casa sem negócio no contexto', () => {
    expect(triggerMatches(dealAutomation('deal_created', {}), {})).toBe(false);
  });
});

describe('triggerMatches — deal_stalled', () => {
  const ctx = {
    deal_id: 'd1',
    pipeline_id: 'p1',
    to_stage_id: 's1',
    stalled_days: 9,
  };

  it('casa quando a etapa vigiada é onde o negócio está', () => {
    expect(
      triggerMatches(
        dealAutomation('deal_stalled', { stage_id: 's1', days: 7 }),
        ctx
      )
    ).toBe(true);
  });

  it('NÃO casa para outra etapa', () => {
    expect(
      triggerMatches(
        dealAutomation('deal_stalled', { stage_id: 's9', days: 7 }),
        ctx
      )
    ).toBe(false);
  });

  it("NÃO casa sem etapa configurada — vigiar 'qualquer etapa' não tem significado", () => {
    expect(
      triggerMatches(dealAutomation('deal_stalled', { days: 7 }), ctx)
    ).toBe(false);
  });
});

describe('triggerMatches — practice_area_set', () => {
  it('lista vazia significa qualquer tese', () => {
    expect(
      triggerMatches(dealAutomation('practice_area_set', {}), {
        practice_area: 'bpc',
      })
    ).toBe(true);
    expect(
      triggerMatches(
        dealAutomation('practice_area_set', { practice_areas: [] }),
        {
          practice_area: 'bpc',
        }
      )
    ).toBe(true);
  });

  it('casa somente as teses listadas', () => {
    const a = dealAutomation('practice_area_set', {
      practice_areas: ['bpc', 'aposentadoria'],
    });
    expect(triggerMatches(a, { practice_area: 'bpc' })).toBe(true);
    expect(triggerMatches(a, { practice_area: 'isencao-ir' })).toBe(false);
  });

  it('NÃO casa sem tese no contexto', () => {
    expect(triggerMatches(dealAutomation('practice_area_set', {}), {})).toBe(
      false
    );
  });
});

describe('triggerMatches — document_signed', () => {
  it('sem filtro, casa com qualquer modelo', () => {
    expect(
      triggerMatches(dealAutomation('document_signed', {}), {
        vars: { template_token: 't1' },
      })
    ).toBe(true);
  });

  it('casa somente o modelo filtrado', () => {
    const a = dealAutomation('document_signed', { template_token: 't1' });
    expect(triggerMatches(a, { vars: { template_token: 't1' } })).toBe(true);
    expect(triggerMatches(a, { vars: { template_token: 't2' } })).toBe(false);
  });
});

function messageStep(text: string) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'send_message',
    position: 0,
    parent_step_id: null,
    step_config: { text },
  };
}

describe('send_message — tokens {{ contact.name }} / {{ contact.first_name }}', () => {
  it('resolve o nome completo vindo da consulta de posse', async () => {
    h.state.owned = { id: 'c1', name: 'Maria Silva Santos' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [messageStep('Boa notícia, {{ contact.name }}!')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    expect(engineSendText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe(
      'Boa notícia, Maria Silva Santos!'
    );
  });

  it('first_name pega só a primeira palavra do nome', async () => {
    h.state.owned = { id: 'c1', name: 'Maria Silva Santos' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [messageStep('Olá, {{ contact.first_name }}! 😊')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe(
      'Olá, Maria! 😊'
    );
  });

  it('contato sem nome resolve para vazio, como os demais tokens', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [messageStep('Olá{{ contact.first_name }}, tudo bem?')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe(
      'Olá, tudo bem?'
    );
  });

  it('enriquecer o contexto com o nome preserva as vars existentes', async () => {
    h.state.owned = { id: 'c1', name: 'João Pedro' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      messageStep('{{ contact.first_name }}, origem: {{ vars.source }}'),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1', vars: { source: 'Anúncio' } },
    });

    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe(
      'João, origem: Anúncio'
    );
  });
});

function signatureStep(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'send_signature_request',
    position: 0,
    parent_step_id: null,
    step_config: {
      template_token: 'template-1',
      document_name: 'Contrato',
      send_via_whatsapp: true,
      message_text: 'Assine aqui: {{signer_url}}',
      ...overrides,
    },
  };
}

describe('send_signature_request', () => {
  it('creates the ZapSign document, records it, and sends the link over WhatsApp', async () => {
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [signatureStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    expect(createDocumentFromTemplate).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createDocumentFromTemplate).mock.calls[0][0];
    expect(call.templateToken).toBe('template-1');
    expect(call.signer.name).toBe('Lead Test');
    expect(call.signer.phoneCountry).toBe('55');
    expect(call.signer.phoneNumber).toBe('11999999999');

    // A gravação é em dois tempos: a linha nasce sem token, e o id dela
    // vai ao ZapSign como external_id para o webhook conseguir
    // reencontrá-la se a resposta se perder.
    expect(h.state.zapsignDocInserts).toHaveLength(1);
    expect(h.state.zapsignDocInserts[0]).toMatchObject({
      account_id: ACCOUNT,
      contact_id: 'c1',
      zapsign_token: null,
      template_token: 'template-1',
    });
    expect(call.externalId).toBe(h.state.zapsignDocInserts[0].id);

    // …e o token só entra depois que o ZapSign confirmou.
    expect(h.state.zapsignDocUpdates).toHaveLength(1);
    expect(h.state.zapsignDocUpdates[0]).toMatchObject({
      zapsign_token: 'doc-token-1',
      sign_url: 'https://app.zapsign.com.br/verificar/s1',
    });
    expect(h.state.zapsignDocDeletes).toHaveLength(0);

    expect(engineSendText).toHaveBeenCalledTimes(1);
    const sendArgs = vi.mocked(engineSendText).mock.calls[0][0];
    expect(sendArgs.text).toContain('https://app.zapsign.com.br/verificar/s1');
  });

  it('attaches every extra template to the SAME envelope and sends one link', async () => {
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      signatureStep({
        extra_template_tokens: ['template-procuracao'],
        variables: { CPF: '123.456.789-00' },
      }),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    expect(attachExtraDocumentFromTemplate).toHaveBeenCalledTimes(1);
    const anexo = vi.mocked(attachExtraDocumentFromTemplate).mock.calls[0][0];
    // Anexa ao DOCUMENTO principal, nao ao modelo dele.
    expect(anexo.documentToken).toBe('doc-token-1');
    expect(anexo.templateToken).toBe('template-procuracao');
    // As mesmas variaveis: contrato e procuracao se qualificam com os
    // mesmos dados, e e isso que faz uma coleta so bastar.
    expect(anexo.variables).toEqual({ CPF: '123.456.789-00' });

    // Um envelope, um link, uma mensagem.
    expect(engineSendText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toContain(
      'https://app.zapsign.com.br/verificar/s1'
    );
  });

  it('does not send the link when an attachment fails, and keeps the orphan traceable', async () => {
    vi.mocked(attachExtraDocumentFromTemplate).mockRejectedValueOnce(
      new ZapsignApiError('ZapSign API returned 400', 400, '{"message":"modelo inativo"}')
    );
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      signatureStep({ extra_template_tokens: ['template-procuracao'] }),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    // Meio envelope nao chega ao lead.
    expect(engineSendText).not.toHaveBeenCalled();

    // A linha NAO sai: diferente da falha de criacao, aqui existe um
    // documento real e pago do outro lado, e apagar o registro o
    // orfanaria sem deixar rastro de onde cancelar.
    expect(h.state.zapsignDocDeletes).toHaveLength(0);
    expect(h.state.zapsignDocUpdates).toHaveLength(1);
    expect(h.state.zapsignDocUpdates[0]).toEqual({ zapsign_token: 'doc-token-1' });
    // Sem sign_url: ninguem manda a mao um envelope incompleto.
    expect(h.state.zapsignDocUpdates[0]).not.toHaveProperty('sign_url');
  });

  it('leaves the envelope untouched when no extra template is configured', async () => {
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [signatureStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    expect(attachExtraDocumentFromTemplate).not.toHaveBeenCalled();
    expect(engineSendText).toHaveBeenCalledTimes(1);
  });
  it('skips the WhatsApp send when send_via_whatsapp is false', async () => {
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      signatureStep({ send_via_whatsapp: false, message_text: undefined }),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(createDocumentFromTemplate).toHaveBeenCalledTimes(1);
    expect(engineSendText).not.toHaveBeenCalled();
  });

  it("fails the step (not the whole run silently) when ZapSign isn't configured", async () => {
    vi.mocked(getZapsignCredentials).mockResolvedValueOnce(null);
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [signatureStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(createDocumentFromTemplate).not.toHaveBeenCalled();
    expect(h.state.logUpdates.at(-1)).toMatchObject({ status: 'failed' });
  });

  // O builder sempre grava o campo, mas um JSON importado pode omiti-lo.
  // Tratar ausente como DESLIGADO gerava o documento, gastava a cota e
  // não mandava o link — com o log marcado como sucesso.
  it('treats a missing send_via_whatsapp as ON', async () => {
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [signatureStep({ send_via_whatsapp: undefined })];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    expect(createDocumentFromTemplate).toHaveBeenCalledTimes(1);
    expect(engineSendText).toHaveBeenCalledTimes(1);
    expect(h.state.logUpdates.at(-1)).toMatchObject({ status: 'success' });
  });

  // A conversa é resolvida ANTES da chamada externa: sem ela, o passo
  // falha sem gerar documento nenhum. Resolver depois deixava um
  // documento pago no ZapSign e uma linha `pending` que ninguém fecha.
  it('fails before spending a ZapSign call when the contact has no conversation', async () => {
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [signatureStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(createDocumentFromTemplate).not.toHaveBeenCalled();
    expect(h.state.zapsignDocInserts).toHaveLength(0);
    expect(h.state.logUpdates.at(-1)).toMatchObject({ status: 'failed' });
  });

  // A distinção que faz a diferença: sem resposta, o documento PODE
  // existir do outro lado, e a linha é o único registro dessa dúvida —
  // é por ela que o webhook fecha o caso sozinho depois.
  it('keeps the row when the ZapSign call never got an answer', async () => {
    vi.mocked(createDocumentFromTemplate).mockRejectedValueOnce(
      new ZapsignTransportError('ZapSign did not answer within 15000ms')
    );
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [signatureStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    expect(h.state.zapsignDocInserts).toHaveLength(1);
    expect(h.state.zapsignDocDeletes).toHaveLength(0);
    expect(h.state.logUpdates.at(-1)).toMatchObject({
      status: 'failed',
      error_message: expect.stringContaining('may still have been created'),
    });
  });

  // Recusa com status HTTP é uma decisão do ZapSign: não há dúvida a
  // registrar, então a linha não pode ficar poluindo a aba do contato.
  it('removes the row when ZapSign refuses the creation outright', async () => {
    vi.mocked(createDocumentFromTemplate).mockRejectedValueOnce(
      new ZapsignApiError('ZapSign API returned 400', 400, '{}')
    );
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [signatureStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    expect(h.state.zapsignDocInserts).toHaveLength(1);
    expect(h.state.zapsignDocDeletes).toHaveLength(1);
    expect(h.state.zapsignDocDeletes[0]).toContainEqual([
      'eq',
      'id',
      h.state.zapsignDocInserts[0].id,
    ]);
    expect(h.state.logUpdates.at(-1)).toMatchObject({ status: 'failed' });
  });

  // interpolate() zera todo {{...}} que não conhece, então o token do
  // link precisa ser trocado antes — inclusive na forma espaçada, que é
  // como os outros campos do builder ensinam a escrever token.
  it('substitutes {{ signer_url }} with spaces, and every occurrence', async () => {
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      signatureStep({
        message_text: 'Link: {{ signer_url }} — se cair, use {{signer_url}}',
      }),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1' },
    });

    const text = vi.mocked(engineSendText).mock.calls[0][0].text;
    expect(text).toBe(
      'Link: https://app.zapsign.com.br/verificar/s1 — se cair, use https://app.zapsign.com.br/verificar/s1'
    );
    expect(text).not.toContain('signer_url');
  });
});

// Ver docs/dividas-conhecidas.md#7: devolver uma string marcava a
// execução como sucesso e seguia adiante — o funil não mexia, sem erro e
// sem nada a investigar.
describe('passo desconhecido', () => {
  it('falha a execução em vez de registrar sucesso', async () => {
    h.state.owned = { id: 'c1', name: 'Lead Test', phone: '5511999999999' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'step_from_the_future',
        position: 0,
        parent_step_id: null,
        step_config: {},
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.logUpdates.at(-1)).toMatchObject({
      status: 'failed',
      error_message: expect.stringContaining('unknown step'),
    });
  });
});
