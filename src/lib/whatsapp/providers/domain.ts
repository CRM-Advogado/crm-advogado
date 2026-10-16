// Domain contracts: no framework, database, credential or vendor DTO imports.
export type ProviderId = 'meta_cloud' | 'ycloud' | 'gupshup';

export interface ProviderConnection {
  readonly accountId: string;
  readonly connectionId: string;
  readonly provider: ProviderId;
}

export interface ProviderExternalId extends ProviderConnection {
  readonly value: string;
}

export function externalId(
  connection: ProviderConnection,
  value: string
): ProviderExternalId {
  if (
    !connection.accountId?.trim() ||
    !connection.connectionId?.trim() ||
    !['meta_cloud', 'ycloud', 'gupshup'].includes(connection.provider) ||
    !value?.trim()
  ) {
    throw new Error('Invalid WhatsApp external reference');
  }
  return Object.freeze({ ...connection, value });
}

export function assertSameConnection(
  connection: ProviderConnection,
  reference: ProviderConnection
): void {
  if (
    connection.accountId !== reference.accountId ||
    connection.connectionId !== reference.connectionId ||
    connection.provider !== reference.provider
  ) {
    throw new Error('WhatsApp reference belongs to a different connection');
  }
}

export type ProviderOutcome = 'rejected' | 'retryable' | 'uncertain';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly connection: ProviderConnection,
    public readonly operation: string,
    public readonly code: string,
    public readonly outcome: ProviderOutcome,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio';
export interface Choice {
  id: string;
  title: string;
}
export interface ChoiceSection {
  title?: string;
  rows: (Choice & { description?: string })[];
}

export type TemplateValue =
  | { kind: 'text' | 'payload' | 'coupon'; value: string }
  | {
      kind: 'media';
      mediaKind: Exclude<MediaKind, 'audio'>;
      url?: string;
      reference?: ProviderExternalId;
    };

export type TemplateSlot =
  | { location: 'header' | 'body'; values: TemplateValue[] }
  | {
      location: 'button';
      action: 'url' | 'quick_reply' | 'copy_code';
      index: number;
      values: TemplateValue[];
    };

/** No idempotency key is promised by this port yet. An uncertain result must
 * be reconciled by provider ID/webhook; callers must not replay it blindly. */
interface MessageBase {
  to: string;
  replyTo?: ProviderExternalId;
}
export type OutboundMessage = MessageBase &
  (
    | { kind: 'text'; text: string }
    | {
        kind: 'media';
        mediaKind: MediaKind;
        url: string;
        caption?: string;
        filename?: string;
      }
    | {
        kind: 'template';
        name: string;
        language: string;
        slots: TemplateSlot[];
      }
    | {
        kind: 'buttons';
        body: string;
        header?: string;
        footer?: string;
        buttons: Choice[];
      }
    | {
        kind: 'list';
        body: string;
        header?: string;
        footer?: string;
        buttonLabel: string;
        sections: ChoiceSection[];
      }
    | { kind: 'reaction'; target: ProviderExternalId; emoji: string }
  );

export interface MessagingPort {
  send(message: OutboundMessage): Promise<ProviderExternalId>;
}

export interface MediaPort {
  retrieve(
    reference: ProviderExternalId
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
}

export interface ProviderCapabilities {
  readonly messages: readonly OutboundMessage['kind'][];
  readonly mediaDownload: boolean;
  readonly templateManagement: boolean;
  readonly onboarding: boolean;
  readonly maxButtons: number;
  readonly maxListRows: number;
  readonly maxMediaDownloadBytes?: number;
}

export interface WhatsAppProvider {
  readonly connection: ProviderConnection;
  readonly capabilities: ProviderCapabilities;
  readonly messaging: MessagingPort;
  readonly media?: MediaPort;
}
