import { beforeEach, describe, expect, it, vi } from 'vitest';

// A rota importa o cliente SSR, o service-role e o validador no topo
// do módulo; todos precisam existir para o import não explodir, mesmo
// que só o DELETE seja exercitado aqui.
const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  del: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/automations/templates', () => ({ getTemplate: vi.fn() }));
vi.mock('@/lib/automations/steps-tree', () => ({ insertSteps: vi.fn() }));
vi.mock('@/lib/automations/validate', () => ({
  validateStepsForActivation: vi.fn(() => []),
  validateTriggerForActivation: vi.fn(() => []),
}));

import { DELETE } from './route';

const context = {
  supabase: { from: mocks.from },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  account: { id: 'account-1', name: 'Escritorio' },
};

function request(url: string) {
  return new Request(url, { method: 'DELETE' });
}

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.from.mockReset();
  mocks.del.mockReset();
  mocks.eq.mockReset();
  mocks.select.mockReset();

  mocks.requireRole.mockResolvedValue(context);
  mocks.from.mockReturnValue({ delete: mocks.del });
  mocks.del.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue({ select: mocks.select });
  mocks.select.mockResolvedValue({ data: [{ id: 'a' }, { id: 'b' }], error: null });
});

describe('DELETE /api/automations', () => {
  it('apaga tudo da conta e devolve quantas eram', async () => {
    const response = await DELETE(request('http://localhost/api/automations?all=true'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: 2 });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.from).toHaveBeenCalledWith('automations');
    // O escopo por conta é o ponto: sem este filtro o service-role de
    // amanha apagaria a base inteira. Ver docs/mapa-tenancy.md.
    expect(mocks.eq).toHaveBeenCalledWith('account_id', 'account-1');
  });

  it('recusa sem ?all=true, antes de tocar no banco', async () => {
    const response = await DELETE(request('http://localhost/api/automations'));

    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('recusa quando o parametro vem com outro valor', async () => {
    const response = await DELETE(request('http://localhost/api/automations?all=1'));

    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('exige o papel agent antes de apagar', async () => {
    mocks.requireRole.mockRejectedValue(new Error('nope'));

    const response = await DELETE(request('http://localhost/api/automations?all=true'));

    expect(response.status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('devolve 500 sem vazar a mensagem do banco', async () => {
    mocks.select.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const response = await DELETE(request('http://localhost/api/automations?all=true'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Could not delete automations',
    });
  });
});
