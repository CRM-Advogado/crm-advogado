"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Pipeline, PipelineStage, Deal, Contact, Tag } from "@/types";
import { PipelineBoard } from "@/components/pipelines/pipeline-board";
import { PipelineSettings } from "@/components/pipelines/pipeline-settings";
import { DealForm } from "@/components/pipelines/deal-form";
import { PipelineAnalytics } from "@/components/pipelines/pipeline-analytics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GitBranch, Plus, ChevronDown, Settings } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { GatedButton } from "@/components/ui/gated-button";
import { useTranslations } from "next-intl";

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different `useCan` capabilities,
// not on different copy.

/**
 * Flatten the embedded `contact_tags(tags(*))` join onto `contact.tags`,
 * same pattern as `normalizeConversation` in `@/lib/inbox/conversations`.
 */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawDeal = Omit<Deal, "contact"> & { contact?: RawContact | null };
type BoardData = { id: string; stages: PipelineStage[]; deals: Deal[] };

const DEAL_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*))), assignee:profiles!deals_assigned_to_fkey(*)";
const EMPTY_STAGES: PipelineStage[] = [];

function normalizeDeals(rows: RawDeal[]): Deal[] {
  return rows.map((raw) => {
    const rawContact = raw.contact;
    if (!rawContact) return raw as Deal;
    const { contact_tags, ...contact } = rawContact;
    return {
      ...raw,
      contact: {
        ...contact,
        tags: (contact_tags ?? [])
          .map((ct) => ct.tags)
          .filter((t): t is Tag => t != null),
      },
    };
  });
}

// Spec-defined seed — name and color per the product spec.
const SPEC_DEFAULT_STAGES = [
  { name: "New Lead", color: "#3b82f6", position: 0 }, // blue
  { name: "Qualified", color: "#eab308", position: 1 }, // yellow
  { name: "Proposal Sent", color: "#f97316", position: 2 }, // orange
  { name: "Negotiation", color: "#8b5cf6", position: 3 }, // purple
  { name: "Won", color: "#22c55e", position: 4 }, // green
];

