'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  readSignupEvent,
  readSignupTermination,
  type SignupAssets,
} from '@/lib/whatsapp/embedded-signup';

interface FacebookSdk {
  init(options: {
    appId: string;
    version: string;
    cookie: boolean;
    xfbml: boolean;
  }): void;
  login(
    callback: (result: { authResponse?: { code?: string } }) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras: { setup: object; sessionInfoVersion: '3' };
    }
  ): void;
}
declare global {
  interface Window {
    FB?: FacebookSdk;
  }
}
type Setup = {
  available: boolean;
  connected: boolean;
  appId?: string;
  configId?: string;
  version?: string;
};

async function api(method: string, body?: object) {
  const response = await fetch('/api/whatsapp/embedded-signup', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Connection failed');
  return payload;
}

export function WhatsAppEmbeddedSignup({
  onConnected,
}: {
  onConnected: () => void;
}) {
  const t = useTranslations('whatsappSignup');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [pin, setPin] = useState('');
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const active = useRef(false);
  const assets = useRef<SignupAssets | null>(null);
  const code = useRef<string | null>(null);
  const submitting = useRef(false);
  const completion = useRef<(() => void) | null>(null);
  const termination = useRef<
    ((reason: 'cancelled' | 'error' | 'unsupported') => void) | null
  >(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let script: HTMLScriptElement | null = null;
    const load = (config: Setup) => {
      if (!mounted.current || !window.FB || !config.appId || !config.version)
        return;
      window.FB.init({
        appId: config.appId,
        version: config.version,
        cookie: false,
        xfbml: false,
      });
      setSdkReady(true);
    };
    api('GET')
      .then((config: Setup) => {
        if (!mounted.current) return;
        setSetup(config);
        if (!config.available || config.connected) return;
        if (window.FB) {
          load(config);
          return;
        }
        script = document.createElement('script');
        script.src = 'https://connect.facebook.net/en_US/sdk.js';
        script.async = true;
        script.onload = () => load(config);
        script.onerror = () => {
          if (mounted.current) setMessage(t('sdkError'));
        };
        document.head.appendChild(script);
      })
      .catch(() => {
        if (mounted.current) setMessage(t('setupError'));
      });
    return () => {
      mounted.current = false;
      active.current = false;
      if (timeout.current) clearTimeout(timeout.current);
      if (script) {
        script.onload = null;
        script.onerror = null;
        script.remove();
      }
    };
  }, [t]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (!active.current) return;
      const reason = readSignupTermination(event.origin, event.data);
      if (reason && !submitting.current) {
        termination.current?.(reason);
        return;
      }
      const result = readSignupEvent(event.origin, event.data);
      if (result) {
        assets.current = result;
        completion.current?.();
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  function stop(text: string) {
    active.current = false;
    if (timeout.current) clearTimeout(timeout.current);
    assets.current = null;
    code.current = null;
    setBusy(false);
    setState(null);
    setMessage(text);
  }

  // Prepare first, then open on a separate click: awaiting a network request
  // before FB.login loses the browser's user gesture and can block the popup.
  async function prepare() {
    setBusy(true);
    setMessage('');
    try {
      const session = await api('POST');
      setState(session.state);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('setupError'));
    } finally {
      setBusy(false);
    }
  }

  function launch() {
    if (!window.FB || !setup?.configId || !state || active.current) return;
    active.current = true;
    termination.current = (reason) =>
      stop(
        t(
          reason === 'cancelled'
            ? 'cancelled'
            : reason === 'unsupported'
              ? 'numberHint'
              : 'sdkError'
        )
      );
    submitting.current = false;
    assets.current = null;
    code.current = null;
    setBusy(true);
    setMessage(t('waiting'));
    completion.current = () => {
      if (
        !active.current ||
        submitting.current ||
        !assets.current ||
        !code.current
      )
        return;
      submitting.current = true;
      if (timeout.current) clearTimeout(timeout.current);
      setMessage(t('saving'));
      api('PUT', { ...assets.current, code: code.current, state, pin })
        .then(() => {
          if (mounted.current) {
            stop(t('success'));
            setPin('');
            setSetup((s) => (s ? { ...s, connected: true } : s));
            onConnected();
          }
        })
        .catch((error) => {
          if (mounted.current)
            stop(error instanceof Error ? error.message : t('setupError'));
        });
    };
    timeout.current = setTimeout(
      () => {
        if (mounted.current) stop(t('timeout'));
      },
      5 * 60 * 1000
    );
    try {
      window.FB.login(
        (result) => {
          if (!mounted.current || !active.current) return;
          if (!result.authResponse?.code) {
            stop(t('cancelled'));
            return;
          }
          code.current = result.authResponse.code;
          completion.current?.();
        },
        {
          config_id: setup.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {}, sessionInfoVersion: '3' },
        }
      );
    } catch {
      stop(t('sdkError'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">{t('numberHint')}</p>
        {setup?.connected ? (
          <p>{t('alreadyConnected')}</p>
        ) : setup?.available ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="whatsapp-signup-pin">{t('pinLabel')}</Label>
              <Input
                id="whatsapp-signup-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pin}
                onChange={(event) =>
                  setPin(event.target.value.replace(/\D/g, ''))
                }
                disabled={busy || Boolean(state)}
                aria-describedby="whatsapp-signup-pin-help"
              />
              <p
                id="whatsapp-signup-pin-help"
                className="text-muted-foreground text-xs"
              >
                {t('pinHint')}
              </p>
            </div>
            <Button
              onClick={state ? launch : prepare}
              disabled={busy || !sdkReady || !/^\d{6}$/.test(pin)}
            >
              {busy ? t('working') : state ? t('openMeta') : t('connect')}
            </Button>
            {state && !busy && (
              <Button
                variant="ghost"
                onClick={() => {
                  setState(null);
                  setMessage('');
                }}
              >
                {t('back')}
              </Button>
            )}
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            {setup ? t('unavailable') : message ? '' : t('loading')}
          </p>
        )}
        <p role="status" aria-live="polite" className="text-sm">
          {message}
        </p>
      </CardContent>
    </Card>
  );
}
