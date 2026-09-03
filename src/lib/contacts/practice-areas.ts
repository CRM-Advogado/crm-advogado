// ============================================================
// Teses do escritório (`contacts.practice_area` / `deals.practice_area`).
//
// As CHAVES abaixo têm de espelhar exatamente a restrição CHECK da
// migration 039 — é o banco que decide o que é válido; esta lista só
// existe para a interface não oferecer nada que o banco vá recusar.
// Ao acrescentar uma tese, edite os dois lugares (as duas listas da
// 039 e esta) na mesma alteração.
//
// Os RÓTULOS são só de tela. A própria 039 documenta essa divisão: a
// chave nunca muda, o nome bonito pode mudar quando quiser, sem tocar
// no banco.
// ============================================================

export interface PracticeArea {
  /** Valor gravado na coluna. Minúsculo, sem acento, sem espaço. */
  key: string;
  /** Nome exibido. Livre para mudar. */
  label: string;
}

export const PRACTICE_AREAS: readonly PracticeArea[] = [
  { key: 'bpc', label: 'BPC / LOAS' },
  { key: 'auxilio-acidente', label: 'Auxílio-acidente' },
  { key: 'aposentadoria', label: 'Aposentadoria' },
  { key: 'isencao-ir', label: 'Isenção de IR' },
  { key: 'outro', label: 'Outro' },
];

/** True quando `value` é uma tese conhecida. */
export function isPracticeAreaKey(value: string): boolean {
  return PRACTICE_AREAS.some((area) => area.key === value);
}

/** Rótulo de exibição da tese; devolve a própria chave se desconhecida. */
export function practiceAreaLabel(key: string): string {
  return PRACTICE_AREAS.find((area) => area.key === key)?.label ?? key;
}