export default function PipelinesPage() {
  const t = useTranslations("Pipelines.page");
  const tNavigation = useTranslations("Sidebar");
  const supabase = createClient();
  const canEditSettings = useCan("edit-settings");
  const canCreateDeals = useCan("send-messages");
  const { accountId, profileLoading } = useAuth();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [board, setBoard] = useState<BoardData | null>(null);
  const activeBoard = board?.id === selectedPipelineId ? board : null;
  const stages = activeBoard?.stages ?? EMPTY_STAGES;
  const [loading, setLoading] = useState(true);

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deal form state is lifted here so both the top-bar "Add Deal" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [defaultStageId, setDefaultStageId] = useState<string>("");

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);
  const initialBoard = useRef<Promise<BoardData | null> | null>(null);

  const loadPipelines = useCallback(async () => {
    const { data, error } = await supabase
      .from("pipelines")
      .select("*")
      .order("created_at")
      .order("id");
    if (error) {
      console.error("Failed to load pipelines:", error.message);
      return null;
    }
    return data ?? [];
  }, [supabase]);

  const loadStages = useCallback(
    async (pipelineId: string) => {
      const { data } = await supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .order("position");
      return data ?? [];
    },
    [supabase],
  );

  const loadDeals = useCallback(
    async (pipelineId: string) => {
      const { data } = await supabase
        .from("deals")
        .select(DEAL_SELECT)
        .eq("pipeline_id", pipelineId)
        .order("created_at", { ascending: false });
      return normalizeDeals((data ?? []) as RawDeal[]);
    },
    [supabase],
  );

  const loadBoard = useCallback(async (pipelineId?: string): Promise<BoardData | null> => {
    let query = supabase
      .from("pipelines")
      .select(`id, stages:pipeline_stages!pipeline_stages_pipeline_id_fkey(*), deals:deals!deals_pipeline_id_fkey(${DEAL_SELECT})`)
      .order("position", { referencedTable: "stages" })
      .order("created_at", { referencedTable: "deals", ascending: false });
    query = pipelineId
      ? query.eq("id", pipelineId)
      : query.order("created_at").order("id").limit(1);

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.error("Failed to load pipeline board:", error.message);
      return null;
    }
    if (!data) return null;
    return {
      id: data.id,
      stages: data.stages as PipelineStage[],
      deals: normalizeDeals(data.deals as RawDeal[]),
    };
  }, [supabase]);

  const seedDefaultPipeline = useCallback(async (): Promise<Pipeline | null> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) return null;
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) return null;

    const { data: pipeline, error } = await supabase
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name: "Sales Pipeline" })
      .select()
      .single();

    if (error || !pipeline) {
      console.error("Failed to seed pipeline:", error?.message);
      return null;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));
    await supabase.from("pipeline_stages").insert(stagesPayload);

    return pipeline as Pipeline;
  }, [supabase, accountId]);

  // The oldest pipeline is known by the same ordering as the selector.
  // Start its board alongside the list, and reuse it only if the IDs agree.
  useEffect(() => {
    if (profileLoading) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const boardRequest = loadBoard();
      const result = await loadPipelines();
      if (cancelled) return;
      let list = result ?? [];

      if (result && list.length === 0 && accountId && canEditSettings && !seedAttempted.current) {
        seedAttempted.current = true;
        const seeded = await seedDefaultPipeline();
        if (seeded) list = (await loadPipelines()) ?? [];
      } else if (list.length > 0) {
        initialBoard.current = boardRequest;
      }

      if (cancelled) return;
      setPipelines(list);
      if (list.length > 0) {
        setSelectedPipelineId((prev) =>
          prev && list.some((p) => p.id === prev) ? prev : list[0].id,
        );
      } else {
        setSelectedPipelineId("");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, canEditSettings, loadBoard, loadPipelines, profileLoading, seedDefaultPipeline]);

  useEffect(() => {
    if (!selectedPipelineId) return;
    let cancelled = false;
    const pending = initialBoard.current;
    initialBoard.current = null;
    (async () => {
      const prefetched = pending ? await pending : null;
      if (cancelled) return;
      const next = prefetched?.id === selectedPipelineId
        ? prefetched
        : await loadBoard(selectedPipelineId);
      if (cancelled) return;
      if (!next) toast.error(t("toastFailedLoadPipelines"));
      setBoard(next ?? { id: selectedPipelineId, stages: EMPTY_STAGES, deals: [] });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, loadBoard, t]);

  const refreshPipelines = useCallback(async () => {
    const list = await loadPipelines();
    if (!list) return;
    setPipelines(list);
    if (list.length === 0) setSelectedPipelineId("");
    else if (!list.some((p) => p.id === selectedPipelineId))
      setSelectedPipelineId(list[0].id);
  }, [loadPipelines, selectedPipelineId]);

  const refreshStages = useCallback(async () => {
    if (!selectedPipelineId) return;
    const next = await loadStages(selectedPipelineId);
    setBoard((prev) => prev?.id === selectedPipelineId ? { ...prev, stages: next } : prev);
  }, [loadStages, selectedPipelineId]);

  const refreshDeals = useCallback(async () => {
    if (!selectedPipelineId) return;
    const next = await loadDeals(selectedPipelineId);
    setBoard((prev) => prev?.id === selectedPipelineId ? { ...prev, deals: next } : prev);
  }, [loadDeals, selectedPipelineId]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      // Optimistic update — board already animated; just persist.
      setBoard((prev) => prev?.id === selectedPipelineId ? {
        ...prev,
        deals: prev.deals.map((d) => (d.id === dealId ? { ...d, stage_id: newStageId } : d)),
      } : prev);
      // Passa pelo servidor em vez de gravar direto no Supabase.
      //
      // A escrita direta funcionava, mas era justamente por causa dela
      // que arrastar um cartão não acionava automação nenhuma: sem
      // servidor no caminho, não havia onde despachar o gatilho
      // `deal_stage_changed`. A rota grava com o MESMO cliente RLS do
      // usuário, então nada se afrouxa em permissão — só se ganha um
      // lugar onde o evento pode ser anunciado.
      let ok = false;
      try {
        const res = await fetch(`/api/deals/${dealId}/stage`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stage_id: newStageId }),
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (!ok) {
        toast.error(t("toastFailedMoveDeal"));
        refreshDeals();
      }
    },
    [refreshDeals, selectedPipelineId, t],
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setEditingDeal(null);
      setDefaultStageId(stageId ?? stages[0]?.id ?? "");
      setDealFormOpen(true);
    },
    [stages],
  );

  const handleEditDeal = useCallback((deal: Deal) => {
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setCreating(false);
      return;
    }
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) {
      toast.error(t("toastNotLinkedToAccount"));
      setCreating(false);
      return;
    }

    const { data: pipeline, error } = await supabase
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name })
      .select()
      .single();

    if (error || !pipeline) {
      toast.error(t("toastFailedCreatePipeline"));
      setCreating(false);
      return;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));
    await supabase.from("pipeline_stages").insert(stagesPayload);

    setNewPipelineName("");
    setNewPipelineOpen(false);
    setSelectedPipelineId(pipeline.id);
    await refreshPipelines();
    setCreating(false);
    toast.success(t("toastPipelineCreated"));
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);

  return (
    <div className="space-y-6">
      <header className="crm-enter border-b border-border pb-5">
        <h1 className="crm-title text-3xl text-foreground sm:text-4xl">
          {tNavigation("pipelines")}
        </h1>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Pipeline selector dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors data-[popup-open]:bg-muted"
            >
              <GitBranch className="h-4 w-4 text-primary" />
              <span className="font-semibold">
                {selectedPipeline?.name ?? t("selectPipeline")}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-64 border-border bg-popover text-popover-foreground"
            >
              {pipelines.length === 0 && (
                <DropdownMenuItem disabled className="text-muted-foreground">
                  {t("noPipelinesYet")}
                </DropdownMenuItem>
              )}
              {pipelines.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => setSelectedPipelineId(p.id)}
                  className={
                    p.id === selectedPipelineId
                      ? "text-primary"
                      : "text-popover-foreground"
                  }
                >
                  <GitBranch className="mr-2 h-3.5 w-3.5" />
                  {p.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="bg-border" />
              {activeBoard && (
                <DropdownMenuItem
                  onClick={() => setSettingsOpen(true)}
                  className="text-popover-foreground"
                >
                  <Settings className="mr-2 h-3.5 w-3.5" />
                  {t("managePipelines")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="create pipelines"
            disabled={loading}
            onClick={() => setNewPipelineOpen(true)}
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("addPipeline")}
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason="create deals"
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("addDeal")}
          </GatedButton>
        </div>
      </div>

      {/* Board */}
      {loading || (selectedPipelineId && !activeBoard) ? (
        <div className="flex gap-3 overflow-hidden" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-96 w-72 shrink-0 animate-pulse rounded-xl bg-muted/50" />
          ))}
        </div>
      ) : !activeBoard ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card py-20">
          <GitBranch className="h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 font-serif text-2xl text-foreground">
            {t("noPipelinesYet")}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("createToStartTracking")}
          </p>
          <GatedButton
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("createPipeline")}
          </GatedButton>
        </div>
      ) : (
        <>
          <PipelineAnalytics stages={stages} deals={activeBoard.deals} />
          <PipelineBoard
            stages={stages}
            deals={activeBoard.deals}
            onDealMoved={handleDealMoved}
            onAddDeal={handleAddDeal}
            onEditDeal={handleEditDeal}
          />
        </>
      )}

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="sm:max-w-sm bg-popover border-border">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t("newPipeline")}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-muted-foreground">{t("pipelineName")}</Label>
            <Input
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder={t("pipelineNamePlaceholder")}
              className="mt-2 bg-muted border-border text-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreatePipeline();
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {t("defaultStagesDesc")}
            </p>
          </div>
          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setNewPipelineOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? t("creating") : t("createPipelineBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {selectedPipeline && activeBoard && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={stages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshStages}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* Deal Form (Sheet) */}
      <DealForm
        open={dealFormOpen}
        onOpenChange={setDealFormOpen}
        deal={editingDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={refreshDeals}
      />
    </div>
  );
}
