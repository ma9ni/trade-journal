"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ClipboardPaste,
  ExternalLink,
  ImagePlus,
  Pencil,
  Plus,
  RotateCcw,
} from "lucide-react";
import { Attachments } from "@/components/attachments";
import { Field, fieldClass } from "@/components/filter-fields";
import { FilterBar, useFilters } from "@/components/filter-bar";
import { MonetaryField, MonetaryValue } from "@/components/privacy";
import { Markdown, RichEditor } from "@/components/rich-editor";
import { ReviewExport } from "@/components/review-export";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OptionSelect } from "@/components/ui/option-select";
import { cn } from "@/lib/utils";
import { postJson, useApi } from "@/lib/use-api";
import { captureUrls, imageFiles, mergeFiles } from "@/lib/capture-paste";

type OpportunityStatus = "forming" | "triggered" | "taken" | "missed" | "invalidated";
type Direction = "long" | "short" | "undecided";
type View = "inbox" | "taken" | "missed" | "invalidated" | "review";

interface Opportunity {
  id: string;
  accountId: string | null;
  symbol: string;
  direction: Direction;
  timeframe: string;
  status: OpportunityStatus;
  observedAt: string;
  triggeredAt: string | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  playbookId: string | null;
  linkedTradeKey: string | null;
  missedReason: string;
  notes: string;
  reviewedAt: string | null;
  archivedAt: string | null;
}

interface TradeOption {
  key: string;
  accountId: string;
  symbol: string;
  direction: "long" | "short";
  openedAt: string;
  closedAt: string | null;
  netPnl: number;
}

interface AccountOption {
  id: string;
  name: string;
  archivedAt: string | null;
}

interface Draft {
  accountId: string;
  symbol: string;
  direction: Direction;
  timeframe: string;
  status: OpportunityStatus;
  observedAt: string;
  triggeredAt: string;
  playbookId: string;
  entry: string;
  stop: string;
  target: string;
  linkedTradeKey: string;
  missedReason: string;
  notes: string;
  reviewed: boolean;
}

const STATUS: Record<OpportunityStatus, { label: string; className: string }> = {
  forming: { label: "Forming", className: "border-border bg-muted text-muted-foreground" },
  triggered: { label: "Triggered", className: "border-sky-500/30 bg-sky-500/10 text-sky-500" },
  taken: { label: "Taken", className: "border-profit/30 bg-profit/10 text-profit" },
  missed: { label: "Missed", className: "border-amber-500/30 bg-amber-500/10 text-amber-500" },
  invalidated: { label: "Invalidated", className: "border-loss/30 bg-loss/10 text-loss" },
};
const VIEWS: { value: View; label: string }[] = [
  { value: "inbox", label: "Inbox" },
  { value: "taken", label: "Taken" },
  { value: "missed", label: "Missed" },
  { value: "invalidated", label: "Invalidated" },
  { value: "review", label: "Review queue" },
];

const localDateTime = (value = new Date().toISOString()) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const blank = (accountId = ""): Draft => ({
  accountId,
  symbol: "",
  direction: "undecided",
  timeframe: "1h",
  status: "forming",
  observedAt: localDateTime(),
  triggeredAt: "",
  playbookId: "",
  entry: "",
  stop: "",
  target: "",
  linkedTradeKey: "",
  missedReason: "",
  notes: "",
  reviewed: false,
});
const tradePath = (key: string, accountId?: string | null) =>
  `/trades/${encodeURIComponent(key)}${accountId ? `?accounts=${encodeURIComponent(accountId)}` : ""}`;
const normalizedSymbol = (symbol: string) => symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");

function suggestedTrade(opportunity: Opportunity, trades: TradeOption[]) {
  if (opportunity.linkedTradeKey || opportunity.direction === "undecided") return null;
  const origin = Date.parse(opportunity.triggeredAt ?? opportunity.observedAt);
  const start = origin - 15 * 60_000;
  const end = origin + 72 * 60 * 60_000;
  return (
    trades
      .filter(
        (trade) =>
          (!opportunity.accountId || trade.accountId === opportunity.accountId) &&
          normalizedSymbol(trade.symbol) === normalizedSymbol(opportunity.symbol) &&
          trade.direction === opportunity.direction &&
          Date.parse(trade.openedAt) >= start &&
          Date.parse(trade.openedAt) <= end,
      )
      .sort(
        (a, b) =>
          Math.abs(Date.parse(a.openedAt) - origin) - Math.abs(Date.parse(b.openedAt) - origin),
      )[0] ?? null
  );
}

