import { describe, expect, it } from 'vitest';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from './validate';

describe('validateStepsForActivation', () => {
  it('rejects empty or missing step lists', () => {
    expect(validateStepsForActivation([])).toEqual([
      { path: 'steps', message: 'active automations need at least one step' },
    ]);
    expect(validateStepsForActivation(undefined as unknown as never[])).toEqual(
      [{ path: 'steps', message: 'active automations need at least one step' }]
    );
  });

  it('passes a fully-populated step set', () => {
    const issues = validateStepsForActivation([
      { step_type: 'send_message', step_config: { text: 'hi' } },
      {
        step_type: 'wait',
        step_config: { amount: 5, unit: 'minutes' },
      },
      { step_type: 'add_tag', step_config: { tag_id: 'tag-uuid' } },
      { step_type: 'close_conversation', step_config: {} },
    ]);
    expect(issues).toEqual([]);
  });

  it('flags every required field that is missing', () => {
    const issues = validateStepsForActivation([
      { step_type: 'send_message', step_config: { text: '  ' } },
      { step_type: 'send_template', step_config: {} },
      { step_type: 'add_tag', step_config: { tag_id: '' } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].text',
      'steps[1].template_name',
      'steps[2].tag_id',
    ]);
  });

  it('checks wait amount and unit boundaries', () => {
    const issues = validateStepsForActivation([
      { step_type: 'wait', step_config: { amount: 0, unit: 'minutes' } },
      { step_type: 'wait', step_config: { amount: 5, unit: 'seconds' } },
      { step_type: 'wait', step_config: { amount: -1, unit: 'hours' } },
      {
        step_type: 'wait',
        step_config: { amount: Number.POSITIVE_INFINITY, unit: 'days' },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].amount',
      'steps[1].unit',
      'steps[2].amount',
      'steps[3].amount',
    ]);
  });

  it('validates webhook URLs', () => {
    const good = validateStepsForActivation([
      {
        step_type: 'send_webhook',
        step_config: { url: 'https://hooks.example.com/in' },
      },
    ]);
    expect(good).toEqual([]);

    const noUrl = validateStepsForActivation([
      { step_type: 'send_webhook', step_config: {} },
    ]);
    expect(noUrl.map((i) => i.message)).toContain('webhook URL is required');

    const wrongProtocol = validateStepsForActivation([
      {
        step_type: 'send_webhook',
        step_config: { url: 'ftp://files.example.com' },
      },
    ]);
    expect(wrongProtocol.map((i) => i.message)).toContain(
      'webhook URL must use http or https'
    );

    const garbage = validateStepsForActivation([
      { step_type: 'send_webhook', step_config: { url: 'not a url' } },
    ]);
    expect(garbage.map((i) => i.message)).toContain(
      'webhook URL is not a valid URL'
    );
  });

  it('validates the extra documents attached to the envelope', () => {
    function comAnexos(extras: unknown) {
      return validateStepsForActivation([
        {
          step_type: 'send_signature_request',
          step_config: {
            template_token: 't1',
            document_name: 'Contrato',
            send_via_whatsapp: false,
            extra_template_tokens: extras,
          },
        },
      ]).map((i) => i.message);
    }

    // Ausente e vazio sao o envelope de um documento so, que era o
    // comportamento antes desta opcao existir.
    expect(comAnexos(undefined)).toEqual([]);
    expect(comAnexos([])).toEqual([]);
    expect(comAnexos(['t2', 't3'])).toEqual([]);

    // As tres regras sao cobradas no save porque anexo NAO pode ser
    // removido depois: um envelope montado errado so se conserta
    // cancelando e refazendo, gastando credito de novo.
    expect(comAnexos('t2')).toContain(
      'extra templates must be a list of ZapSign template tokens'
    );
    expect(comAnexos(['t2', ''])).toContain(
      'extra templates must be a list of ZapSign template tokens'
    );
    expect(comAnexos(['t2', 't2'])).toContain(
      'the same template is attached more than once'
    );
    expect(comAnexos(['t1'])).toContain(
      'the main template is also attached as an extra document'
    );
    expect(
      comAnexos(Array.from({ length: 15 }, (_, i) => `extra-${i}`))
    ).toContain('at most 14 extra documents per envelope');
  });
  it('validates send_signature_request', () => {
    const good = validateStepsForActivation([
      {
        step_type: 'send_signature_request',
        step_config: {
          template_token: 't1',
          document_name: 'Contrato',
          send_via_whatsapp: true,
          message_text: 'Assine aqui: {{signer_url}}',
        },
      },
    ]);
    expect(good).toEqual([]);

    const missingTemplate = validateStepsForActivation([
      {
        step_type: 'send_signature_request',
        step_config: { document_name: 'Contrato', send_via_whatsapp: false },
      },
    ]);
    expect(missingTemplate.map((i) => i.message)).toContain(
      'ZapSign template is required'
    );

    const missingName = validateStepsForActivation([
      {
        step_type: 'send_signature_request',
        step_config: { template_token: 't1', send_via_whatsapp: false },
      },
    ]);
    expect(missingName.map((i) => i.message)).toContain(
      'document name is required'
    );

    const missingMessage = validateStepsForActivation([
      {
        step_type: 'send_signature_request',
        step_config: {
          template_token: 't1',
          document_name: 'Contrato',
          send_via_whatsapp: true,
        },
      },
    ]);
    expect(missingMessage.map((i) => i.message)).toContain(
      'message text is required when sending the link via WhatsApp'
    );

    // send_via_whatsapp false: no message required.
    const okWithoutWhatsapp = validateStepsForActivation([
      {
        step_type: 'send_signature_request',
        step_config: {
          template_token: 't1',
          document_name: 'Contrato',
          send_via_whatsapp: false,
        },
      },
    ]);
    expect(okWithoutWhatsapp).toEqual([]);

    // Campo AUSENTE vale ligado, igual ao motor e ao builder — senão um
    // payload importado sem o campo passava aqui sem texto nenhum e o
    // motor tentava mandar mensagem vazia.
    const missingFlagStillNeedsMessage = validateStepsForActivation([
      {
        step_type: 'send_signature_request',
        step_config: { template_token: 't1', document_name: 'Contrato' },
      },
    ]);
    expect(missingFlagStillNeedsMessage.map((i) => i.message)).toContain(
      'message text is required when sending the link via WhatsApp'
    );
  });

  it("validates assign_conversation only when mode is 'specific'", () => {
    const roundRobinNoAgent = validateStepsForActivation([
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ]);
    expect(roundRobinNoAgent).toEqual([]);

    const specificMissingAgent = validateStepsForActivation([
      { step_type: 'assign_conversation', step_config: { mode: 'specific' } },
    ]);
    expect(specificMissingAgent.map((i) => i.path)).toEqual([
      'steps[0].agent_id',
    ]);
  });

  it('flags create_deal when required fields are missing', () => {
    const issues = validateStepsForActivation([
      { step_type: 'create_deal', step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      'steps[0].pipeline_id',
      'steps[0].stage_id',
      'steps[0].title',
    ]);
  });

  it('validates send_buttons / send_list interactive payloads', () => {
    const good = validateStepsForActivation([
      {
        step_type: 'send_buttons',
        step_config: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'yes', title: 'Yes' }],
        },
      },
    ]);
    expect(good).toEqual([]);

    const tooMany = validateStepsForActivation([
      {
        step_type: 'send_buttons',
        step_config: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
    ]);
    expect(tooMany.map((i) => i.path)).toEqual(['steps[0].interactive']);
  });

  it('flags update_contact_field when field or value is missing', () => {
    const issues = validateStepsForActivation([
      { step_type: 'update_contact_field', step_config: { field: 'name' } },
      {
        step_type: 'update_contact_field',
        step_config: { field: '', value: 'x' },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].value',
      'steps[1].field',
    ]);
  });

  it('recursively walks condition branches with stable dot-paths', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: { subject: 'tag', operand: 'vip' },
        branches: {
          yes: [{ step_type: 'add_tag', step_config: { tag_id: '' } }],
          no: [
            {
              step_type: 'send_message',
              step_config: { text: '' },
            },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].yes.steps[0].tag_id',
      'steps[0].no.steps[0].text',
    ]);
  });

  it('reports an issue for unknown step types', () => {
    const issues = validateStepsForActivation([
      { step_type: 'do_a_barrel_roll', step_config: {} },
    ]);
    expect(issues).toEqual([
      { path: 'steps[0]', message: 'unknown step type: do_a_barrel_roll' },
    ]);
  });

  it('flags condition subject/operand independently', () => {
    const issues = validateStepsForActivation([
      { step_type: 'condition', step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      'steps[0].operand',
      'steps[0].subject',
    ]);
  });
});

