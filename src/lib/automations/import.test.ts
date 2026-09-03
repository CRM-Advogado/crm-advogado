import { describe, expect, it } from "vitest";
import {
  IMPORT_LIMITS,
  checkWebhookUrls,
  parseImportDocument,
  type ReferenceCatalog,
} from "./import";

// Catálogo sintético. "Lead" aparece duas vezes de propósito: é o
// caso que os nomes sem UNIQUE no banco tornam possível.
const catalog: ReferenceCatalog = {
  tags: [
    { id: "tag-bpc", name: "Lead BPC" },
    { id: "tag-dup-a", name: "Lead" },
    { id: "tag-dup-b", name: "Lead" },
  ],
  pipelines: [
    { id: "pipe-bpc", name: "Funil BPC" },
    { id: "pipe-civel", name: "Funil Cível" },
  ],
  stages: [
    { id: "stage-bpc-triagem", name: "Triagem", pipeline_id: "pipe-bpc" },
    { id: "stage-bpc-fechado", name: "Fechado", pipeline_id: "pipe-bpc" },
    // Mesmo nome, outro funil — por isso etapa resolve dentro do funil.
    { id: "stage-civel-triagem", name: "Triagem", pipeline_id: "pipe-civel" },
  ],
  agents: [
    { id: "user-ana", name: "Ana Souza" },
    { id: "user-ana", name: "ana@escritorio.com" },
  ],
  customFields: [{ id: "cf-processo", name: "Número do Processo" }],
};

function doc(automations: unknown[]): unknown {
  return { version: 1, automations };
}

function sendMessage(text = "oi") {
  return { step_type: "send_message", step_config: { text } };
}

