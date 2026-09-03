// ============================================================
// ZapSign API client — pure HTTP wrapper, no Supabase.
//
// Two environments, confirmed against the official docs
// (docs.zapsign.com.br) rather than assumed: sandbox and production are
// DIFFERENT HOSTS with DIFFERENT TOKENS — there is no `sandbox: true`
// body flag like some providers use. `sandbox` on the stored credential
// (migration 044) picks the base URL below; the token itself already
// only works against its own host.
// ============================================================

const PROD_BASE_URL = 'https://api.zapsign.com.br/api/v1';
const SANDBOX_BASE_URL = 'https://sandbox.api.zapsign.com.br/api/v1';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Teto de anexos por envelope, imposto pelo ZapSign: 15 documentos no
 * total, sendo 1 principal e ate 14 extras. Vive aqui, com o resto do
 * conhecimento da API, para que `validate.ts` cobre o mesmo numero que o
 * cliente respeita.
 */
export const MAX_EXTRA_DOCS = 14;

export interface ZapsignCredentials {
  apiToken: string;
  sandbox: boolean;
}

export class ZapsignApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = 'ZapsignApiError';
  }
}

/**
 * A requisição não chegou a virar resposta — timeout, DNS, conexão
 * cortada. Distinta de `ZapsignApiError` porque a consequência é outra:
 * com um status HTTP sabemos que o ZapSign decidiu; sem resposta, uma
 * criação de documento pode ter sido processada do outro lado mesmo
 * assim. Quem chama precisa poder dizer isso no log, em vez de afirmar
 * que nada aconteceu.
 */
export class ZapsignTransportError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ZapsignTransportError';
  }
}

export interface ZapsignTemplate {
  token: string;
  name: string;
  active: boolean;
}

export interface CreateDocumentFromTemplateArgs extends ZapsignCredentials {
  templateToken: string;
  documentName: string;
  signer: {
    name: string;
    email?: string;
    /** DDI digits only, e.g. "55". */
    phoneCountry?: string;
    /** Local number digits only, no DDI. */
    phoneNumber?: string;
  };
  /**
   * Nosso identificador da linha em `zapsign_documents`, gravada ANTES
   * desta chamada. O ZapSign guarda e devolve no corpo do webhook, o que
   * dá uma segunda chave para casar o aviso quando a resposta da criação
   * se perde (timeout, conexão cortada). Ver migration 044.
   */
  externalId?: string;
  /** Template variable name -> value, mirrors ZapSign's `{de, para}` pairs. */
  variables?: Record<string, string>;
  /**
   * Leva o signatário ao formulário do modelo antes da assinatura para
   * preencher os campos que `variables` não trouxe. O que veio em
   * `data` chega pré-preenchido e não é redigitado.
   */
  signerHasIncompleteFields?: boolean;
}

export interface ZapsignSigner {
  token: string;
  sign_url: string;
  status: string;
  name: string;
}

export interface CreatedZapsignDocument {
  token: string;
  open_id: number;
  status: string;
  name: string;
  signers: ZapsignSigner[];
}

function baseUrl(sandbox: boolean): string {
  return sandbox ? SANDBOX_BASE_URL : PROD_BASE_URL;
}

async function zapsignFetch(
  creds: ZapsignCredentials,
  path: string,
  init: RequestInit
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(creds.sandbox)}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${creds.apiToken}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ZapsignTransportError(
      timedOut
        ? `ZapSign did not answer within ${REQUEST_TIMEOUT_MS}ms`
        : 'Could not reach ZapSign',
      err
    );
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new ZapsignApiError(
      `ZapSign API returned ${res.status}`,
      res.status,
      raw
    );
  }
  return raw ? JSON.parse(raw) : null;
}

/**
 * POST /models/create-doc/ — creates a document for signature from an
 * existing ZapSign template. `data` carries the `{{VAR}} -> value`
 * substitutions the docs call `de`/`para`. `send_automatic_email: false`
 * because the account chose to deliver the sign link itself over
 * WhatsApp rather than let ZapSign email/WhatsApp it.
 */
