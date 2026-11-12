/**
 * Shared display config for message_templates.status.
 *
 * The DB stores Meta's raw enum (DRAFT / APPROVED / PENDING / REJECTED /
 * PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION) — the UI maps it to
 * a human label + status badge classes here so the template manager,
 * inbox picker, and broadcast picker stay aligned.
 */

import type { MessageTemplateStatus } from '@/types';

export interface TemplateStatusDisplay {
  label: string;
  classes: string;
}

export const templateStatusConfig: Record<
  MessageTemplateStatus,
  TemplateStatusDisplay
> = {
  DRAFT: {
    label: 'Draft',
    classes: 'bg-muted text-muted-foreground border-border',
  },
  PENDING: {
    label: 'Pending',
    classes: 'bg-yellow-600/15 text-yellow-800 dark:text-yellow-300 border-yellow-600/35',
  },
  APPROVED: {
    label: 'Approved',
    classes: 'bg-accent text-accent-foreground border-primary/25',
  },
  REJECTED: {
    label: 'Rejected',
    classes: 'bg-destructive/10 text-destructive border-destructive/30',
  },
  PAUSED: {
    label: 'Paused',
    classes: 'bg-orange-600/15 text-orange-800 dark:text-orange-300 border-orange-600/35',
  },
  DISABLED: {
    label: 'Disabled',
    classes: 'bg-destructive/15 text-destructive border-destructive/40',
  },
  IN_APPEAL: {
    label: 'In Appeal',
    classes: 'bg-blue-600/15 text-blue-800 dark:text-blue-300 border-blue-600/35',
  },
  PENDING_DELETION: {
    label: 'Pending Deletion',
    classes: 'bg-card-2 text-muted-foreground border-border',
  },
};
