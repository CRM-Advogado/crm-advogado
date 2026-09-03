import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getZapsignCredentials } from '@/lib/zapsign/credentials';
import { getSignedFileUrl, ZapsignApiError } from '@/lib/zapsign/client';

/**
 * GET /api/zapsign/documents/[id]/signed-file  (agent+)
 *
 * Devolve um link fresco para o PDF assinado.
 *
 * Por que buscar na hora em vez de guardar: a ZapSign documenta que os
 * links de `original_file` e `signed_file` **duram 60 minutos** — e um
 * payload real do sandbox confirmou (o `Expires` da URL batia exatamente
 * uma hora depois de emitida). Guardar a URL no banco seria guardar um
 * link morto; o único jeito de entregar algo que funcione é pedir um
 * novo no instante do clique.
 *
 * O link vai para o cliente em vez de o PDF passar por aqui: são
 * arquivos grandes, e intermediá-los gastaria banda e tempo de função
 * sem nada em troca — a URL já é secreta e expira sozinha.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id } = await params;

    const limit = checkRateLimit(
      `zapsign-signed-file:${userId}`,
      RATE_LIMITS.zapsignTemplates
    );
    if (!limit.success) return rateLimitResponse(limit);

    // Escopado por conta mesmo sob RLS: a política de SELECT já bastaria,
    // mas o filtro explícito é a convenção do projeto e sobrevive a uma
    // troca futura de cliente.
    const { data: doc, error } = await supabase
      .from('zapsign_documents')
      .select('zapsign_token, status')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[zapsign/signed-file] lookup failed:', error);
      return NextResponse.json(
        { error: 'Failed to load the document' },
        { status: 500 }
      );
    }
    if (!doc) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 }
      );
    }
    // Sem token é um documento cuja criação ficou em dúvida — não há o
    // que buscar no ZapSign porque não sabemos qual documento é.
    if (!doc.zapsign_token) {
      return NextResponse.json(
        { error: 'This document was never confirmed by ZapSign' },
        { status: 409 }
      );
    }

    const creds = await getZapsignCredentials(supabase, accountId);
    if (!creds) {
      return NextResponse.json(
        { error: 'ZapSign is not configured' },
        { status: 409 }
      );
    }

    let url: string | null;
    try {
      url = await getSignedFileUrl(creds, doc.zapsign_token as string);
    } catch (err) {
      if (err instanceof ZapsignApiError) {
        console.error('[zapsign/signed-file] ZapSign error:', err.status);
        return NextResponse.json(
          { error: `ZapSign refused the request (${err.status})` },
          { status: 502 }
        );
      }
      console.error('[zapsign/signed-file] transport error:', err);
      return NextResponse.json(
        { error: 'Could not reach ZapSign' },
        { status: 502 }
      );
    }

    if (!url) {
      return NextResponse.json(
        { error: 'This document has no signed file yet' },
        { status: 409 }
      );
    }

    return NextResponse.json({ url });
  } catch (err) {
    return toErrorResponse(err);
  }
}