describe('validateTriggerForActivation', () => {
  it('accepts a valid keyword_match config', () => {
    expect(
      validateTriggerForActivation('keyword_match', {
        keywords: ['hello', 'hi'],
        match_type: 'exact',
      })
    ).toEqual([]);
  });

  it('rejects keyword_match with empty keyword array', () => {
    const issues = validateTriggerForActivation('keyword_match', {
      keywords: [],
      match_type: 'exact',
    });
    expect(issues.map((i) => i.path)).toContain('trigger.keywords');
  });

  it('rejects keyword_match with whitespace-only entries', () => {
    const issues = validateTriggerForActivation('keyword_match', {
      keywords: ['hi', '   '],
      match_type: 'contains',
    });
    expect(issues.map((i) => i.message)).toContain(
      'keywords cannot be empty strings'
    );
  });

  it('rejects keyword_match with an unknown match_type', () => {
    const issues = validateTriggerForActivation('keyword_match', {
      keywords: ['hi'],
      match_type: 'fuzzy',
    });
    expect(issues.map((i) => i.path)).toContain('trigger.match_type');
  });

  it('accepts keyword_match with a missing match_type (defaults to contains)', () => {
    expect(
      validateTriggerForActivation('keyword_match', { keywords: ['hi'] })
    ).toEqual([]);
  });

  it('requires schedule on time_based triggers', () => {
    expect(validateTriggerForActivation('time_based', {})).toEqual([
      { path: 'trigger.schedule', message: 'schedule is required' },
    ]);
    expect(
      validateTriggerForActivation('time_based', { schedule: '0 9 * * *' })
    ).toEqual([]);
  });

  it('requires tag_id on tag_added triggers', () => {
    expect(validateTriggerForActivation('tag_added', {})).toEqual([
      { path: 'trigger.tag_id', message: 'tag is required' },
    ]);
    expect(
      validateTriggerForActivation('tag_added', { tag_id: 'tag-uuid' })
    ).toEqual([]);
  });

  it('requires reply_ids on interactive_reply triggers', () => {
    expect(validateTriggerForActivation('interactive_reply', {})).toEqual([
      {
        path: 'trigger.reply_ids',
        message: 'at least one reply id is required',
      },
    ]);
    expect(
      validateTriggerForActivation('interactive_reply', {
        reply_ids: ['yes', 'no'],
      })
    ).toEqual([]);
    const empties = validateTriggerForActivation('interactive_reply', {
      reply_ids: ['yes', '  '],
    });
    expect(empties.map((i) => i.message)).toContain(
      'reply ids cannot be empty strings'
    );
  });

  it('does not flag unknown trigger types (handled elsewhere)', () => {
    expect(validateTriggerForActivation('some_future_trigger', {})).toEqual([]);
  });

  // ---- Gatilhos de funil (migration 042) ----

  it('exige etapa e prazo em deal_stalled', () => {
    const issues = validateTriggerForActivation('deal_stalled', {});
    expect(issues.map((i) => i.path).sort()).toEqual([
      'trigger.days',
      'trigger.stage_id',
    ]);
  });

  it('recusa prazo zero ou negativo em deal_stalled', () => {
    expect(
      validateTriggerForActivation('deal_stalled', {
        stage_id: 's1',
        days: 0,
      }).map((i) => i.path)
    ).toEqual(['trigger.days']);
    expect(
      validateTriggerForActivation('deal_stalled', {
        stage_id: 's1',
        days: -3,
      }).map((i) => i.path)
    ).toEqual(['trigger.days']);
  });

  it('aceita deal_stalled bem configurado', () => {
    expect(
      validateTriggerForActivation('deal_stalled', { stage_id: 's1', days: 7 })
    ).toEqual([]);
  });

  // Filtros vazios significam "qualquer", então não há configuração
  // inválida a barrar nestes dois.
  it('não barra deal_created nem deal_stage_changed sem filtros', () => {
    expect(validateTriggerForActivation('deal_created', {})).toEqual([]);
    expect(validateTriggerForActivation('deal_stage_changed', {})).toEqual([]);
  });

  it('recusa lista de teses malformada em practice_area_set', () => {
    expect(
      validateTriggerForActivation('practice_area_set', {
        practice_areas: 'bpc',
      }).map((i) => i.message)
    ).toContain('practice areas must be a list');
    expect(
      validateTriggerForActivation('practice_area_set', {
        practice_areas: ['bpc', '  '],
      }).map((i) => i.message)
    ).toContain('practice areas cannot be empty strings');
  });

  it('aceita practice_area_set sem lista (qualquer tese)', () => {
    expect(validateTriggerForActivation('practice_area_set', {})).toEqual([]);
  });
});