function CapturePicker({
  files,
  links,
  onFilesChange,
  onLinksChange,
}: {
  files: File[];
  links: string[];
  onFilesChange: (files: File[]) => void;
  onLinksChange: (links: string[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const add = (nextFiles: File[], nextLinks: string[]) => {
    onFilesChange(mergeFiles(files, nextFiles));
    onLinksChange([...new Set([...links, ...nextLinks])]);
  };
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      const nextFiles = imageFiles(event.clipboardData);
      const target = event.target as HTMLElement | null;
      const editingText = Boolean(target?.closest("input, textarea, [contenteditable='true']"));
      const nextLinks = editingText ? [] : captureUrls(event.clipboardData);
      if (!nextFiles.length && !nextLinks.length) return;
      event.preventDefault();
      add(nextFiles, nextLinks);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  });
  return (
    <div
      className="space-y-2 rounded-md border border-dashed p-3 focus:border-ring focus:outline-none"
      tabIndex={0}
      aria-label="Before capture upload area"
      onPaste={(event) => {
        const nextFiles = imageFiles(event.clipboardData);
        const nextLinks = captureUrls(event.clipboardData);
        if (!nextFiles.length && !nextLinks.length) return;
        event.preventDefault();
        event.stopPropagation();
        add(nextFiles, nextLinks);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const nextFiles = imageFiles(event.dataTransfer);
        const nextLinks = captureUrls(event.dataTransfer);
        if (!nextFiles.length && !nextLinks.length) return;
        event.preventDefault();
        add(nextFiles, nextLinks);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm font-medium">Before capture</p>
        <Button type="button" size="sm" variant="outline" onClick={() => input.current?.click()}>
          <ImagePlus /> Choose images
        </Button>
      </div>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <ClipboardPaste className="h-3 w-3" /> Paste anywhere, or drop multiple images and
        TradingView links here.
      </p>
      {[
        ...files.map((file) => ({ key: `file:${file.name}:${file.size}`, label: file.name })),
        ...links.map((link) => ({ key: `link:${link}`, label: link })),
      ].map((item) => (
        <div
          key={item.key}
          className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2 text-xs"
        >
          <span className="truncate">{item.label}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (item.key.startsWith("file:"))
                onFilesChange(
                  files.filter((file) => `file:${file.name}:${file.size}` !== item.key),
                );
              else onLinksChange(links.filter((link) => `link:${link}` !== item.key));
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <input
        ref={input}
        className="hidden"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={(event) => add(Array.from(event.target.files ?? []), [])}
      />
    </div>
  );
}

export function OpportunityLog() {
  const filters = useFilters();
  const selectedAccounts = useMemo(
    () => new Set((filters.accounts ?? "").split(",").filter(Boolean)),
    [filters.accounts],
  );
  const { data, error, refresh } = useApi<{ opportunities: Opportunity[] }>(
    "/api/workspace/opportunities",
  );
  const { data: books } = useApi<{ playbooks: { id: string; name: string }[] }>("/api/playbooks");
  const { data: accountData } = useApi<{ accounts: AccountOption[] }>("/api/accounts?summary=1");
  const { data: tradeData } = useApi<{ trades: TradeOption[] }>("/api/trades?view=list");
  const [view, setView] = useState<View>("inbox");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => blank());
  const [beforeFiles, setBeforeFiles] = useState<File[]>([]);
  const [beforeLinks, setBeforeLinks] = useState<string[]>([]);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const accounts = accountData?.accounts.filter((account) => !account.archivedAt) ?? [];
  const trades = tradeData?.trades ?? [];
  const opportunities = data?.opportunities ?? [];

  const filteredByContext = opportunities.filter((item) => {
    if (Boolean(item.archivedAt) !== archived) return false;
    if (selectedAccounts.size && (!item.accountId || !selectedAccounts.has(item.accountId)))
      return false;
    const day = item.observedAt.slice(0, 10);
    if (filters.from && day < filters.from) return false;
    if (filters.to && day > filters.to) return false;
    if (
      filters.values.symbol &&
      normalizedSymbol(item.symbol) !== normalizedSymbol(filters.values.symbol)
    )
      return false;
    if (filters.values.playbookId && item.playbookId !== filters.values.playbookId) return false;
    return `${item.symbol} ${item.notes} ${item.missedReason}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  });
  const viewMatches = (item: Opportunity, target: View) => {
    if (target === "inbox") return item.status === "forming" || item.status === "triggered";
    if (target === "review")
      return ["taken", "missed", "invalidated"].includes(item.status) && !item.reviewedAt;
    return item.status === target;
  };
  const rows = filteredByContext.filter((item) => viewMatches(item, view));
  const counts = Object.fromEntries(
    VIEWS.map(({ value }) => [
      value,
      filteredByContext.filter((item) => viewMatches(item, value)).length,
    ]),
  ) as Record<View, number>;

  function edit(item?: Opportunity, linkedTradeKey?: string) {
    const defaultAccount = selectedAccounts.size === 1 ? [...selectedAccounts][0]! : "";
    setEditing(item?.id ?? null);
    setBeforeFiles([]);
    setBeforeLinks([]);
    setDraft(
      item
        ? {
            accountId: item.accountId ?? "",
            symbol: item.symbol,
            direction: item.direction,
            timeframe: item.timeframe,
            status: item.status,
            observedAt: localDateTime(item.observedAt),
            triggeredAt: item.triggeredAt ? localDateTime(item.triggeredAt) : "",
            playbookId: item.playbookId ?? "",
            entry: item.entry?.toString() ?? "",
            stop: item.stop?.toString() ?? "",
            target: item.target?.toString() ?? "",
            linkedTradeKey: linkedTradeKey ?? item.linkedTradeKey ?? "",
            missedReason: item.missedReason,
            notes: item.notes,
            reviewed: Boolean(item.reviewedAt),
          }
        : blank(defaultAccount),
    );
    setFailure("");
    setOpen(true);
  }

  async function uploadBefore(id: string, files: File[], links: string[]) {
    for (const file of files) {
      const body = new FormData();
      body.append("type", "opportunity");
      body.append("id", id);
      body.append("role", "before");
      body.append("file", file);
      const response = await fetch("/api/attachments", { method: "POST", body });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Capture upload failed.");
    }
    for (const url of links) {
      await postJson("/api/attachments", { type: "opportunity", id, role: "before", url });
    }
  }

  async function save() {
    setBusy(true);
    setFailure("");
    try {
      const result = await postJson<{ id: string }>("/api/workspace/opportunities", {
        ...draft,
        id: editing,
        accountId: draft.accountId || null,
        observedAt: new Date(draft.observedAt).toISOString(),
        triggeredAt: draft.triggeredAt ? new Date(draft.triggeredAt).toISOString() : null,
        playbookId: draft.playbookId || null,
        linkedTradeKey: draft.linkedTradeKey || null,
        entry: draft.entry === "" ? null : Number(draft.entry),
        stop: draft.stop === "" ? null : Number(draft.stop),
        target: draft.target === "" ? null : Number(draft.target),
      });
      if (!editing) setEditing(result.id);
      if (beforeFiles.length || beforeLinks.length)
        await uploadBefore(result.id, beforeFiles, beforeLinks);
      setOpen(false);
      setBeforeFiles([]);
      setBeforeLinks([]);
      refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Could not save the opportunity.");
    } finally {
      setBusy(false);
    }
  }

  async function updateReview(item: Opportunity) {
    setFailure("");
    try {
      await postJson("/api/workspace/opportunities", { ...item, reviewed: !item.reviewedAt });
      refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Could not update the review state.");
    }
  }

  const formField = (
    key: "symbol" | "timeframe" | "observedAt" | "triggeredAt" | "entry" | "stop" | "target",
    label: string,
    type = "text",
  ) => (
    <Field label={label}>
      <MonetaryField sensitive={type === "number"}>
        <input
          className={fieldClass}
          type={type}
          step={type === "number" ? "any" : undefined}
          list={key === "timeframe" ? "opportunity-timeframes" : undefined}
          value={draft[key]}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        />
      </MonetaryField>
    </Field>
  );

  return (
    <div>
      <FilterBar
        title="Opportunities"
        actions={
          <Button size="sm" onClick={() => edit()}>
            <Plus /> Log opportunity
          </Button>
        }
      />
      <main className="space-y-4 p-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Capture a setup when you see it, then classify the outcome and review the chart later.
          Opportunities stay separate from trade statistics until you explicitly link a trade.
        </p>
        <div className="flex min-w-0 gap-1 overflow-x-auto rounded-md border p-1" role="tablist">
          {VIEWS.map((item) => (
            <Button
              key={item.value}
              role="tab"
              aria-selected={view === item.value}
              variant={view === item.value ? "secondary" : "ghost"}
              size="sm"
              className="shrink-0"
              onClick={() => setView(item.value)}
            >
              {item.label} <span className="text-muted-foreground">{counts[item.value]}</span>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <input
            aria-label="Search opportunities"
            className={`${fieldClass} max-w-sm`}
            placeholder="Search symbol, notes or reason"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={archived}
              onCheckedChange={(checked) => setArchived(checked === true)}
            />{" "}
            Show archived
          </label>
        </div>
        {(error || failure) && (
          <p role="alert" className="text-sm text-destructive">
            {error || failure}
          </p>
        )}
        <div className="grid gap-4 xl:grid-cols-2">
          {rows.map((item) => {
            const linkedTrade = trades.find((trade) => trade.key === item.linkedTradeKey);
            const suggestion = suggestedTrade(item, trades);
            const account = accounts.find((value) => value.id === item.accountId);
            const playbook = books?.playbooks.find((value) => value.id === item.playbookId);
            return (
              <Card key={item.id} className="overflow-hidden">
                <CardHeader className="gap-3 border-b pb-4">
                  <div className="flex min-w-0 flex-wrap items-start gap-2">
                    <div className="mr-auto min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold">{item.symbol}</h2>
                        <Badge variant="outline" className={STATUS[item.status].className}>
                          {STATUS[item.status].label}
                        </Badge>
                        <span className="text-xs uppercase text-muted-foreground">
                          {item.direction} · {item.timeframe}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {new Date(item.observedAt).toLocaleString()} ·{" "}
                        {account?.name ?? "No account"} · {playbook?.name ?? "No playbook"}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit opportunity"
                      onClick={() => edit(item)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={item.archivedAt ? "Restore opportunity" : "Archive opportunity"}
                      onClick={async () => {
                        try {
                          await postJson(
                            "/api/workspace/opportunities",
                            { id: item.id, restore: Boolean(item.archivedAt) },
                            "DELETE",
                          );
                          refresh();
                        } catch (cause) {
                          setFailure(cause instanceof Error ? cause.message : "Could not archive.");
                        }
                      }}
                    >
                      {item.archivedAt ? <RotateCcw /> : <Archive />}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                    {[
                      ["Entry", item.entry],
                      ["Stop", item.stop],
                      ["Target", item.target],
                    ].map(([label, value]) => (
                      <span key={label as string}>
                        <span className="text-muted-foreground">{label}: </span>
                        <MonetaryValue>{value ?? "-"}</MonetaryValue>
                      </span>
                    ))}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-4">
                  {item.missedReason && (
                    <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
                      {item.missedReason}
                    </p>
                  )}
                  <Markdown>{item.notes || "No notes yet."}</Markdown>
                  {linkedTrade ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                      <span>
                        Linked trade: {linkedTrade.symbol} · {linkedTrade.direction} ·{" "}
                        {new Date(linkedTrade.openedAt).toLocaleString()}
                      </span>
                      <Button asChild variant="outline" size="sm">
                        <Link href={tradePath(linkedTrade.key, linkedTrade.accountId)}>
                          Open <ExternalLink />
                        </Link>
                      </Button>
                    </div>
                  ) : suggestion ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm">
                      <span>
                        Possible match: {suggestion.symbol} · {suggestion.direction} ·{" "}
                        {new Date(suggestion.openedAt).toLocaleString()}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => edit(item, suggestion.key)}
                      >
                        Review match
                      </Button>
                    </div>
                  ) : null}
                  <div className="grid gap-3 md:grid-cols-2">
                    <Attachments
                      type="opportunity"
                      id={item.id}
                      role="before"
                      heading="Before"
                      allowPaste
                    />
                    <Attachments
                      type="opportunity"
                      id={item.id}
                      role="after"
                      heading="After"
                      allowPaste
                    />
                  </div>
                  <Attachments
                    type="opportunity"
                    id={item.id}
                    role="general"
                    heading="Other files"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                    <ReviewExport
                      containsFinancialData
                      document={{
                        title: `Opportunity · ${item.symbol}`,
                        subtitle: `${STATUS[item.status].label} · ${item.direction} · ${item.observedAt}`,
                        lines: [
                          `Timeframe: ${item.timeframe} | Account: ${account?.name ?? "-"}`,
                          `Planned entry: ${item.entry ?? "-"} | Stop: ${item.stop ?? "-"} | Target: ${item.target ?? "-"}`,
                          item.missedReason ? `Reason: ${item.missedReason}` : "",
                          "",
                          item.notes,
                        ].filter(Boolean),
                      }}
                    />
                    {["taken", "missed", "invalidated"].includes(item.status) && (
                      <Button
                        variant={item.reviewedAt ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => void updateReview(item)}
                      >
                        <Check /> {item.reviewedAt ? "Reviewed" : "Mark reviewed"}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
        {data && !rows.length && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No {archived ? "archived " : ""}opportunities in this view.
          </p>
        )}
      </main>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit opportunity" : "Log opportunity"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {formField("symbol", "Symbol")}
            <Field label="Account">
              <OptionSelect
                value={draft.accountId}
                onValueChange={(accountId) => setDraft({ ...draft, accountId })}
              >
                <option value="">No account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </OptionSelect>
            </Field>
            <Field label="Status">
              <OptionSelect
                value={draft.status}
                onValueChange={(status) =>
                  setDraft({ ...draft, status: status as OpportunityStatus })
                }
              >
                {Object.entries(STATUS).map(([value, item]) => (
                  <option key={value} value={value}>
                    {item.label}
                  </option>
                ))}
              </OptionSelect>
            </Field>
            <Field label="Direction">
              <OptionSelect
                value={draft.direction}
                onValueChange={(direction) =>
                  setDraft({ ...draft, direction: direction as Direction })
                }
              >
                <option value="undecided">Undecided</option>
                <option value="long">Long</option>
                <option value="short">Short</option>
              </OptionSelect>
            </Field>
            {formField("timeframe", "Timeframe")}
            <datalist id="opportunity-timeframes">
              {["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"].map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            <Field label="Playbook">
              <OptionSelect
                value={draft.playbookId}
                onValueChange={(playbookId) => setDraft({ ...draft, playbookId })}
              >
                <option value="">No playbook</option>
                {books?.playbooks.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.name}
                  </option>
                ))}
              </OptionSelect>
            </Field>
            {formField("observedAt", "Observed at", "datetime-local")}
            {formField("triggeredAt", "Triggered at", "datetime-local")}
            <Field label="Linked trade">
              <OptionSelect
                value={draft.linkedTradeKey}
                onValueChange={(linkedTradeKey) => setDraft({ ...draft, linkedTradeKey })}
              >
                <option value="">No linked trade</option>
                {trades
                  .filter((trade) => !draft.accountId || trade.accountId === draft.accountId)
                  .map((trade) => (
                    <option key={trade.key} value={trade.key}>
                      {trade.symbol} · {trade.direction} ·{" "}
                      {new Date(trade.openedAt).toLocaleDateString()}
                    </option>
                  ))}
              </OptionSelect>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {formField("entry", "Planned entry", "number")}
            {formField("stop", "Planned stop", "number")}
            {formField("target", "Planned target", "number")}
          </div>
          {(draft.status === "missed" || draft.status === "invalidated") && (
            <Field
              label={draft.status === "missed" ? "Why was it missed?" : "Why was it invalidated?"}
            >
              <textarea
                className={cn(fieldClass, "min-h-20 resize-y")}
                maxLength={500}
                value={draft.missedReason}
                onChange={(event) => setDraft({ ...draft, missedReason: event.target.value })}
              />
            </Field>
          )}
          <RichEditor
            defaultMode="edit"
            value={draft.notes}
            onChange={(notes) => setDraft({ ...draft, notes })}
            placeholder="Context, setup criteria, confirmation and review notes..."
          />
          {!editing && (
            <CapturePicker
              files={beforeFiles}
              links={beforeLinks}
              onFilesChange={setBeforeFiles}
              onLinksChange={setBeforeLinks}
            />
          )}
          {["taken", "missed", "invalidated"].includes(draft.status) && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.reviewed}
                onCheckedChange={(checked) => setDraft({ ...draft, reviewed: checked === true })}
              />{" "}
              Review completed
            </label>
          )}
          {draft.direction === "undecided" &&
            !["forming", "invalidated"].includes(draft.status) && (
              <p role="alert" className="text-xs text-destructive">
                Choose Long or Short once the setup is triggered.
              </p>
            )}
          {failure && (
            <p role="alert" className="text-xs text-destructive">
              {failure}
            </p>
          )}
          <Button
            disabled={
              busy ||
              !draft.symbol.trim() ||
              !draft.timeframe.trim() ||
              !draft.observedAt ||
              (draft.direction === "undecided" &&
                !["forming", "invalidated"].includes(draft.status))
            }
            onClick={() => void save()}
          >
            {busy ? "Saving..." : "Save opportunity"}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
