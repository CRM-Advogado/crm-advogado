// Existing database rows and Meta-shaped builders stop at this boundary.
import type { MessageTemplate } from '@/types';
import {
  buildSendComponents,
  type SendTimeParams,
  type MetaSendComponent,
} from '../template-send-builder';
import {
  externalId,
  type OutboundMessage,
  type ProviderConnection,
  type TemplateSlot,
  type TemplateValue,
} from './domain';

type Parameter = MetaSendComponent['parameters'][number];

function value(
  connection: ProviderConnection,
  parameter: Parameter
): TemplateValue {
  switch (parameter.type) {
    case 'text':
      return { kind: 'text', value: parameter.text };
    case 'payload':
      return { kind: 'payload', value: parameter.payload };
    case 'coupon_code':
      return { kind: 'coupon', value: parameter.coupon_code };
    case 'image':
    case 'video':
    case 'document': {
      const media =
        parameter.type === 'image'
          ? parameter.image
          : parameter.type === 'video'
            ? parameter.video
            : parameter.document;
      return {
        kind: 'media',
        mediaKind: parameter.type,
        url: media.link,
        reference: media.id ? externalId(connection, media.id) : undefined,
      };
    }
  }
}

export function toTemplateMessage(
  connection: ProviderConnection,
  args: {
    to: string;
    templateName: string;
    language?: string;
    params?: string[];
    template?: MessageTemplate;
    messageParams?: SendTimeParams;
    contextMessageId?: string;
  }
): OutboundMessage {
  const components = args.template
    ? buildSendComponents(args.template, {
        ...args.messageParams,
        body: args.messageParams?.body ?? args.params,
      })
    : args.params?.length
      ? [
          {
            type: 'body' as const,
            parameters: args.params.map((text) => ({
              type: 'text' as const,
              text: String(text),
            })),
          },
        ]
      : [];
  const slots: TemplateSlot[] = components.map(
    (component) =>
      ({
        location: component.type,
        ...(component.type === 'button'
          ? { action: component.sub_type, index: Number(component.index) }
          : {}),
        values: component.parameters.map((parameter) =>
          value(connection, parameter)
        ),
      }) as TemplateSlot
  );
  return {
    kind: 'template',
    to: args.to,
    name: args.templateName,
    language: args.language ?? 'en_US',
    slots,
    replyTo: args.contextMessageId
      ? externalId(connection, args.contextMessageId)
      : undefined,
  };
}
