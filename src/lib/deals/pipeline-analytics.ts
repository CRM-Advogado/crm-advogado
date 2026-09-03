import type { Deal, PipelineStage } from '@/types';

/**
 * Métricas do cabeçalho da aba Funis.
 *
 * Ficam aqui, e não dentro do componente, porque a definição de
 * "contrato fechado" é regra de negócio e não desenho de tela — e
 * porque é o único jeito de testá-la sem montar React (convenção do
 * projeto: a lógica mora em `src/lib`, o componente só apresenta).
 */

/**
 * Nomes de etapa que significam "contrato fechado".
 *
 * O esquema não tem coluna que marque a etapa final de um funil
 * (`pipeline_stages` é só nome/posição/cor), então o reconhecimento é
 * por nome — mesmo arranjo que a etiqueta "Atendimento Humano" já usa
 * no componente. São duas porque os dois funis semeados nomeiam a
 * etapa final de formas diferentes: "Contrato Fechado" no funil BPC e
 * "Contrato Assinado" no Funil Previdenciário (migration 043).
 *
 * Renomear a etapa no app faz o funil sair da conta — se um funil novo
 * usar outro nome, ele entra aqui.
 */
export const CLOSED_CONTRACT_STAGE_NAMES = [
  'Contrato Fechado',
  'Contrato Assinado',
];

const CLOSED_STAGE_KEYS = new Set(
  CLOSED_CONTRACT_STAGE_NAMES.map((n) => n.trim().toLowerCase())
);

export interface PipelineAnalyticsStats {
  /** Leads não perdidos — o card "Total de Leads". */
  totalCount: number;
  /** Soma dos valores dos leads não perdidos — o card "Valor dos Contratos". */
  totalValue: number;
  /** `totalValue / closedCount`; `null` quando não há contrato fechado. */
  avgValue: number | null;
  /** Contratos fechados no funil inteiro, sem recorte de mês. */
  closedCount: number;
  /** Negócios ainda não fechados com contato etiquetado "Atendimento Humano". */
  leadsToAttend: number;
  /** Contratos fechados desde o dia 1 do mês corrente, por `stage_entered_at`. */
  closedThisMonth: number;
  /** `closedCount / totalCount`; `null` quando o funil não tem lead. */
  conversionRate: number | null;
}

/** Nome exato da etiqueta de atendimento humanizado, cadastrada por conta em Configurações > Etiquetas. */
export const HUMAN_SERVICE_TAG_NAME = 'Atendimento Humano';

/**
 * Um negócio conta como contrato fechado quando está na etapa de
 * fechamento OU quando alguém já o marcou como Ganho.
 *
 * Os dois caminhos existem de verdade: arrastar o cartão para
 * "Contrato Fechado" deixa `status` em `open` (nada no motor o muda),
 * enquanto a automação semeada pela 043 marca `won` ao etiquetar
 * "Contrato Assinado". Olhar só para `status` perde o primeiro caso —
 * era exatamente por isso que o card ficava zerado.
 */
export function isClosedContract(
  deal: Deal,
  stageNameById: Map<string, string>
): boolean {
  if (deal.status === 'lost') return false;
  if (deal.status === 'won') return true;
  const stageName = stageNameById.get(deal.stage_id);
  if (!stageName) return false;
  return CLOSED_STAGE_KEYS.has(stageName.trim().toLowerCase());
}

/**
 * Quando o contrato foi fechado.
 *
 * `stage_entered_at` (migration 042) é mantido por gatilho de BANCO a
 * cada troca de `stage_id`, por qualquer caminho de escrita — então
 * num negócio parado na etapa de fechamento ele é literalmente a hora
 * em que o contrato fechou, e editar o negócio depois não o move.
 * `updated_at` não serve para isso: qualquer edição o traz para o mês
 * corrente e faz um contrato antigo reaparecer como fechado agora.
 *
 * A cadeia de fallback cobre o negócio marcado como Ganho sem trocar
 * de etapa, e linhas anteriores à 042 que nunca receberam o carimbo.
 */
function closedAt(deal: Deal): Date {
  const ts = deal.stage_entered_at ?? deal.updated_at ?? deal.created_at;
  return ts ? new Date(ts) : new Date(0);
}

export function computePipelineAnalytics(
  deals: Deal[],
  stages: PipelineStage[],
  now: Date = new Date()
): PipelineAnalyticsStats {
  const stageNameById = new Map(stages.map((s) => [s.id, s.name]));

  const active = deals.filter((d) => d.status !== 'lost');
  const closed = active.filter((d) => isClosedContract(d, stageNameById));

  const totalCount = active.length;
  const totalValue = active.reduce((sum, d) => sum + Number(d.value || 0), 0);

  const closedCount = closed.length;
  const avgValue = closedCount > 0 ? totalValue / closedCount : null;

  // "Aberto" aqui é o complemento de contrato fechado, e não `status
  // !== 'won'`: um negócio parado na etapa "Contrato Fechado" continua
  // com `status: 'open'` no banco, e contá-lo como lead a atender
  // mandava o escritório correr atrás de quem já assinou.
  const openDeals = active.filter((d) => !isClosedContract(d, stageNameById));
  const leadsToAttend = openDeals.filter((d) =>
    d.contact?.tags?.some((tag) => tag.name === HUMAN_SERVICE_TAG_NAME)
  ).length;

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const closedThisMonth = closed.filter(
    (d) => closedAt(d) >= monthStart
  ).length;

  const conversionRate = totalCount > 0 ? closedCount / totalCount : null;

  return {
    totalCount,
    totalValue,
    avgValue,
    closedCount,
    leadsToAttend,
    closedThisMonth,
    conversionRate,
  };
}
