'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { toast } from 'sonner';
import type {
  Contact,
  Tag,
  ContactTag,
  ContactNote,
  CustomField,
  ContactCustomValue,
  Deal,
  MessageTemplate,
  ZapsignDocument,
} from '@/types';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  X,
  DollarSign,
  LayoutTemplate,
  Megaphone,
  ExternalLink,
  FileSignature,
  Download,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
  const t = useTranslations('Contacts.detailView');
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  // Send template — lets the business initiate (or re-open) a conversation
  // with this contact by sending an approved template. The send route
  // find-or-creates the conversation, so no inbound message is required.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  // Details tab
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  // Documents tab (ZapSign, migration 044)
  const [documents, setDocuments] = useState<ZapsignDocument[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [downloadingDoc, setDownloadingDoc] = useState<string | null>(null);

  const fetchContact = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);

    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (data) {
      setContact(data);
      setEditName(data.name ?? '');
      setEditPhone(data.phone);
      setEditEmail(data.email ?? '');
      setEditCompany(data.company ?? '');
    }
    setLoading(false);
  }, [contactId, supabase]);

  const fetchTags = useCallback(async () => {
    if (!contactId) return;

    const [tagsRes, contactTagsRes] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase
        .from('contact_tags')
        .select('tag_id')
        .eq('contact_id', contactId),
    ]);

    if (tagsRes.data) setAllTags(tagsRes.data);
    if (contactTagsRes.data) {
      setContactTagIds(contactTagsRes.data.map((ct) => ct.tag_id));
    }
  }, [contactId, supabase]);

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    const { data } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [contactId, supabase]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      supabase.from('custom_fields').select('*').order('field_name'),
      supabase
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      valuesRes.data.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    }
    setLoadingCustom(false);
  }, [contactId, supabase]);

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    const { data } = await supabase
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [contactId, supabase]);

  // Escrita em `zapsign_documents` é exclusiva do service-role (motor e
  // webhook); aqui é leitura pura, escopada pela política de SELECT da
  // migration 044 e pelo contact_id.
  const fetchDocuments = useCallback(async () => {
    if (!contactId) return;
    setLoadingDocuments(true);
    const { data } = await supabase
      .from('zapsign_documents')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDocuments((data ?? []) as ZapsignDocument[]);
    setLoadingDocuments(false);
  }, [contactId, supabase]);

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchTags();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
      fetchDocuments();
    }
  }, [
    open,
    contactId,
    fetchContact,
    fetchTags,
    fetchNotes,
    fetchCustomFields,
    fetchDeals,
    fetchDocuments,
  ]);

  /**
   * Pede um link novo do PDF assinado e abre. Não guardamos a URL: a
   * ZapSign a emite válida por 60 minutos, então qualquer link salvo
   * estaria morto quando alguém fosse usar.
   */
  async function downloadSigned(documentId: string) {
    setDownloadingDoc(documentId);
    try {
      const res = await fetch(
        `/api/zapsign/documents/${documentId}/signed-file`
      );
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !body.url) {
        toast.error(body.error ?? t('documentsTab.downloadFailed'));
        return;
      }
      window.open(body.url, '_blank', 'noopener,noreferrer');
    } catch {
      toast.error(t('documentsTab.downloadFailed'));
    } finally {
      setDownloadingDoc(null);
    }
  }

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error(t('toastPhoneRequired'));
      return;
    }

    setSavingDetails(true);
    const { error } = await supabase
      .from('contacts')
      .update({
        name: editName.trim() || null,
        phone: editPhone.trim(),
        email: editEmail.trim() || null,
        company: editCompany.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId);

    if (error) {
      toast.error(t('toastUpdateFailed'));
    } else {
      toast.success(t('toastUpdated'));
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);

    const isSelected = contactTagIds.includes(tagId);

    try {
      if (isSelected) {
        await deleteContactTag(contactId, tagId);
        setContactTagIds((prev) => prev.filter((id) => id !== tagId));
      } else {
        await addContactTag(contactId, tagId);
        setContactTagIds((prev) => [...prev, tagId]);
      }
      onUpdated();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('toastUpdateFailed')
      );
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user || !accountId) {
      toast.error(t('toastNotAuthenticated'));
      setSavingNote(false);
      return;
    }

    const { error } = await supabase.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: user.id,
      note_text: newNote.trim(),
    });

    if (error) {
      toast.error(t('toastNoteAddFailed'));
    } else {
      setNewNote('');
      fetchNotes();
      toast.success(t('toastNoteAdded'));
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      toast.error(t('toastNoteDeleteFailed'));
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success(t('toastNoteDeleted'));
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    try {
      // Delete existing values and re-insert
      await supabase
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', contactId);

      const rows = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value: val.trim(),
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('contact_custom_values')
          .insert(rows);
        if (error) throw error;
      }

      toast.success(t('toastCustomFieldsSaved'));
    } catch {
      toast.error(t('toastCustomFieldsFailed'));
    }
    setSavingCustom(false);
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues
  ) {
    if (!contactId) return;
    setSendingTemplate(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No conversation_id — the route find-or-creates one for this
          // contact, mirroring the inbox template-send payload otherwise.
          contact_id: contactId,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = payload?.error || `HTTP ${res.status}`;
        toast.error(t('toastTemplateFailed', { reason }));
        return;
      }

      toast.success(t('toastTemplateSent', { name: template.name }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'network error';
      toast.error(`Failed to send template: ${reason}`);
    } finally {
      setSendingTemplate(false);
    }
  }

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          // O prefixo `data-[side=right]:` NÃO é decorativo. O
          // SheetContent traz `data-[side=right]:sm:max-w-sm` nas
          // classes base — 384px, com seletor de classe MAIS atributo.
          // Um `sm:max-w-*` simples tem prefixo de variante diferente,
          // então o twMerge não funde os dois: as duas regras chegam ao
          // DOM e a base vence por especificidade. Era por isso que este
          // painel tinha 384px enquanto o código dizia `sm:max-w-lg`
          // (512px) — a classe estava lá e nunca valeu nada.
          //
          // Repetindo a mesma cadeia de variantes, o twMerge reconhece o
          // conflito e descarta a base. Verificado rodando o twMerge com
          // as duas classes, não por dedução.
          //
          // 38rem (608px) porque as seis abas somam 527px de conteúdo,
          // medidos no navegador com a fonte real: 576px caberia no
          // limite exato, sem folga para um rótulo mais longo ou outra
          // tradução. O painel continua estreito o bastante para não
          // cobrir a lista de contatos atrás dele.
          className="bg-popover border-border text-popover-foreground w-full p-0 data-[side=right]:sm:max-w-[38rem]"
        >
          {loading || !contact ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-primary size-6 animate-spin" />
            </div>
          ) : (
            <div className="flex h-full flex-col">
              {/* Header */}
              <SheetHeader className="border-border/50 border-b p-4">
                <div className="flex items-center gap-3">
                  <Avatar className="bg-muted border-border size-12 border">
                    <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                      {getInitials(contact.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="text-popover-foreground truncate">
                      {contact.name || t('unnamed')}
                    </SheetTitle>
                    <SheetDescription className="text-muted-foreground mt-0.5 text-xs">
                      {t('contactDetailsDesc')}
                    </SheetDescription>
                    <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-3 text-xs">
                      <button
                        onClick={copyPhone}
                        className="hover:text-primary flex cursor-pointer items-center gap-1 transition-colors"
                      >
                        <Phone className="size-3" />
                        {contact.phone}
                        {copiedPhone ? (
                          <Check className="text-primary size-3" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </button>
                      {contact.email && (
                        <span className="flex items-center gap-1">
                          <Mail className="size-3" />
                          {contact.email}
                        </span>
                      )}
                      {contact.company && (
                        <span className="flex items-center gap-1">
                          <Building2 className="size-3" />
                          {contact.company}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-3">
                  <Button
                    size="sm"
                    onClick={() => setTemplatePickerOpen(true)}
                    disabled={sendingTemplate}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {sendingTemplate ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <LayoutTemplate className="size-4" />
                    )}
                    {t('sendTemplateBtn')}
                  </Button>
                </div>
              </SheetHeader>

              {/* Tabs */}
              <Tabs
                defaultValue="details"
                className="flex min-h-0 flex-1 flex-col"
              >
                {/* A lista é `inline-flex w-fit` com rótulos que não
                  quebram linha: ela cresce além do painel (512px) em vez
                  de se ajustar. Com cinco abas cabia por pouco; a sexta
                  saiu da área visível, sem nada indicando que existia.
                  `max-w-full` prende a barra à largura do painel,
                  `shrink-0` nos filhos impede que os rótulos sejam
                  espremidos, e o resto rola na horizontal. A barra de
                  rolagem fica escondida para não roubar altura das abas,
                  que têm altura fixa. */}
                {/* A `TabsList` do design system é `inline-flex w-fit`
                  com altura fixa e rótulos que não quebram linha: ela
                  cresce para fora do painel em vez de se ajustar a ele,
                  e o que passa da borda é cortado sem deixar sinal. Num
                  painel de 512px, os rótulos em português já não cabiam
                  com cinco abas — "Negócios" ficava oculto muito antes
                  de "Documentos" existir.

                  Rolagem horizontal, e não quebra de linha: uma segunda
                  linha de abas exige soltar a altura fixa da lista, e
                  isso desalinha o resto do painel — os campos invadem a
                  área de conteúdo. Rolar mantém a barra com uma linha
                  só, o que também é o que permite acrescentar a sétima
                  aba amanhã sem revisitar este layout.

                  `flex-none` nos gatilhos é o que faz a rolagem
                  acontecer: eles são `flex-1` com base zero, então sem
                  esse ajuste se espremem para caber e os rótulos são
                  cortados em vez de transbordar. A barra de rolagem fica
                  escondida porque roubaria altura das abas. */}
                <TabsList className="bg-muted/50 border-border mx-4 mt-3 max-w-[calc(100%-2rem)] [scrollbar-width:none] justify-start overflow-x-auto border-b [&::-webkit-scrollbar]:hidden [&>*]:flex-none">
                  <TabsTrigger
                    value="details"
                    className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('tabs.details')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="tags"
                    className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('tabs.tags', { fallback: 'Tags' })}
                  </TabsTrigger>
                  <TabsTrigger
                    value="notes"
                    className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('tabs.notes')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="custom"
                    className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('tabs.custom')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="deals"
                    className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('tabs.deals')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="documents"
                    className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                  >
                    {t('tabs.documents')}
                  </TabsTrigger>
                </TabsList>

                {/* Details Tab */}
                <TabsContent
                  value="details"
                  className="flex-1 overflow-y-auto px-4 py-3"
                >
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-muted-foreground text-xs">
                        {t('company', { fallback: 'Name' })}
                      </Label>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="bg-muted border-border text-foreground h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-muted-foreground text-xs">
                        {t('phone')} <span className="text-red-400">*</span>
                      </Label>
                      <Input
                        value={editPhone}
                        onChange={(e) => setEditPhone(e.target.value)}
                        className="bg-muted border-border text-foreground h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-muted-foreground text-xs">
                        {t('email')}
                      </Label>
                      <Input
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        className="bg-muted border-border text-foreground h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-muted-foreground text-xs">
                        {t('company')}
                      </Label>
                      <Input
                        value={editCompany}
                        onChange={(e) => setEditCompany(e.target.value)}
                        className="bg-muted border-border text-foreground h-8 text-sm"
                      />
                    </div>

                    {/* Origem do lead — somente leitura. Vem do objeto
                      `referral` da Meta na primeira mensagem e não é
                      editável: quem grava é o webhook, sob a regra de
                      primeiro toque. Só aparece quando há origem
                      registrada; contato manual ou importado não tem. */}
                    {(contact.ad_source_id ||
                      contact.ad_headline ||
                      contact.ctwa_clid) && (
                      <div className="border-border bg-muted/40 space-y-2 rounded-md border p-3">
                        <div className="flex items-center gap-1.5">
                          <Megaphone className="text-muted-foreground size-3.5" />
                          <Label className="text-muted-foreground text-xs">
                            {t('attribution.title')}
                          </Label>
                          {contact.ad_source_type && (
                            <Badge
                              variant="secondary"
                              className="h-4 px-1.5 text-[10px]"
                            >
                              {contact.ad_source_type === 'ad'
                                ? t('attribution.typeAd')
                                : contact.ad_source_type === 'post'
                                  ? t('attribution.typePost')
                                  : contact.ad_source_type}
                            </Badge>
                          )}
                        </div>

                        {contact.ad_headline && (
                          <p className="text-foreground text-sm leading-snug">
                            {contact.ad_headline}
                          </p>
                        )}

                        <dl className="space-y-1 text-xs">
                          {contact.ad_source_id && (
                            <div className="flex items-baseline justify-between gap-2">
                              <dt className="text-muted-foreground">
                                {t('attribution.adId')}
                              </dt>
                              <dd className="text-foreground font-mono break-all">
                                {contact.ad_source_id}
                              </dd>
                            </div>
                          )}
                          {contact.first_seen_at && (
                            <div className="flex items-baseline justify-between gap-2">
                              <dt className="text-muted-foreground">
                                {t('attribution.firstSeen')}
                              </dt>
                              <dd className="text-foreground">
                                {new Date(
                                  contact.first_seen_at
                                ).toLocaleString()}
                              </dd>
                            </div>
                          )}
                          {contact.ctwa_clid && (
                            <div className="flex items-baseline justify-between gap-2">
                              <dt className="text-muted-foreground">
                                {t('attribution.clickId')}
                              </dt>
                              <dd className="text-foreground font-mono break-all">
                                {contact.ctwa_clid}
                              </dd>
                            </div>
                          )}
                        </dl>

                        {contact.ad_source_url && (
                          <a
                            href={contact.ad_source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
                          >
                            <ExternalLink className="size-3" />
                            {t('attribution.openSource')}
                          </a>
                        )}

                        <p className="text-muted-foreground text-[11px] leading-snug">
                          {t('attribution.firstTouchNote')}
                        </p>
                      </div>
                    )}

                    <Button
                      onClick={saveDetails}
                      disabled={savingDetails}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                      size="sm"
                    >
                      {savingDetails ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      {t('saveChangesBtn')}
                    </Button>
                  </div>
                </TabsContent>

                {/* Tags Tab */}
                <TabsContent
                  value="tags"
                  className="flex-1 overflow-y-auto px-4 py-3"
                >
                  <div className="space-y-3">
                    <p className="text-muted-foreground text-xs">
                      {t('tagsTab.clickTagDesc')}
                    </p>
                    {allTags.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        {t('tagsTab.noTagsAvailable')}
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {allTags.map((tag) => {
                          const selected = contactTagIds.includes(tag.id);
                          return (
                            <button
                              key={tag.id}
                              onClick={() => toggleTag(tag.id)}
                              disabled={savingTags}
                              className={`inline-flex cursor-pointer items-center rounded-full px-3 py-1 text-xs font-medium transition-all ${
                                selected
                                  ? 'ring-primary ring-offset-border ring-2 ring-offset-1'
                                  : 'opacity-50 hover:opacity-80'
                              }`}
                              style={{
                                backgroundColor: tag.color + '20',
                                color: tag.color,
                              }}
                            >
                              {selected && <Check className="mr-1 size-3" />}
                              {tag.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* Notes Tab */}
                <TabsContent
                  value="notes"
                  className="flex min-h-0 flex-1 flex-col px-4 py-3"
                >
                  <div className="mb-3 space-y-2">
                    <Textarea
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      placeholder={t('notesTab.placeholder')}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground min-h-[60px] resize-none text-sm"
                    />
                    <Button
                      onClick={addNote}
                      disabled={!newNote.trim() || savingNote}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground"
                      size="sm"
                    >
                      {savingNote ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                      {t('notesTab.save')}
                    </Button>
                  </div>

                  <div className="flex-1 space-y-2 overflow-y-auto">
                    {loadingNotes ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="text-muted-foreground size-5 animate-spin" />
                      </div>
                    ) : notes.length === 0 ? (
                      <p className="text-muted-foreground py-8 text-center text-sm">
                        {t('notesTab.noNotes')}
                      </p>
                    ) : (
                      notes.map((note) => (
                        <div
                          key={note.id}
                          className="bg-muted/50 border-border/50 group rounded-lg border p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-muted-foreground flex-1 text-sm whitespace-pre-wrap">
                              {note.note_text}
                            </p>
                            <button
                              onClick={() => deleteNote(note.id)}
                              className="text-muted-foreground shrink-0 cursor-pointer opacity-0 transition-all group-hover:opacity-100 hover:text-red-400"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                          <p className="text-muted-foreground mt-1.5 text-xs">
                            {new Date(note.created_at).toLocaleDateString(
                              'en-US',
                              {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              }
                            )}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </TabsContent>

                {/* Custom Fields Tab */}
                <TabsContent
                  value="custom"
                  className="flex-1 overflow-y-auto px-4 py-3"
                >
                  {loadingCustom ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="text-muted-foreground size-5 animate-spin" />
                    </div>
                  ) : customFields.length === 0 ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">
                      {t('noCustomFields')}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {customFields.map((field) => (
                        <div key={field.id} className="space-y-1.5">
                          <Label className="text-muted-foreground text-xs capitalize">
                            {field.field_name}
                          </Label>
                          <Input
                            value={customValues[field.id] ?? ''}
                            onChange={(e) =>
                              setCustomValues((prev) => ({
                                ...prev,
                                [field.id]: e.target.value,
                              }))
                            }
                            placeholder={t('enterCustomField', {
                              name: field.field_name,
                            })}
                            className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-sm"
                          />
                        </div>
                      ))}
                      <Button
                        onClick={saveCustomFields}
                        disabled={savingCustom}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                        size="sm"
                      >
                        {savingCustom ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Save className="size-3.5" />
                        )}
                        {t('saveCustomFieldsBtn')}
                      </Button>
                    </div>
                  )}
                </TabsContent>

                {/* Deals Tab */}
                <TabsContent
                  value="deals"
                  className="flex-1 overflow-y-auto px-4 py-3"
                >
                  {loadingDeals ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="text-primary size-5 animate-spin" />
                    </div>
                  ) : deals.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {t('dealsTab.noDeals')}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {deals.map((deal) => (
                        <div
                          key={deal.id}
                          className="border-border bg-muted/50 rounded-lg border p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-foreground text-sm font-medium">
                              {deal.title}
                            </p>
                            {deal.stage && (
                              <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                style={{
                                  backgroundColor: `${deal.stage.color}20`,
                                  color: deal.stage.color,
                                }}
                              >
                                {deal.stage.name}
                              </span>
                            )}
                          </div>
                          <div className="text-muted-foreground mt-1.5 flex items-center justify-between text-xs">
                            <span className="flex items-center gap-1">
                              <DollarSign className="size-3" />
                              {formatCurrency(
                                deal.value ?? 0,
                                deal.currency || defaultCurrency
                              )}
                            </span>
                            {deal.status && deal.status !== 'open' && (
                              <span
                                className={
                                  deal.status === 'won'
                                    ? 'text-primary'
                                    : 'text-red-400'
                                }
                              >
                                {deal.status}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>

                {/* Documents Tab (ZapSign) */}
                <TabsContent
                  value="documents"
                  className="flex-1 overflow-y-auto px-4 py-3"
                >
                  {loadingDocuments ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="text-primary size-5 animate-spin" />
                    </div>
                  ) : documents.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {t('documentsTab.noDocuments')}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {documents.map((doc) => (
                        <div
                          key={doc.id}
                          className="border-border bg-muted/50 rounded-lg border p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-foreground flex items-center gap-1.5 text-sm font-medium">
                              <FileSignature className="text-muted-foreground size-3.5 shrink-0" />
                              {doc.name}
                            </p>
                            <span
                              className={
                                doc.status === 'signed'
                                  ? 'text-primary shrink-0 text-[10px] font-medium'
                                  : doc.status === 'refused'
                                    ? 'shrink-0 text-[10px] font-medium text-red-400'
                                    : 'text-muted-foreground shrink-0 text-[10px] font-medium'
                              }
                            >
                              {t(`documentsTab.status.${doc.status}`)}
                            </span>
                          </div>
                          <div className="text-muted-foreground mt-1.5 flex items-center justify-between text-xs">
                            <span>
                              {new Date(
                                doc.signed_at ?? doc.created_at
                              ).toLocaleDateString()}
                            </span>
                            {/* Só enquanto pendente: depois de assinado o
                              link não serve mais para nada útil. */}
                            {doc.status === 'pending' && doc.sign_url && (
                              <a
                                href={doc.sign_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary flex items-center gap-1 hover:underline"
                              >
                                {t('documentsTab.openLink')}
                                <ExternalLink className="size-3" />
                              </a>
                            )}
                            {/* O link do PDF assinado dura 60 minutos, então
                              é pedido na hora do clique em vez de guardado. */}
                            {doc.status === 'signed' && doc.zapsign_token && (
                              <button
                                type="button"
                                onClick={() => downloadSigned(doc.id)}
                                disabled={downloadingDoc === doc.id}
                                className="text-primary flex items-center gap-1 hover:underline disabled:opacity-60"
                              >
                                {downloadingDoc === doc.id ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Download className="size-3" />
                                )}
                                {t('documentsTab.downloadSigned')}
                              </button>
                            )}
                            {/* Criação sem resposta: o documento pode existir
                              no ZapSign, e o webhook da assinatura resolve
                              sozinho quando chegar. */}
                            {doc.status === 'pending' && !doc.zapsign_token && (
                              <span className="text-muted-foreground italic">
                                {t('documentsTab.unconfirmed')}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <TemplatePicker
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        onSelect={handleSendTemplate}
      />
    </>
  );
}
