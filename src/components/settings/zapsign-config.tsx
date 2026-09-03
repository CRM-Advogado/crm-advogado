'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FileSignature, Loader2, Copy, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

const MASKED_TOKEN = '••••••••••••••••';

export function ZapsignConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.zapsignConfig');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [apiToken, setApiToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [hasWebhook, setHasWebhook] = useState(false);
  // Only ever populated right after a save that (re)generated it — the
  // plaintext secret is shown exactly once, same contract as API keys
  // and webhook_endpoints (see migration 044).
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/zapsign/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setSandbox(Boolean(data.sandbox));
        setHasWebhook(Boolean(data.has_webhook));
        setApiToken(data.has_token ? MASKED_TOKEN : '');
        setTokenEdited(false);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  const tokenPayload = () => (tokenEdited ? apiToken.trim() : undefined);

  const save = async (regenerateWebhook: boolean) => {
    if (!configured && !tokenEdited) {
      toast.error(t('missingApiToken'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/zapsign/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_token: tokenPayload(),
          sandbox,
          regenerate_webhook: regenerateWebhook,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        if (data.webhook_url) setWebhookUrl(data.webhook_url);
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/zapsign/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setHasWebhook(false);
        setApiToken('');
        setTokenEdited(false);
        setWebhookUrl(null);
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  const copyWebhookUrl = async () => {
    if (!webhookUrl) return;
    await navigator.clipboard.writeText(webhookUrl);
    toast.success(t('copied'));
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSignature className="h-4 w-4 text-primary" /> {t('tokenSectionTitle')}
            </CardTitle>
            <CardDescription>{t('encryptionNotice')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t('apiTokenLabel')}</Label>
              <Input
                type="password"
                value={apiToken}
                onFocus={() => {
                  if (!tokenEdited) {
                    setApiToken('');
                    setTokenEdited(true);
                  }
                }}
                onChange={(e) => {
                  setTokenEdited(true);
                  setApiToken(e.target.value);
                }}
                disabled={disabled}
                placeholder="c7f35c84-..."
              />
            </div>
            <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium text-foreground">{t('sandboxLabel')}</p>
                <p className="text-xs text-muted-foreground">{t('sandboxHint')}</p>
              </div>
              <Switch checked={sandbox} onCheckedChange={setSandbox} disabled={disabled} />
            </div>
            <div className="flex gap-2">
              <Button onClick={() => save(!hasWebhook)} disabled={disabled}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('save')}
              </Button>
              {configured && (
                <Button
                  variant="outline"
                  onClick={handleRemove}
                  disabled={!canEdit || removing}
                >
                  {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : t('remove')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {configured && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('webhookSectionTitle')}</CardTitle>
              <CardDescription>{t('webhookSectionDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {webhookUrl ? (
                <div className="space-y-1.5">
                  <Label>{t('webhookUrlLabel')}</Label>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={webhookUrl} className="font-mono text-xs" />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t('copyUrl')}
                      onClick={copyWebhookUrl}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('webhookUrlHint')}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {hasWebhook ? t('webhookAlreadyGenerated') : t('webhookNotGenerated')}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => save(true)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('regenerateWebhook')}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
