import { describe, it, expect } from 'vitest';
import type { Deal, PipelineStage } from '@/types';
import { computePipelineAnalytics } from './pipeline-analytics';

const NOW = new Date(2026, 8, 15); // 15/set/2026
const LAST_MONTH = new Date(2026, 7, 10).toISOString();
const THIS_MONTH = new Date(2026, 8, 3).toISOString();

const stages: PipelineStage[] = [
  {
    id: 'novo',
    pipeline_id: 'p',
    name: 'Novo Lead',
    position: 0,
    color: '',
    created_at: '',
  },
  {
    id: 'enviado',
    pipeline_id: 'p',
    name: 'Contrato Enviado',
    position: 1,
    color: '',
    created_at: '',
  },
  {
    id: 'fechado',
    pipeline_id: 'p',
    name: 'Contrato Fechado',
    position: 2,
    color: '',
    created_at: '',
  },
  {
    id: 'assinado',
    pipeline_id: 'p',
    name: 'Contrato Assinado',
    position: 3,
    color: '',
    created_at: '',
  },
];

function deal(over: Partial<Deal>): Deal {
  return {
    id: Math.random().toString(36).slice(2),
    user_id: 'u',
    pipeline_id: 'p',
    stage_id: 'novo',
    contact_id: 'c',
    title: 't',
    value: 0,
    status: 'open',
    created_at: THIS_MONTH,
    updated_at: THIS_MONTH,
    stage_entered_at: THIS_MONTH,
    ...over,
  } as Deal;
}

describe('computePipelineAnalytics', () => {
  it('conta como fechado o negócio parado na etapa "Contrato Fechado" ainda com status open', () => {
    // É o caso real do funil BPC: arrastar o cartão não mexe em `status`.
    const deals = [
      deal({ stage_id: 'fechado', status: 'open', value: 2916 }),
      deal({ stage_id: 'novo', value: 0 }),
    ];
    const s = computePipelineAnalytics(deals, stages, NOW);
    expect(s.closedCount).toBe(1);
    expect(s.closedThisMonth).toBe(1);
  });

  it('também conta o negócio marcado como Ganho fora da etapa de fechamento', () => {
    const s = computePipelineAnalytics(
      [deal({ stage_id: 'enviado', status: 'won' })],
      stages,
      NOW
    );
    expect(s.closedCount).toBe(1);
  });

  it('aceita "Contrato Assinado" — a etapa final do Funil Previdenciário', () => {
    const s = computePipelineAnalytics(
      [deal({ stage_id: 'assinado', status: 'open' })],
      stages,
      NOW
    );
    expect(s.closedCount).toBe(1);
  });

  it('nunca conta um negócio perdido, mesmo na etapa de fechamento', () => {
    const s = computePipelineAnalytics(
      [deal({ stage_id: 'fechado', status: 'lost', value: 1000 })],
      stages,
      NOW
    );
    expect(s.closedCount).toBe(0);
    expect(s.totalCount).toBe(0);
    expect(s.totalValue).toBe(0);
  });

  it('divide o valor pelo número de contratos fechados, não pelo de leads', () => {
    const deals = [
      deal({ stage_id: 'fechado', value: 3000 }),
      deal({ stage_id: 'fechado', value: 1000 }),
      deal({ stage_id: 'novo', value: 0 }),
      deal({ stage_id: 'novo', value: 0 }),
    ];
    const s = computePipelineAnalytics(deals, stages, NOW);
    expect(s.totalValue).toBe(4000);
    expect(s.totalCount).toBe(4);
    expect(s.avgValue).toBe(2000); // 4000 / 2, e não 4000 / 4
  });

  it('devolve avgValue nulo quando nenhum contrato foi fechado', () => {
    const s = computePipelineAnalytics([deal({ value: 500 })], stages, NOW);
    expect(s.avgValue).toBeNull();
  });

  it('converte contratos fechados sobre o total de leads, sem envolver perdidos', () => {
    const deals = [
      deal({ stage_id: 'fechado' }),
      deal({ stage_id: 'novo' }),
      deal({ stage_id: 'novo' }),
      deal({ stage_id: 'novo' }),
      deal({ stage_id: 'novo', status: 'lost' }), // fora da conta dos dois lados
    ];
    const s = computePipelineAnalytics(deals, stages, NOW);
    expect(s.totalCount).toBe(4);
    expect(s.conversionRate).toBe(0.25);
  });

  it('devolve conversionRate nulo em funil sem lead', () => {
    expect(computePipelineAnalytics([], stages, NOW).conversionRate).toBeNull();
  });

  it('o recorte de mês vale só para "Contratos neste Mês"', () => {
    const deals = [
      deal({ stage_id: 'fechado', stage_entered_at: LAST_MONTH }),
      deal({ stage_id: 'fechado', stage_entered_at: THIS_MONTH }),
    ];
    const s = computePipelineAnalytics(deals, stages, NOW);
    expect(s.closedCount).toBe(2);
    expect(s.closedThisMonth).toBe(1);
  });

  it('data o fechamento pela entrada na etapa, nao por updated_at', () => {
    // Editar um contrato fechado mes passado nao pode traze-lo de volta
    // para o card deste mes.
    const s = computePipelineAnalytics(
      [
        deal({
          stage_id: 'fechado',
          stage_entered_at: LAST_MONTH,
          updated_at: THIS_MONTH,
        }),
      ],
      stages,
      NOW
    );
    expect(s.closedCount).toBe(1);
    expect(s.closedThisMonth).toBe(0);
  });

  it('cai em updated_at quando a linha nao tem stage_entered_at', () => {
    const s = computePipelineAnalytics(
      [deal({ stage_id: 'fechado', stage_entered_at: null })],
      stages,
      NOW
    );
    expect(s.closedThisMonth).toBe(1);
  });

  it('nao trata contrato fechado como lead a atender', () => {
    const tagged = {
      contact: { tags: [{ name: 'Atendimento Humano' }] },
    } as unknown as Partial<Deal>;
    const s = computePipelineAnalytics(
      [
        deal({ stage_id: 'fechado', ...tagged }),
        deal({ stage_id: 'novo', ...tagged }),
      ],
      stages,
      NOW
    );
    expect(s.leadsToAttend).toBe(1);
  });

  it('ignora etapa desconhecida em vez de quebrar', () => {
    const s = computePipelineAnalytics(
      [deal({ stage_id: 'etapa-que-nao-veio' })],
      stages,
      NOW
    );
    expect(s.closedCount).toBe(0);
  });
});
