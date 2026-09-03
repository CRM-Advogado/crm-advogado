import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_CATALOG,
  parseImportDocument,
  type ReferenceCatalog,
} from './import';

// ------------------------------------------------------------
// Os exemplos de `docs/exemplos/` são o primeiro contato de alguém
// com o formato. Um exemplo que não importa mais — porque um passo
// mudou de forma, ou uma regra ficou mais estrita — é pior que
// nenhum: manda a pessoa depurar o próprio arquivo atrás de um erro
// que é nosso. Estes testes quebram o CI antes disso chegar na mão
// de quem for usar.
// ------------------------------------------------------------

function loadExample(name: string): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'docs', 'exemplos', name), 'utf-8')
  );
}

describe('docs/exemplos/01-basico-sem-referencias.json', () => {
  it('imports cleanly against an account with nothing registered', () => {
    // Com o catálogo VAZIO de propósito: é o que garante que o
    // arquivo funciona em qualquer conta, sem depender de existir
    // uma tag ou um funil com determinado nome.
    const { automations, issues } = parseImportDocument(
      loadExample('01-basico-sem-referencias.json'),
      EMPTY_CATALOG
    );
    expect(issues).toEqual([]);
    expect(automations).toHaveLength(4);
    // Nenhuma entra ligada — importar automação ativa dispara
    // mensagem real no WhatsApp de quem escrever para o escritório.
    expect(automations.every((a) => !a.is_active)).toBe(true);
  });
});

describe('docs/exemplos/02-com-referencias.json', () => {
  it('is structurally sound — only the placeholder names fail', () => {
    const { issues } = parseImportDocument(
      loadExample('02-com-referencias.json'),
      EMPTY_CATALOG
    );
    // Todo erro tem de ser de referência. Qualquer outro código
    // significa que o exemplo tem um defeito de forma que a pessoa
    // vai herdar ao copiá-lo.
    expect(issues.every((i) => i.code === 'unresolved_reference')).toBe(true);
    // Quatro erros para quatro placeholders distintos, sem eco:
    // tag e funil no primeiro exemplo, agente no segundo, tag no
    // terceiro. A ETAPA do primeiro não aparece — quando o funil
    // não resolve, apontar a etapa dentro dele seria ruído derivado.
    expect(issues).toHaveLength(4);
  });

  it('imports cleanly once the placeholders name real entries', () => {
    const catalog: ReferenceCatalog = {
      tags: [{ id: 'tag-1', name: 'TROQUE PELO NOME DE UMA TAG SUA' }],
      pipelines: [{ id: 'pipe-1', name: 'TROQUE PELO NOME DE UM FUNIL SEU' }],
      stages: [
        {
          id: 'stage-1',
          name: 'TROQUE PELO NOME DE UMA ETAPA DESSE FUNIL',
          pipeline_id: 'pipe-1',
        },
      ],
      agents: [
        { id: 'user-1', name: 'TROQUE PELO SEU E-MAIL OU NOME COMPLETO' },
      ],
      customFields: [],
    };

    const { automations, issues } = parseImportDocument(
      loadExample('02-com-referencias.json'),
      catalog
    );
    expect(issues).toEqual([]);
    expect(automations).toHaveLength(3);
  });
});

describe('docs/exemplos/03-erros-esperados.json', () => {
  it('triggers every issue code the preview can show', () => {
    const { issues } = parseImportDocument(
      loadExample('03-erros-esperados.json'),
      EMPTY_CATALOG
    );
    const codes = new Set(issues.map((i) => i.code));

    // `invalid_config` de SSRF vem de `checkWebhookUrls`, que é
    // assíncrono e roda na rota — por isso não aparece aqui.
    expect(codes).toContain('unknown_type');
    expect(codes).toContain('invalid_config');
    expect(codes).toContain('unresolved_reference');
    expect(codes).toContain('invalid_document');
  });

  it('names every problem with a path the reader can find in the file', () => {
    const { issues } = parseImportDocument(
      loadExample('03-erros-esperados.json'),
      EMPTY_CATALOG
    );
    expect(issues.every((i) => i.path.startsWith('automations['))).toBe(true);
  });
});