export async function createDocumentFromTemplate(
  args: CreateDocumentFromTemplateArgs
): Promise<CreatedZapsignDocument> {
  const body: Record<string, unknown> = {
    template_id: args.templateToken,
    name: args.documentName,
    signer_name: args.signer.name,
    send_automatic_email: false,
  };
  if (args.externalId) body.external_id = args.externalId;
  if (args.signer.email) body.signer_email = args.signer.email;
  if (args.signer.phoneCountry)
    body.signer_phone_country = args.signer.phoneCountry;
  if (args.signer.phoneNumber)
    body.signer_phone_number = args.signer.phoneNumber;
  // `data` é OBRIGATÓRIO neste endpoint, mesmo sem nenhuma variável a
  // preencher. Omiti-lo quando o passo não trazia variáveis devolvia
  // 400 — e é justamente a configuração recomendada para modelos em que
  // o próprio signatário preenche tudo pelo formulário do ZapSign
  // (`signer_has_incomplete_fields`). Array vazio satisfaz o campo sem
  // pré-preencher nada.
  body.data = Object.entries(args.variables ?? {}).map(([de, para]) => ({
    de,
    para,
  }));
  // Só enviado quando o passo pede. Omitir mantém o comportamento
  // anterior — automações já configuradas não mudam de rota por causa
  // de um campo que ninguém marcou.
  if (args.signerHasIncompleteFields) body.signer_has_incomplete_fields = true;

  const json = await zapsignFetch(args, '/models/create-doc/', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return json as CreatedZapsignDocument;
}

export interface AttachExtraDocumentArgs extends ZapsignCredentials {
  /** Token do DOCUMENTO principal ja criado — nao do modelo dele. */
  documentToken: string;
  /** Modelo do ZapSign que gera o anexo. */
  templateToken: string;
  /** Mesmo formato de `variables` de createDocumentFromTemplate. */
  variables?: Record<string, string>;
}

/**
 * POST /models/{doc_token}/upload-extra-doc/ — anexa um documento gerado
 * de OUTRO modelo ao MESMO envelope do documento principal. O signatario
 * abre um link so e assina os dois de uma vez.
 *
 * O corpo leva apenas modelo e variaveis: signatario, `external_id`,
 * idioma e configuracao de envio sao HERDADOS do documento principal.
 * `data` vai sempre, como em create-doc, porque la a omissao devolvia 400
 * e nao ha motivo para apostar que aqui seria diferente.
 *
 * Limites da plataforma que o chamador precisa respeitar:
 *
 * - ate 14 anexos por envelope, um por chamada;
 * - cada anexo consome um credito igual ao de um documento principal —
 *   juntar os dois num envelope melhora a experiencia do signatario, nao
 *   o custo;
 * - anexo NAO pode ser removido depois de adicionado, o que torna
 *   retentativa perigosa: uma segunda chamada que der certo depois de uma
 *   primeira parcialmente aceita deixa o envelope com o documento
 *   duplicado e sem desfazer;
 * - responde 400 se o documento principal JA foi assinado, entao o anexo
 *   precisa acontecer antes de o link chegar ao signatario.
 */
export async function attachExtraDocumentFromTemplate(
  args: AttachExtraDocumentArgs
): Promise<{ token: string; name: string }> {
  const json = await zapsignFetch(
    args,
    `/models/${encodeURIComponent(args.documentToken)}/upload-extra-doc/`,
    {
      method: 'POST',
      body: JSON.stringify({
        template_id: args.templateToken,
        data: Object.entries(args.variables ?? {}).map(([de, para]) => ({
          de,
          para,
        })),
      }),
    }
  );
  return json as { token: string; name: string };
}
/**
 * GET /docs/{token}/ — busca o documento para pegar o link do PDF
 * assinado.
 *
 * O link NÃO é guardado no banco de propósito: a própria ZapSign
 * documenta que `original_file` e `signed_file` são temporários e duram
 * **60 minutos** (confirmado num payload real: o `Expires` da URL batia
 * exatamente uma hora depois de emitido). Guardar seria guardar um link
 * morto — o certo é pedir um novo no instante em que alguém clica em
 * baixar.
 *
 * Devolve `null` quando o documento existe mas ainda não tem arquivo
 * assinado, que é o estado normal de um documento pendente.
 */
export async function getSignedFileUrl(
  creds: ZapsignCredentials,
  documentToken: string
): Promise<string | null> {
  const json = (await zapsignFetch(
    creds,
    `/docs/${encodeURIComponent(documentToken)}/`,
    { method: 'GET' }
  )) as { signed_file?: unknown } | null;

  const url = json?.signed_file;
  return typeof url === 'string' && url ? url : null;
}

/**
 * Teto de páginas seguidas por `listTemplates`. Existe para que uma
 * resposta com `next` apontando em círculo não vire laço infinito
 * dentro de um passo de automação; 10 páginas cobrem qualquer conta
 * real com folga.
 */
const MAX_TEMPLATE_PAGES = 10;

/**
 * Só seguimos o `next` se ele apontar para o MESMO host que já estamos
 * falando. O corpo da resposta é dado de fora: um `next` apontando para
 * outro endereço faria o servidor buscar onde o ZapSign mandasse, com o
 * cabeçalho de autorização junto. Mesmo raciocínio do guard de SSRF em
 * `lib/webhooks/ssrf.ts`.
 */
function nextPagePath(next: unknown, sandbox: boolean): string | null {
  if (typeof next !== 'string' || !next) return null;
  try {
    const url = new URL(next);
    const base = new URL(baseUrl(sandbox));
    if (url.origin !== base.origin) return null;
    if (!url.pathname.startsWith(base.pathname)) return null;
    return `${url.pathname.slice(base.pathname.length)}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * GET /templates/ — used both to validate a freshly-entered API token
 * before saving it (POST /api/zapsign/config) and to feed the template
 * picker in the automation step editor.
 *
 * A resposta é paginada (`{count, next, previous, results}`). Ler só a
 * primeira página fazia o seletor do builder esconder os modelos de uma
 * conta grande — e um modelo que não aparece no seletor é um modelo que
 * a automação não consegue usar.
 */
export async function listTemplates(
  creds: ZapsignCredentials
): Promise<ZapsignTemplate[]> {
  const all: ZapsignTemplate[] = [];
  let path: string | null = '/templates/';

  for (let page = 0; path !== null && page < MAX_TEMPLATE_PAGES; page++) {
    const json = (await zapsignFetch(creds, path, { method: 'GET' })) as
      | { results?: ZapsignTemplate[]; next?: unknown }
      | ZapsignTemplate[]
      | null;

    // Resposta sem envelope de paginação: é a lista inteira.
    if (Array.isArray(json)) {
      all.push(...json);
      break;
    }
    all.push(...(json?.results ?? []));
    path = nextPagePath(json?.next, creds.sandbox);
  }

  return all;
}
