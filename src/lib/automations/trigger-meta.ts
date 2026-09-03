import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  label: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

/**
 * Rótulos da pílula de gatilho na lista de automações.
 *
 * Este mapa NÃO passa por next-intl: os textos são literais. Como
 * esta instalação roda com `NEXT_PUBLIC_APP_LOCALE=pt`, os rótulos
 * ficam em português — antes da migration 042 eles estavam em inglês
 * dentro de uma interface inteiramente em português, o que fazia a
 * lista de automações destoar de todas as outras telas.
 *
 * Se um dia este arquivo virar traduzido de verdade, o lugar certo é
 * `Automations.builder.triggers.<tipo>.label`, que já existe nos três
 * arquivos de `messages/` e é usado pelo construtor.
 */
export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    label: 'Nova Mensagem',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
  first_inbound_message: {
    label: 'Primeira Mensagem do Contato',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  },
  keyword_match: {
    label: 'Palavra-chave',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  },
  new_contact_created: {
    label: 'Novo Contato',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    label: 'Conversa Atribuída',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  },
  tag_added: {
    label: 'Etiqueta Adicionada',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  time_based: {
    label: 'Por Horário',
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  },
  interactive_reply: {
    label: 'Botão / Lista',
    pillClass: 'border-pink-500/30 bg-pink-500/10 text-pink-300',
  },

  // ---- Gatilhos de funil (migration 042) --------------------
  deal_created: {
    label: 'Negócio Criado',
    pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  },
  deal_stage_changed: {
    label: 'Mudou de Etapa',
    pillClass: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
  },
  deal_stalled: {
    label: 'Parado na Etapa',
    pillClass: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  },
  practice_area_set: {
    label: 'Tese Classificada',
    pillClass: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  },

  // ---- ZapSign (migration 044) -------------------------------
  document_signed: {
    label: 'Documento Assinado',
    pillClass: 'border-lime-500/30 bg-lime-500/10 text-lime-300',
  },
}

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? {
      label: t,
      pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
    }
  )
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 2_592_000) return `${Math.floor(diffSec / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}
