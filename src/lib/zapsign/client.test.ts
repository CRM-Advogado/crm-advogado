import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachExtraDocumentFromTemplate,
  createDocumentFromTemplate,
  getSignedFileUrl,
  listTemplates,
  ZapsignApiError,
  ZapsignTransportError,
} from './client';

const CREDS = { apiToken: 'test-token', sandbox: false };

describe('createDocumentFromTemplate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the production host with the expected body shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 'doc-token',
          open_id: 5,
          status: 'pending',
          name: 'Contrato',
          signers: [
            {
              token: 's1',
              sign_url: 'https://app.zapsign.com.br/verificar/s1',
              status: 'new',
              name: 'Lead',
            },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const doc = await createDocumentFromTemplate({
      ...CREDS,
      templateToken: 'template-1',
      documentName: 'Contrato',
      signer: {
        name: 'Lead',
        email: 'lead@example.com',
        phoneCountry: '55',
        phoneNumber: '11999999999',
      },
      variables: { NOME: 'Lead' },
    });

    expect(doc.token).toBe('doc-token');
    expect(doc.signers[0].sign_url).toContain('/verificar/s1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.zapsign.com.br/api/v1/models/create-doc/');
    expect(init.headers.authorization).toBe('Bearer test-token');
    const body = JSON.parse(init.body as string);
    expect(body.template_id).toBe('template-1');
    expect(body.signer_name).toBe('Lead');
    expect(body.signer_phone_country).toBe('55');
    expect(body.send_automatic_email).toBe(false);
    expect(body.data).toEqual([{ de: 'NOME', para: 'Lead' }]);
  });

  it('omits signer_has_incomplete_fields unless the step asks for it', async () => {
    // Omitir mantém o comportamento anterior: uma automação já
    // configurada não pode mudar de rota por causa de um campo novo
    // que ninguém marcou.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 't',
          open_id: 1,
          status: 'pending',
          name: 'x',
          signers: [],
        }),
        {
          status: 200,
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await createDocumentFromTemplate({
      ...CREDS,
      templateToken: 'template-1',
      documentName: 'Contrato',
      signer: { name: 'Lead' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.signer_has_incomplete_fields).toBeUndefined();
  });

  it('sends signer_has_incomplete_fields when the step asks for the form', async () => {
    // É o que leva o cliente ao formulário do modelo antes de assinar,
    // e o que dispensa um formulário externo para colher CPF e endereço.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 't',
          open_id: 1,
          status: 'pending',
          name: 'x',
          signers: [],
        }),
        {
          status: 200,
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await createDocumentFromTemplate({
      ...CREDS,
      templateToken: 'template-1',
      documentName: 'Contrato',
      signer: { name: 'Lead' },
      variables: { NOME: 'Lead' },
      signerHasIncompleteFields: true,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.signer_has_incomplete_fields).toBe(true);
    // O que já foi enviado continua indo: o formulário completa, não substitui.
    expect(body.data).toEqual([{ de: 'NOME', para: 'Lead' }]);
  });

  // `data` é obrigatório neste endpoint mesmo sem variável nenhuma.
  // Omiti-lo devolvia 400 — justamente na configuração recomendada, em
  // que o signatário preenche tudo pelo formulário do ZapSign.
  it('always sends data, as an empty array when there are no variables', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 't',
          open_id: 1,
          status: 'pending',
          name: 'x',
          signers: [],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await createDocumentFromTemplate({
      ...CREDS,
      templateToken: 'template-1',
      documentName: 'Contrato',
      signer: { name: 'Lead' },
      signerHasIncompleteFields: true,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.data).toEqual([]);
  });

  it('uses the sandbox host when sandbox is true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 't',
          open_id: 1,
          status: 'pending',
          name: 'x',
          signers: [],
        }),
        {
          status: 200,
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await createDocumentFromTemplate({
      apiToken: 'sandbox-token',
      sandbox: true,
      templateToken: 'template-1',
      documentName: 'Contrato',
      signer: { name: 'Lead' },
    });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://sandbox.api.zapsign.com.br/api/v1/models/create-doc/'
    );
  });

  it('throws ZapsignApiError with the response body on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"error":"invalid token"}', { status: 401 })
        )
    );

    await expect(
      createDocumentFromTemplate({
        ...CREDS,
        templateToken: 'template-1',
        documentName: 'Contrato',
        signer: { name: 'Lead' },
      })
    ).rejects.toThrow(ZapsignApiError);
  });
});

