import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  requireRole,
  UnauthorizedError,
  ForbiddenError,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import { readSignupInput } from '@/lib/whatsapp/embedded-signup';
import {
  activateSignup,
  exchangeSignupCode,
  getSignupConfig,
  SignupError,
  verifySignupAssets,
} from '@/lib/whatsapp/embedded-signup-server';

const COOKIE = 'whatsapp_signup_state';
const PATH = '/api/whatsapp/embedded-signup';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function failure(error: unknown) {
  if (
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError ||
    error instanceof SignupError
  ) {
    return json({ error: error.message }, error.status);
  }
  // Avoid logging error objects from OAuth, DB writes or encryption.
  return json(
    {
      error: 'Não foi possível concluir a conexão. Reinicie e tente novamente.',
    },
    500
  );
}

function requireOrigin(request: Request) {
  const url = new URL(request.url);
  if (request.headers.get('origin') !== url.origin)
    throw new SignupError('Origem inválida.', 403);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
    throw new SignupError('A conexão exige HTTPS.', 403);
}

function configured() {
  const config = getSignupConfig();
  if (!config)
    throw new SignupError(
      'A conexão guiada ainda não está disponível. Contate o suporte.',
      503
    );
  return config;
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const config = getSignupConfig();
    const { data, error } = await ctx.supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) throw new Error('config lookup failed');
    return json({
      available: Boolean(config),
      connected: Boolean(data),
      ...(config
        ? {
            appId: config.appId,
            configId: config.configId,
            version: config.version,
          }
        : {}),
    });
  } catch (error) {
    return failure(error);
  }
}

/** Begin a persistent, one-use session bound to the admin and their current account. */
export async function POST(request: NextRequest) {
  try {
    requireOrigin(request);
    const ctx = await requireRole('admin');
    configured();
    const state = randomBytes(32).toString('hex');
    const { error } = await supabaseAdmin().rpc('begin_whatsapp_signup', {
      p_account: ctx.accountId,
      p_user: ctx.userId,
      p_hash: hash(state),
    });
    if (error) {
      if (error.message?.includes('signup_busy'))
        throw new SignupError(
          'Já existe uma tentativa em andamento. Aguarde um minuto para tentar novamente.',
          409
        );
      if (error.message?.includes('signup_already_connected'))
        throw new SignupError(
          'Este escritório já possui uma conexão WhatsApp.',
          409
        );
      throw new Error('session creation failed');
    }
    const response = json({ state });
    response.cookies.set(COOKIE, state, {
      httpOnly: true,
      secure: new URL(request.url).protocol === 'https:',
      sameSite: 'strict',
      path: PATH,
      maxAge: 600,
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}

/** The token never leaves the server. Registration succeeds before the DB commits a connected status. */
export async function PUT(request: NextRequest) {
  let claimed: { id: string; accountId: string; userId: string } | undefined;
  try {
    requireOrigin(request);
    const ctx = await requireRole('admin');
    const config = configured();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new SignupError('Dados inválidos.');
    }
    const input = readSignupInput(body);
    if (!input)
      throw new SignupError('Confira os dados e o PIN de seis dígitos.');
    const cookie = request.cookies.get(COOKIE)?.value;
    if (
      !cookie ||
      cookie.length !== input.state.length ||
      !timingSafeEqual(Buffer.from(cookie), Buffer.from(input.state))
    ) {
      throw new SignupError('A sessão expirou. Reinicie a conexão.', 403);
    }
    const admin = supabaseAdmin();
    // Conditional UPDATE claims the attempt atomically; duplicate requests cannot exchange the code twice.
    const { data: session, error: claimError } = await admin
      .from('whatsapp_signup_sessions')
      .update({ status: 'processing' })
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)
      .eq('state_hash', hash(input.state))
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .select('id')
      .maybeSingle();
    if (claimError) throw new Error('claim failed');
    if (!session)
      throw new SignupError(
        'A sessão expirou ou já foi utilizada. Reinicie a conexão.',
        409
      );
    claimed = { id: session.id, accountId: ctx.accountId, userId: ctx.userId };
    const token = await exchangeSignupCode(config, input.code);
    const phone = await verifySignupAssets(config, token, input);
    const { error: reserveError } = await admin.rpc('reserve_whatsapp_signup', {
      p_session: session.id,
      p_account: ctx.accountId,
      p_user: ctx.userId,
      p_waba: input.wabaId,
      p_phone: input.phoneNumberId,
    });
    if (reserveError) {
      if (
        reserveError.code === '23505' ||
        reserveError.message?.includes('signup_asset_conflict')
      ) {
        throw new SignupError(
          'Esta conta WhatsApp ou número já possui uma conexão no CRM.',
          409
        );
      }
      throw new Error('reservation failed');
    }
    // Validate encryption before any external mutation.
    const encryptedToken = encrypt(token);
    const encryptedVerify = encrypt(config.verifyToken);
    await activateSignup(config, token, input);
    const { error: saveError } = await admin.rpc('finish_whatsapp_signup', {
      p_session: session.id,
      p_account: ctx.accountId,
      p_user: ctx.userId,
      p_token: encryptedToken,
      p_verify: encryptedVerify,
    });
    if (saveError)
      throw new SignupError(
        'O registro na Meta foi feito, mas o CRM não confirmou o salvamento. Contate o suporte antes de repetir.',
        502
      );
    const response = json({
      connected: true,
      displayPhoneNumber: phone.display_phone_number,
    });
    response.cookies.set(COOKIE, '', {
      httpOnly: true,
      secure: new URL(request.url).protocol === 'https:',
      sameSite: 'strict',
      path: PATH,
      maxAge: 0,
    });
    return response;
  } catch (error) {
    if (claimed) {
      try {
        await supabaseAdmin()
          .from('whatsapp_signup_sessions')
          .update({ status: 'failed' })
          .eq('id', claimed.id)
          .eq('account_id', claimed.accountId)
          .eq('user_id', claimed.userId)
          .eq('status', 'processing');
      } catch {
        /* An expired attempt can be recovered by the next begin RPC. */
      }
    }
    return failure(error);
  }
}
