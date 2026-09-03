/**
 * Guarda contra automações que se alimentam.
 *
 * O ciclo perigoso é curto: um passo `move_deal_stage` muda a etapa,
 * a mudança dispara `deal_stage_changed`, uma automação que escuta
 * esse gatilho move de novo — e assim por diante. Sem teto, dois
 * negócios em pingue-pongue consomem o processo inteiro.
 *
 * Espelha `src/lib/contacts/tag-chain.ts`, que resolve o mesmo
 * problema para `add_tag` / `tag_added`. Os dois contadores são
 * separados de propósito: uma cadeia de etiquetas não deve gastar o
 * orçamento de uma cadeia de funil, e vice-versa.
 */
export const MAX_DEAL_CHAIN_DEPTH = 3;

export function getDealChainDepth(context?: {
  vars?: Record<string, unknown>;
}): number {
  const raw = context?.vars?._deal_chain_depth;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : 0;
}
