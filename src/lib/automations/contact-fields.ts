// ============================================================
// Which contact columns an automation may write.
//
// Uma única lista, importada pelos três lugares que precisavam
// concordar e não concordavam:
//
//   - o motor  (src/lib/automations/engine.ts) — quem grava;
//   - o validador (src/lib/automations/validate.ts) — quem barra a
//     automação malformada antes de salvar;
//   - o construtor (src/components/automations/automation-builder.tsx)
//     — quem oferece os campos na tela.
//
// Enquanto a lista vivia dentro do motor, a tela podia oferecer (ou o
// usuário podia gravar direto no banco) um campo que o motor recusava
// em silêncio: o passo terminava com "field X not writable from
// automations" registrado como SUCESSO e nada era escrito. Foi o que
// aconteceu com `practice_area`, criada na migration 039 justamente
// para ser preenchida por automação.
//
// Deliberadamente FORA da lista:
//   - `phone` — é a chave de deduplicação do contato (migration 022);
//     reescrevê-la por automação funde ou duplica cadastro.
//   - `ad_source_id`, `ad_source_type`, `ad_headline`, `ad_source_url`,
//     `ctwa_clid`, `first_seen_at` — origem do lead. Quem escreve é o
//     webhook, a partir do que a Meta manda, uma única vez (migrations
//     040/041). Deixar uma automação sobrescrever destruiria a
//     atribuição de primeiro toque e, com ela, o relatório de custo
//     por caso.
//   - `id`, `account_id`, `user_id` — identidade e tenancy.
//
// Campos personalizados não passam por aqui: são endereçados como
// `custom:<id>` e gravados em `contact_custom_values`.
// ============================================================

/** Colunas de `contacts` graváveis pelo passo `update_contact_field`. */
export const AUTOMATION_WRITABLE_CONTACT_FIELDS = [
  'name',
  'email',
  'company',
  'practice_area',
] as const;

export type AutomationWritableContactField =
  (typeof AUTOMATION_WRITABLE_CONTACT_FIELDS)[number];

export function isWritableContactField(
  field: string
): field is AutomationWritableContactField {
  return (AUTOMATION_WRITABLE_CONTACT_FIELDS as readonly string[]).includes(
    field
  );
}

/** Prefixo dos campos personalizados (`custom:<custom_field_id>`). */
export const CUSTOM_FIELD_PREFIX = 'custom:';
