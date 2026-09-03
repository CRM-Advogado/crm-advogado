import { describe, expect, it } from "vitest";
import { buildExportDocument, type ExportableAutomation } from "./export";
import { parseImportDocument, type ReferenceCatalog } from "./import";
import type { BuilderStepNode } from "./steps-tree";

const catalog: ReferenceCatalog = {
  tags: [
    { id: "tag-bpc", name: "Lead BPC" },
    // Duas tags homônimas: o export não pode emitir este nome, senão
    // produz um arquivo que o próprio import recusa.
    { id: "tag-dup-a", name: "Lead" },
    { id: "tag-dup-b", name: "Lead" },
  ],
  pipelines: [{ id: "pipe-bpc", name: "Funil BPC" }],
  stages: [{ id: "stage-triagem", name: "Triagem", pipeline_id: "pipe-bpc" }],
  agents: [
    { id: "user-ana", name: "Ana Souza" },
    { id: "user-ana", name: "ana@escritorio.com" },
  ],
  customFields: [{ id: "cf-processo", name: "Número do Processo" }],
};

const FIXED_NOW = new Date("2026-01-15T10:30:00.000Z");

function node(
  step_type: string,
  step_config: Record<string, unknown>,
  branches?: { yes: BuilderStepNode[]; no: BuilderStepNode[] },
): BuilderStepNode {
  return {
    id: `step-${step_type}`,
    step_type,
    step_config,
    branches: branches ?? { yes: [], no: [] },
  };
}

function automation(
  steps: BuilderStepNode[],
  overrides: Partial<ExportableAutomation> = {},
): ExportableAutomation {
  return {
    name: "Triagem BPC",
    description: null,
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: false,
    steps,
    ...overrides,
  };
}

describe("buildExportDocument", () => {
  it("stamps the format version and the export time", () => {
    const doc = buildExportDocument([automation([])], catalog, FIXED_NOW);
    expect(doc.version).toBe(1);
    expect(doc.exported_at).toBe("2026-01-15T10:30:00.000Z");
  });

  it("turns a tag id into its name", () => {
    const doc = buildExportDocument(
      [automation([node("add_tag", { tag_id: "tag-bpc" })])],
      catalog,
      FIXED_NOW,
    );
    expect(doc.automations[0].steps[0].step_config).toEqual({ tag: "Lead BPC" });
  });

  it("keeps the raw id when the name would be ambiguous", () => {
    // Emitir "Lead" geraria um arquivo que volta com
    // `ambiguous_reference` — um round-trip quebrado pelo produtor.
    const doc = buildExportDocument(
      [automation([node("add_tag", { tag_id: "tag-dup-a" })])],
      catalog,
      FIXED_NOW,
    );
    expect(doc.automations[0].steps[0].step_config).toEqual({ tag_id: "tag-dup-a" });
  });

  it("keeps an id the catalog does not know", () => {
    const doc = buildExportDocument(
      [automation([node("add_tag", { tag_id: "tag-apagada" })])],
      catalog,
      FIXED_NOW,
    );
    expect(doc.automations[0].steps[0].step_config).toEqual({ tag_id: "tag-apagada" });
  });

  it("names the stage and the pipeline together", () => {
    const doc = buildExportDocument(
      [
        automation([
          node("create_deal", {
            pipeline_id: "pipe-bpc",
            stage_id: "stage-triagem",
            title: "Caso",
          }),
        ]),
      ],
      catalog,
      FIXED_NOW,
    );
    expect(doc.automations[0].steps[0].step_config).toEqual({
      pipeline: "Funil BPC",
      stage: "Triagem",
      title: "Caso",
    });
  });

  it("names the custom field behind the custom: prefix", () => {
    const doc = buildExportDocument(
      [
        automation([
          node("update_contact_field", { field: "custom:cf-processo", value: "1" }),
        ]),
      ],
      catalog,
      FIXED_NOW,
    );
    expect(doc.automations[0].steps[0].step_config.field).toBe("custom:Número do Processo");
  });

  it("names the tag a tag_presence condition compares against", () => {
    const doc = buildExportDocument(
      [
        automation([
          node(
            "condition",
            { subject: "tag_presence", operand: "tag-bpc" },
            { yes: [node("send_message", { text: "oi" })], no: [] },
          ),
        ]),
      ],
      catalog,
      FIXED_NOW,
    );
    expect(doc.automations[0].steps[0].step_config).toEqual({
      subject: "tag_presence",
      tag: "Lead BPC",
    });
  });

  it("omits empty branches so the file stays readable", () => {
    const doc = buildExportDocument(
      [automation([node("send_message", { text: "oi" })])],
      catalog,
      FIXED_NOW,
    );
    expect(doc.automations[0].steps[0].branches).toBeUndefined();
  });

  it("omits a null description", () => {
    const doc = buildExportDocument([automation([])], catalog, FIXED_NOW);
    expect(doc.automations[0]).not.toHaveProperty("description");
  });
});

describe("round-trip export → import", () => {
  it("returns the same ids it started from", () => {
    // A garantia que justifica ter feito os dois juntos: o que o
    // builder produz, o export escreve legível, e o import reconstrói
    // idêntico. Sem isso o formato seria só um schema documentado.
    const original: BuilderStepNode[] = [
      node("add_tag", { tag_id: "tag-bpc" }),
      node("create_deal", {
        pipeline_id: "pipe-bpc",
        stage_id: "stage-triagem",
        title: "Caso novo",
      }),
      node("assign_conversation", { mode: "specific", agent_id: "user-ana" }),
      node("update_contact_field", {
        field: "custom:cf-processo",
        value: "{{ message.text }}",
      }),
      node(
        "condition",
        { subject: "tag_presence", operand: "tag-bpc" },
        {
          yes: [node("send_message", { text: "já é cliente" })],
          no: [node("send_message", { text: "vamos triar" })],
        },
      ),
    ];

    const doc = buildExportDocument(
      [automation(original, { name: "Ida e volta", is_active: true })],
      catalog,
      FIXED_NOW,
    );

    const { automations, issues } = parseImportDocument(doc, catalog);
    expect(issues).toEqual([]);

    const steps = automations[0].steps;
    expect(steps[0].step_config).toEqual({ tag_id: "tag-bpc" });
    expect(steps[1].step_config).toEqual({
      pipeline_id: "pipe-bpc",
      stage_id: "stage-triagem",
      title: "Caso novo",
    });
    expect(steps[2].step_config).toEqual({ mode: "specific", agent_id: "user-ana" });
    expect(steps[3].step_config).toEqual({
      field: "custom:cf-processo",
      value: "{{ message.text }}",
    });
    expect(steps[4].step_config).toEqual({ subject: "tag_presence", operand: "tag-bpc" });
    expect(steps[4].branches?.yes?.[0].step_config).toEqual({ text: "já é cliente" });
    expect(steps[4].branches?.no?.[0].step_config).toEqual({ text: "vamos triar" });
    expect(automations[0].is_active).toBe(true);
  });

  it("survives a round trip even when a name was ambiguous", () => {
    const doc = buildExportDocument(
      [automation([node("add_tag", { tag_id: "tag-dup-b" })], { name: "Ambigua" })],
      catalog,
      FIXED_NOW,
    );
    const { automations, issues } = parseImportDocument(doc, catalog);
    expect(issues).toEqual([]);
    expect(automations[0].steps[0].step_config).toEqual({ tag_id: "tag-dup-b" });
  });
});