describe("parseImportDocument — envelope", () => {
  it("rejects anything that is not an object", () => {
    expect(parseImportDocument([], catalog).issues[0].code).toBe("invalid_document");
    expect(parseImportDocument("nope", catalog).issues[0].code).toBe("invalid_document");
    expect(parseImportDocument(null, catalog).issues[0].code).toBe("invalid_document");
  });

  it("rejects a format version it does not speak", () => {
    const { issues } = parseImportDocument({ version: 99, automations: [] }, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("version");
  });

  it("accepts a document with no version field", () => {
    const { issues } = parseImportDocument(
      {
        automations: [
          { name: "A", trigger_type: "new_message_received", steps: [sendMessage()] },
        ],
      },
      catalog,
    );
    expect(issues).toEqual([]);
  });

  it("rejects an empty automation list", () => {
    expect(parseImportDocument(doc([]), catalog).issues[0].code).toBe("invalid_document");
  });
});

describe("parseImportDocument — limites", () => {
  it("refuses more automations than the cap", () => {
    const many = Array.from({ length: IMPORT_LIMITS.maxAutomations + 1 }, (_, i) => ({
      name: `A${i}`,
      trigger_type: "new_message_received",
      steps: [sendMessage()],
    }));
    const { issues } = parseImportDocument(doc(many), catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("limit_exceeded");
  });

  it("refuses more steps than the cap", () => {
    const steps = Array.from({ length: IMPORT_LIMITS.maxStepsPerAutomation + 5 }, () =>
      sendMessage(),
    );
    const { issues } = parseImportDocument(
      doc([{ name: "A", trigger_type: "new_message_received", steps }]),
      catalog,
    );
    expect(issues.some((i) => i.code === "limit_exceeded")).toBe(true);
  });

  it("refuses nesting deeper than the cap instead of overflowing the stack", () => {
    // Este é o caso que motiva o limite: sem ele, `validate.ts` e
    // `steps-tree.ts` descem pela árvore e estouram a pilha ANTES de
    // conseguirem recusar o arquivo.
    let nested: Record<string, unknown> = sendMessage("fundo");
    for (let i = 0; i < IMPORT_LIMITS.maxDepth + 2; i++) {
      nested = {
        step_type: "condition",
        step_config: { subject: "message_content", operand: "x" },
        branches: { yes: [nested], no: [] },
      };
    }

    const { issues } = parseImportDocument(
      doc([{ name: "Fundo", trigger_type: "new_message_received", steps: [nested] }]),
      catalog,
    );
    expect(issues.some((i) => i.code === "limit_exceeded")).toBe(true);
  });
});

describe("parseImportDocument — tipos desconhecidos", () => {
  it("rejects an unknown step type even when the automation is a draft", () => {
    // O ponto do módulo: a rota POST /api/automations só valida
    // quando `is_active` é verdadeiro, então um rascunho seria um
    // caminho de escrita sem validação nenhuma.
    const { issues } = parseImportDocument(
      doc([
        {
          name: "Rascunho",
          trigger_type: "new_message_received",
          is_active: false,
          steps: [{ step_type: "exec_shell", step_config: { cmd: "rm -rf /" } }],
        },
      ]),
      catalog,
    );
    expect(issues.some((i) => i.code === "unknown_type")).toBe(true);
  });

  it("rejects an unknown trigger type", () => {
    const { issues } = parseImportDocument(
      doc([{ name: "A", trigger_type: "on_full_moon", steps: [sendMessage()] }]),
      catalog,
    );
    expect(issues[0].code).toBe("unknown_type");
  });

  it("rejects branches on a step that is not a condition", () => {
    // Os dois `walk` ignoram `branches` fora de `condition`, então
    // sem este aviso os passos sumiriam em silêncio.
    const { issues } = parseImportDocument(
      doc([
        {
          name: "A",
          trigger_type: "new_message_received",
          steps: [{ ...sendMessage(), branches: { yes: [sendMessage()] } }],
        },
      ]),
      catalog,
    );
    expect(issues.some((i) => i.path.endsWith(".branches"))).toBe(true);
  });
});

describe("parseImportDocument — referências", () => {
  it("resolves a tag by name", () => {
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Etiqueta",
          trigger_type: "new_message_received",
          steps: [{ step_type: "add_tag", step_config: { tag: "Lead BPC" } }],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
    expect(automations[0].steps[0].step_config).toEqual({ tag_id: "tag-bpc" });
  });

  it("matches names case-insensitively and trims", () => {
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Etiqueta",
          trigger_type: "new_message_received",
          steps: [{ step_type: "add_tag", step_config: { tag: "  lead bpc  " } }],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
    expect(automations[0].steps[0].step_config).toEqual({ tag_id: "tag-bpc" });
  });

  it("refuses an ambiguous name instead of guessing", () => {
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Etiqueta",
          trigger_type: "new_message_received",
          steps: [{ step_type: "add_tag", step_config: { tag: "Lead" } }],
        },
      ]),
      catalog,
    );
    expect(issues.some((i) => i.code === "ambiguous_reference")).toBe(true);
    // E não grava nenhum dos dois candidatos.
    expect(automations[0].steps[0].step_config.tag_id).toBeUndefined();
  });

  it("rejects a UUID that belongs to another account", () => {
    // A checagem de posse: o id não está no catálogo da conta, e o
    // catálogo é montado com filtro por account_id.
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Vizinho",
          trigger_type: "new_message_received",
          steps: [
            { step_type: "add_tag", step_config: { tag_id: "tag-de-outro-inquilino" } },
          ],
        },
      ]),
      catalog,
    );
    expect(issues.some((i) => i.code === "unresolved_reference")).toBe(true);
    expect(automations[0].steps[0].step_config.tag_id).toBeUndefined();
  });

  it("accepts a UUID that does belong to the account", () => {
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Proprio",
          trigger_type: "new_message_received",
          steps: [{ step_type: "add_tag", step_config: { tag_id: "tag-bpc" } }],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
    expect(automations[0].steps[0].step_config.tag_id).toBe("tag-bpc");
  });

  it("resolves a stage within its own pipeline", () => {
    // "Triagem" existe nos dois funis; o resultado tem de ser o do
    // funil declarado, não o primeiro encontrado.
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Funil",
          trigger_type: "new_message_received",
          steps: [
            {
              step_type: "create_deal",
              step_config: { pipeline: "Funil Cível", stage: "Triagem", title: "Caso" },
            },
          ],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
    expect(automations[0].steps[0].step_config).toMatchObject({
      pipeline_id: "pipe-civel",
      stage_id: "stage-civel-triagem",
    });
  });

  it("does not report the stage when the pipeline itself failed", () => {
    const { issues } = parseImportDocument(
      doc([
        {
          name: "Funil",
          trigger_type: "new_message_received",
          steps: [
            {
              step_type: "create_deal",
              step_config: {
                pipeline: "Funil Inexistente",
                stage: "Triagem",
                title: "Caso",
              },
            },
          ],
        },
      ]),
      catalog,
    );
    const refIssues = issues.filter((i) => i.code === "unresolved_reference");
    expect(refIssues).toHaveLength(1);
    expect(refIssues[0].path).toContain(".pipeline");
  });

  it("reports a stage declared without a pipeline instead of dropping it", () => {
    // `deal_stage_changed` tem todos os campos opcionais, então uma
    // etapa sem funil não viraria erro de campo obrigatório — sumiria
    // em silêncio, e o filtro que a pessoa escreveu deixaria de valer.
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Orfa",
          trigger_type: "deal_stage_changed",
          trigger_config: { to_stage: "Triagem" },
          steps: [sendMessage()],
        },
      ]),
      catalog,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("automations[0].trigger_config.to_stage");
    expect(automations[0].trigger_config.to_stage_id).toBeUndefined();
  });

  it("stays quiet about the stage when a declared pipeline is the one at fault", () => {
    const { issues } = parseImportDocument(
      doc([
        {
          name: "Funil ruim",
          trigger_type: "deal_stalled",
          trigger_config: { pipeline: "Funil Inexistente", stage: "Triagem", days: 3 },
          steps: [sendMessage()],
        },
      ]),
      catalog,
    );
    // Só o funil é apontado como referência não resolvida; a etapa
    // não ganha um erro derivado do mesmo problema. (`validate.ts`
    // ainda cobra `stage_id` por conta própria, porque `deal_stalled`
    // não funciona sem etapa — esse é outro tipo de pendência.)
    const refIssues = issues.filter((i) => i.code === "unresolved_reference");
    expect(refIssues).toHaveLength(1);
    expect(refIssues[0].path).toContain(".pipeline");
  });

  it("resolves an agent by name or by email", () => {
    for (const ref of ["Ana Souza", "ana@escritorio.com"]) {
      const { automations, issues } = parseImportDocument(
        doc([
          {
            name: "Atribuir",
            trigger_type: "new_message_received",
            steps: [
              {
                step_type: "assign_conversation",
                step_config: { mode: "specific", agent: ref },
              },
            ],
          },
        ]),
        catalog,
      );
      expect(issues).toEqual([]);
      expect(automations[0].steps[0].step_config.agent_id).toBe("user-ana");
    }
  });

  it("does not require an agent in round_robin mode", () => {
    const { issues } = parseImportDocument(
      doc([
        {
          name: "Rodizio",
          trigger_type: "new_message_received",
          steps: [{ step_type: "assign_conversation", step_config: { mode: "round_robin" } }],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
  });

  it("resolves a custom field written by name", () => {
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Campo",
          trigger_type: "new_message_received",
          steps: [
            {
              step_type: "update_contact_field",
              step_config: { field: "custom:Número do Processo", value: "123" },
            },
          ],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
    expect(automations[0].steps[0].step_config.field).toBe("custom:cf-processo");
  });

  it("resolves the tag a tag_presence condition compares against", () => {
    // `operand` só é referência neste sujeito; nos outros é nome de
    // coluna, trecho de texto ou faixa de horário.
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Condicao",
          trigger_type: "new_message_received",
          steps: [
            {
              step_type: "condition",
              step_config: { subject: "tag_presence", tag: "Lead BPC" },
              branches: { yes: [sendMessage()], no: [] },
            },
          ],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
    expect(automations[0].steps[0].step_config.operand).toBe("tag-bpc");
  });

  it("resolves references inside condition branches", () => {
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Aninhado",
          trigger_type: "new_message_received",
          steps: [
            {
              step_type: "condition",
              step_config: { subject: "message_content", operand: "bpc" },
              branches: {
                yes: [{ step_type: "add_tag", step_config: { tag: "Lead BPC" } }],
                no: [],
              },
            },
          ],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
    expect(automations[0].steps[0].branches?.yes?.[0].step_config).toEqual({
      tag_id: "tag-bpc",
    });
  });
});

describe("parseImportDocument — segurança", () => {
  it("drops a caller-supplied step id", () => {
    // `insertSteps` usa `s.id ?? uid()`, então aceitar o campo
    // deixaria o arquivo escolher a chave primária da linha.
    const { automations } = parseImportDocument(
      doc([
        {
          name: "Enxerto",
          trigger_type: "new_message_received",
          steps: [{ id: "id-escolhido-pelo-arquivo", ...sendMessage() }],
        },
      ]),
      catalog,
    );
    expect(automations[0].steps[0].id).toBeUndefined();
  });

  it("defaults is_active to false but honours an explicit true", () => {
    const { automations } = parseImportDocument(
      doc([
        { name: "Padrao", trigger_type: "new_message_received", steps: [sendMessage()] },
        {
          name: "Ligada",
          trigger_type: "new_message_received",
          is_active: true,
          steps: [sendMessage()],
        },
      ]),
      catalog,
    );
    expect(automations[0].is_active).toBe(false);
    expect(automations[1].is_active).toBe(true);
  });

  it("flags duplicate names within the file", () => {
    const { issues } = parseImportDocument(
      doc([
        { name: "Mesma", trigger_type: "new_message_received", steps: [sendMessage()] },
        { name: "  mesma  ", trigger_type: "new_message_received", steps: [sendMessage()] },
      ]),
      catalog,
    );
    expect(issues.some((i) => i.message.includes("duplicate name"))).toBe(true);
  });

  it("applies the builder validation rules to drafts too", () => {
    const { issues } = parseImportDocument(
      doc([
        {
          name: "Incompleta",
          trigger_type: "keyword_match",
          trigger_config: { keywords: [] },
          is_active: false,
          steps: [{ step_type: "wait", step_config: { amount: -3, unit: "eras" } }],
        },
      ]),
      catalog,
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("automations[0].trigger.keywords");
    expect(paths).toContain("automations[0].steps[0].amount");
    expect(paths).toContain("automations[0].steps[0].unit");
  });
});

describe("parseImportDocument — ZapSign (migration 044)", () => {
  // O par `document_signed` / `send_signature_request` existia no motor
  // e em `validate.ts` desde a 044, mas ficou de fora das listas
  // fechadas deste módulo. O sintoma era um round-trip quebrado:
  // `export.ts` emitia a automação sem obstáculo e o import a recusava
  // como `unknown_type`.

  const signatureStep = (extra: Record<string, unknown> = {}) => ({
    step_type: "send_signature_request",
    step_config: {
      template_token: "tpl-contrato-bpc",
      document_name: "Contrato — {{ contact.name }}",
      send_via_whatsapp: true,
      message_text: "Seu contrato está pronto: {{signer_url}}",
      ...extra,
    },
  });

  it("imports the signature step", () => {
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Enviar contrato",
          trigger_type: "new_message_received",
          steps: [signatureStep()],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
    expect(automations[0].steps[0].step_type).toBe("send_signature_request");
  });

  it("imports the document_signed trigger", () => {
    const { automations, issues } = parseImportDocument(
      doc([
        {
          name: "Contrato assinado",
          trigger_type: "document_signed",
          trigger_config: { template_token: "tpl-contrato-bpc" },
          steps: [{ step_type: "add_tag", step_config: { tag: "Lead BPC" } }],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
    expect(automations[0].trigger_type).toBe("document_signed");
    // `template_token` é do ZapSign, não do catálogo da conta: passa
    // intacto, sem virar `*_id` nem exigir resolução.
    expect(automations[0].trigger_config.template_token).toBe("tpl-contrato-bpc");
  });

  it("accepts document_signed with no template filter", () => {
    // Mesma convenção de `practice_area_set`: filtro vazio = qualquer
    // modelo, então não há configuração inválida a barrar.
    const { issues } = parseImportDocument(
      doc([
        {
          name: "Qualquer assinatura",
          trigger_type: "document_signed",
          steps: [sendMessage()],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
  });

  it("applies the signature step's own rules to drafts", () => {
    // O motivo de o módulo existir: a rota só valida quando
    // `is_active` é verdadeiro, e um arquivo não passou por tela
    // nenhuma. Sem isto, um passo sem `template_token` seria gravado e
    // falharia em toda execução.
    const { issues } = parseImportDocument(
      doc([
        {
          name: "Incompleta",
          trigger_type: "new_message_received",
          is_active: false,
          steps: [
            {
              step_type: "send_signature_request",
              step_config: { send_via_whatsapp: true },
            },
          ],
        },
      ]),
      catalog,
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("automations[0].steps[0].template_token");
    expect(paths).toContain("automations[0].steps[0].document_name");
    // O texto vai para o WhatsApp do cliente: em branco, o passo
    // mandaria nada em vez de falhar na hora de salvar.
    expect(paths).toContain("automations[0].steps[0].message_text");
  });

  it("does not demand message_text when the link is not sent by WhatsApp", () => {
    const { issues } = parseImportDocument(
      doc([
        {
          name: "So gera o documento",
          trigger_type: "new_message_received",
          steps: [
            {
              step_type: "send_signature_request",
              step_config: {
                template_token: "tpl-procuracao",
                document_name: "Procuração",
                send_via_whatsapp: false,
              },
            },
          ],
        },
      ]),
      catalog,
    );
    expect(issues).toEqual([]);
  });
});

describe("checkWebhookUrls", () => {
  const withWebhook = (url: string) =>
    parseImportDocument(
      doc([
        {
          name: "Webhook",
          trigger_type: "new_message_received",
          steps: [{ step_type: "send_webhook", step_config: { url } }],
        },
      ]),
      catalog,
    ).automations;

  it("reports a URL the resolver considers internal", async () => {
    const issues = await checkWebhookUrls(
      withWebhook("http://169.254.169.254/latest/meta-data"),
      async () => false,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toContain("step_config.url");
  });

  it("passes a publicly routable URL", async () => {
    const issues = await checkWebhookUrls(
      withWebhook("https://hooks.exemplo.com.br/wacrm"),
      async () => true,
    );
    expect(issues).toEqual([]);
  });

  it("finds webhooks nested inside condition branches", async () => {
    const automations = parseImportDocument(
      doc([
        {
          name: "Aninhado",
          trigger_type: "new_message_received",
          steps: [
            {
              step_type: "condition",
              step_config: { subject: "message_content", operand: "x" },
              branches: {
                yes: [
                  { step_type: "send_webhook", step_config: { url: "http://127.0.0.1/x" } },
                ],
                no: [],
              },
            },
          ],
        },
      ]),
      catalog,
    ).automations;

    const issues = await checkWebhookUrls(automations, async () => false);
    expect(issues).toHaveLength(1);
  });
});