describe('listTemplates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps a paginated {results: [...]} response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            count: 1,
            results: [{ token: 't1', name: 'Contrato', active: true }],
          }),
          { status: 200 }
        )
      )
    );

    const templates = await listTemplates(CREDS);
    expect(templates).toEqual([
      { token: 't1', name: 'Contrato', active: true },
    ]);
  });

  // Ler só a primeira página escondia os modelos de uma conta grande —
  // e um modelo que não aparece no seletor é um modelo que a automação
  // não consegue usar.
  it('follows the `next` link across pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            count: 2,
            next: 'https://api.zapsign.com.br/api/v1/templates/?page=2',
            results: [{ token: 't1', name: 'Contrato', active: true }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            count: 2,
            next: null,
            results: [{ token: 't2', name: 'Procuração', active: true }],
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const templates = await listTemplates(CREDS);
    expect(templates.map((t) => t.token)).toEqual(['t1', 't2']);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.zapsign.com.br/api/v1/templates/?page=2'
    );
  });

  // O corpo da resposta é dado de fora: seguir um `next` para outro host
  // mandaria o cabeçalho de autorização para onde o payload mandasse.
  it('refuses to follow a `next` pointing at another host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          count: 1,
          next: 'https://attacker.example.com/api/v1/templates/?page=2',
          results: [{ token: 't1', name: 'Contrato', active: true }],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const templates = await listTemplates(CREDS);
    expect(templates).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('external_id', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // É a chave reserva do webhook quando a resposta da criação se perde.
  it('travels in the create body when the caller supplies it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 't',
          open_id: 1,
          status: 'pending',
          name: 'x',
          signers: [],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await createDocumentFromTemplate({
      ...CREDS,
      externalId: '0f4f4b6e-2a11-4a4a-9f6e-1c2d3e4f5a6b',
      templateToken: 'template-1',
      documentName: 'Contrato',
      signer: { name: 'Lead' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.external_id).toBe('0f4f4b6e-2a11-4a4a-9f6e-1c2d3e4f5a6b');
  });

  it('is omitted when the caller does not supply it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 't',
          open_id: 1,
          status: 'pending',
          name: 'x',
          signers: [],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await createDocumentFromTemplate({
      ...CREDS,
      templateToken: 'template-1',
      documentName: 'Contrato',
      signer: { name: 'Lead' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('external_id');
  });
});

describe('getSignedFileUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads signed_file from the document detail endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ token: 'doc-1', signed_file: 'https://s3/x.pdf' }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSignedFileUrl(CREDS, 'doc-1')).resolves.toBe(
      'https://s3/x.pdf'
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.zapsign.com.br/api/v1/docs/doc-1/'
    );
  });

  // Estado normal de um documento pendente — não é erro.
  it('returns null while the document has no signed file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token: 'doc-1', signed_file: null }), {
          status: 200,
        })
      )
    );

    await expect(getSignedFileUrl(CREDS, 'doc-1')).resolves.toBeNull();
  });
});

describe('falha de transporte', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Distinta de ZapsignApiError: sem resposta, não dá para afirmar que o
  // ZapSign não processou o documento — quem chama precisa poder dizer
  // isso no log.
  it('wraps a timeout in ZapsignTransportError', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));

    await expect(
      createDocumentFromTemplate({
        ...CREDS,
        templateToken: 'template-1',
        documentName: 'Contrato',
        signer: { name: 'Lead' },
      })
    ).rejects.toThrow(ZapsignTransportError);
  });

  it('wraps a connection failure in ZapsignTransportError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    );

    await expect(listTemplates(CREDS)).rejects.toThrow(ZapsignTransportError);
  });
});

describe('attachExtraDocumentFromTemplate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the extra-doc path of the PARENT document, not of a template', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ token: 'extra-token', name: 'Procuracao' }), {
          status: 200,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const anexo = await attachExtraDocumentFromTemplate({
      ...CREDS,
      documentToken: 'doc-token',
      templateToken: 'template-procuracao',
      variables: { CPF: '123.456.789-00' },
    });

    expect(anexo.token).toBe('extra-token');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.zapsign.com.br/api/v1/models/doc-token/upload-extra-doc/'
    );
    const body = JSON.parse(init.body as string);
    // Modelo e variaveis, e nada mais: signatario, external_id, idioma e
    // configuracao de envio sao herdados do documento principal. Mandar
    // signatario aqui seria pedir uma segunda assinatura no mesmo envelope.
    expect(Object.keys(body).sort()).toEqual(['data', 'template_id']);
    expect(body.template_id).toBe('template-procuracao');
    expect(body.data).toEqual([{ de: 'CPF', para: '123.456.789-00' }]);
  });

  it('still sends data when there are no variables', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ token: 't', name: 'n' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await attachExtraDocumentFromTemplate({
      ...CREDS,
      documentToken: 'doc-token',
      templateToken: 'tpl',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Mesmo motivo de create-doc: omitir `data` devolvia 400 la, e o
    // modelo cujo formulario o proprio signatario preenche nao tem
    // variavel nenhuma para mandar.
    expect(body).toHaveProperty('data');
    expect(body.data).toEqual([]);
  });

  it('escapes the document token in the path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ token: 't', name: 'n' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await attachExtraDocumentFromTemplate({
      ...CREDS,
      documentToken: 'a/b',
      templateToken: 'tpl',
    });

    expect(fetchMock.mock.calls[0][0]).toContain('/models/a%2Fb/upload-extra-doc/');
  });

  it('surfaces the ZapSign refusal as ZapsignApiError with the body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{"message":"documento pai assinado"}', { status: 400 })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      attachExtraDocumentFromTemplate({
        ...CREDS,
        documentToken: 'doc-token',
        templateToken: 'tpl',
      })
    ).rejects.toBeInstanceOf(ZapsignApiError);
  });

  it('uses the sandbox host when the credential says so', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ token: 't', name: 'n' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await attachExtraDocumentFromTemplate({
      apiToken: 'sandbox-token',
      sandbox: true,
      documentToken: 'doc-token',
      templateToken: 'tpl',
    });

    expect(fetchMock.mock.calls[0][0]).toContain('sandbox.api.zapsign.com.br');
  });
});