describe('validateStepsForActivation — move_deal_stage', () => {
  it('exige funil e etapa', () => {
    const issues = validateStepsForActivation([
      { step_type: 'move_deal_stage', step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      'steps[0].pipeline_id',
      'steps[0].stage_id',
    ]);
  });

  it("aceita configuração mínima válida — match_by ausente vale 'auto'", () => {
    expect(
      validateStepsForActivation([
        {
          step_type: 'move_deal_stage',
          step_config: { pipeline_id: 'p1', stage_id: 's1' },
        },
      ])
    ).toEqual([]);
  });

  it('recusa um modo de casamento desconhecido', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'move_deal_stage',
        step_config: {
          pipeline_id: 'p1',
          stage_id: 's1',
          match_by: 'telepatia',
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual(['steps[0].match_by']);
  });

  it('exige título quando vai criar o negócio (deals.title é NOT NULL)', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'move_deal_stage',
        step_config: {
          pipeline_id: 'p1',
          stage_id: 's1',
          create_if_missing: true,
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual(['steps[0].title']);
  });

  it('recusa criar negócio casando por contexto — combinação impossível', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'move_deal_stage',
        step_config: {
          pipeline_id: 'p1',
          stage_id: 's1',
          match_by: 'context',
          create_if_missing: true,
          title: 'Lead',
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual(['steps[0].create_if_missing']);
  });

  it('recusa um status fora do CHECK da migration 002', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'move_deal_stage',
        step_config: {
          pipeline_id: 'p1',
          stage_id: 's1',
          set_status: 'arquivado',
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual(['steps[0].set_status']);
  });
});
