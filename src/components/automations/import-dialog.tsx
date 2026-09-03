"use client"

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { AlertTriangle, FileJson, Loader2, Upload, Zap } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { triggerMeta } from "@/lib/automations/trigger-meta"
import { cn } from "@/lib/utils"

// ------------------------------------------------------------
// Importar automações de um arquivo JSON.
//
// Dois passos, sempre: escolher o arquivo dispara uma validação a
// seco (`?dry_run=true`, que não grava nada) e só depois de ver a
// prévia é que se confirma. É o que torna a importação tudo-ou-nada
// visível — o servidor recusa o arquivo inteiro quando há qualquer
// problema, e aqui isso aparece como uma lista de pendências em vez
// de um erro por tentativa.
// ------------------------------------------------------------

interface PreviewEntry {
  name: string
  trigger_type: string
  is_active: boolean
  step_count: number
}

interface ImportIssue {
  path: string
  message: string
  code: string
}

export function ImportAutomationsDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  onImported: () => void
}) {
  const t = useTranslations("Automations.import")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [fileName, setFileName] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewEntry[] | null>(null)
  const [issues, setIssues] = useState<ImportIssue[]>([])
  const [checking, setChecking] = useState(false)
  const [importing, setImporting] = useState(false)

  function reset() {
    setFileName(null)
    setContent(null)
    setPreview(null)
    setIssues([])
    setChecking(false)
    setImporting(false)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0]
    if (!selected) return

    setFileName(selected.name)
    setPreview(null)
    setIssues([])
    setChecking(true)

    const text = await selected.text()
    setContent(text)

    const res = await fetch("/api/automations/import?dry_run=true", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    })
    const body = await res.json().catch(() => ({}))
    setChecking(false)

    if (!res.ok) {
      setIssues(Array.isArray(body?.issues) ? body.issues : [])
      // Um arquivo sem `issues` detalhadas (JSON inválido, tamanho
      // acima do teto) ainda precisa dizer o que houve.
      if (!body?.issues?.length && body?.error) toast.error(body.error)
      return
    }

    setPreview(body.automations ?? [])
  }

  async function confirmImport() {
    if (!content) return
    setImporting(true)

    const res = await fetch("/api/automations/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: content,
    })
    const body = await res.json().catch(() => ({}))
    setImporting(false)

    if (!res.ok) {
      // A prévia passou mas a gravação não: o catálogo pode ter
      // mudado entre as duas chamadas (alguém apagou uma tag).
      setIssues(Array.isArray(body?.issues) ? body.issues : [])
      setPreview(null)
      toast.error(body?.error ?? t("errorGeneric"))
      return
    }

    toast.success(t("success", { count: body.imported ?? 0 }))
    handleOpenChange(false)
    onImported()
  }

  const activeCount = preview?.filter((p) => p.is_active).length ?? 0

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={checking || importing}
          className="group flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card/40 px-6 py-8 transition-colors hover:border-primary/50 hover:bg-card/70 disabled:opacity-60"
        >
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors group-hover:bg-muted">
            {checking ? (
              <Loader2 className="size-5 animate-spin text-primary" />
            ) : fileName ? (
              <FileJson className="size-5 text-primary" />
            ) : (
              <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
            )}
          </div>
          <p className="text-sm text-muted-foreground">{fileName ?? t("dropzone")}</p>
          <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleFileChange}
          className="hidden"
        />

        {issues.length > 0 && (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-red-500/30 bg-red-500/5 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-red-400">
              <AlertTriangle className="size-3.5" />
              {t("issuesTitle", { count: issues.length })}
            </p>
            <ul className="space-y-1.5">
              {issues.map((issue, i) => (
                <li key={`${issue.path}-${i}`} className="text-xs">
                  <code className="text-muted-foreground">{issue.path || "—"}</code>
                  <span className="ml-2 text-foreground">{issue.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {preview && preview.length > 0 && (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
            <ul className="divide-y divide-border">
              {preview.map((entry, i) => {
                const meta = triggerMeta(entry.trigger_type as never)
                return (
                  <li
                    key={`${entry.name}-${i}`}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <Zap className="size-4 flex-shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {entry.name}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 font-medium",
                            meta.pillClass,
                          )}
                        >
                          {meta.label}
                        </span>
                        <span className="tabular-nums">
                          {t("stepCount", { count: entry.step_count })}
                        </span>
                      </div>
                    </div>
                    {entry.is_active && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                        {t("willActivate")}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Ligar automações no ato do upload dispara mensagens reais
            no WhatsApp de clientes. Avisar antes é mais barato que
            desfazer depois. */}
        {activeCount > 0 && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            <AlertTriangle className="mt-0.5 size-3.5 flex-shrink-0" />
            {t("activeWarning", { count: activeCount })}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={importing}
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={confirmImport}
            disabled={!preview || preview.length === 0 || checking || importing}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {importing && <Loader2 className="size-4 animate-spin" />}
            {preview ? t("confirm", { count: preview.length }) : t("confirmEmpty")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
