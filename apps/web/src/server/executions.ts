import { and, eq, inArray } from "drizzle-orm";
import type { ImportedExecution } from "@luxalgo/journal-importers";
import { buildRoundTrips } from "@luxalgo/journal-core";
import { db, executions, accounts, trades } from "@/db";
import { executionHash, newId, nowIso } from "./ids";
import { rebuildAccount } from "./rebuild";
import { getJournalDefaults } from "./settings";
import { defaultFee } from "@/lib/journal-defaults";
import { requireValue } from "./api";

export interface InsertResult {
  inserted: number;
  duplicates: number;
  /** Rows dropped because a broker or file record was unusable (sync/import only). */
  skipped: number;
  /** A few plain-language reasons for skipped rows, capped so payloads stay small. */
  skippedReasons: string[];
}

export type ExecutionSource = "sync" | "import" | "manual";

const MAX_SKIP_REASONS = 5;
const ECONOMIC_TIME_TOLERANCE_MS = 2_000;

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Plain-language reason a row can't be journaled, or null when the row is valid. */
export const executionProblem = (row: unknown, source: ExecutionSource): string | null => {
  if (!row || typeof row !== "object") return "Execution is missing.";
  const r = row as Partial<ImportedExecution>;
  const label = typeof r.symbol === "string" && r.symbol.trim() ? r.symbol.trim() : "execution";
  if (typeof r.symbol !== "string" || !r.symbol.trim()) return "An execution has no symbol.";
  if (!["buy", "sell"].includes(r.side as string)) return `${label}: side must be buy or sell.`;
  if (!isFiniteNumber(r.quantity) || r.quantity <= 0)
    return `${label}: quantity must be a finite positive number.`;
  if (!isFiniteNumber(r.price)) return `${label}: price must be a finite number.`;
  if (!isFiniteNumber(r.fee ?? 0)) return `${label}: fee must be a finite number.`;
  if (typeof r.executedAt !== "string" || !Number.isFinite(Date.parse(r.executedAt)))
    return `${label}: timestamp is missing or invalid.`;
  const meta = r.importMetadata;
  const metaOk =
    !meta ||
    (source === "import" &&
      typeof meta.id === "string" &&
      meta.id.length > 0 &&
      meta.id.length <= 2000 &&
      (meta.group === undefined ||
        (typeof meta.group === "string" && meta.group.length > 0 && meta.group.length <= 2000)) &&
      Number.isSafeInteger(meta.order) &&
      meta.order >= 0 &&
      (meta.reportedGrossPnl === undefined || Number.isFinite(meta.reportedGrossPnl)) &&
      (meta.openedAtKnown === undefined || typeof meta.openedAtKnown === "boolean") &&
      (meta.preserveFee === undefined || typeof meta.preserveFee === "boolean"));
  if (!metaOk) return `${label}: invalid imported execution metadata.`;
  return null;
};

/**
 * Split a batch into usable rows and skip reasons. Manual entry is strict: the
 * whole batch is rejected on the first bad row. Broker syncs and file imports
 * are lenient: one odd record must not fail the entire batch, so bad rows are
 * dropped and counted for the caller to report.
 */
export const partitionExecutions = (
  rows: ImportedExecution[],
  source: ExecutionSource,
): { usable: ImportedExecution[]; skipped: number; skippedReasons: string[] } => {
  const usable: ImportedExecution[] = [];
  const skippedReasons: string[] = [];
  let skipped = 0;
  for (const row of rows) {
    const problem = executionProblem(row, source);
    if (problem === null) {
      usable.push(row);
      continue;
    }
    if (source === "manual") {
      requireValue(
        false,
        "Every execution needs a symbol, buy/sell side, finite positive quantity, price, fee and valid timestamp.",
      );
    }
    skipped++;
    if (skippedReasons.length < MAX_SKIP_REASONS) skippedReasons.push(problem);
  }
  return { usable, skipped, skippedReasons };
};

const importGroupFromTradeKey = (key: string): string | undefined => {
  const marker = "|import:";
  const at = key.lastIndexOf(marker);
  if (at < 0) return undefined;
  try {
    return decodeURIComponent(key.slice(at + marker.length));
  } catch {
    return undefined;
  }
};

const importFamily = (group: string | undefined): string | undefined => {
  if (!group) return undefined;
  if (group.startsWith("[")) {
    try {
      const parsed = JSON.parse(group) as unknown;
      if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
    } catch {
      return undefined;
    }
  }
  return group.split(":", 1)[0];
};

const closeNumber = (
  a: number | null | undefined,
  b: number | null | undefined,
  tolerance: number,
) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= tolerance;

const closeTime = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(
    a &&
    b &&
    Number.isFinite(Date.parse(a)) &&
    Number.isFinite(Date.parse(b)) &&
    Math.abs(Date.parse(a) - Date.parse(b)) <= ECONOMIC_TIME_TOLERANCE_MS,
  );

/**
 * Detect the same closed trade reconstructed by a different export/parser.
 * Exact hashes still own same-format retries and timestamp migration guards.
 */
const economicDuplicateIds = (accountId: string, rows: ImportedExecution[]): Set<string> => {
  if (!rows.some((row) => row.importMetadata?.group)) return new Set();
  const candidates = rows.map((row, index) => ({
    ...row,
    id: `candidate-${index}`,
    accountId,
    source: "import" as const,
  }));
  const rowById = new Map(candidates.map((row) => [row.id, row]));
  const existing = db.select().from(trades).where(eq(trades.accountId, accountId)).all();
  const duplicates = new Set<string>();

  for (const incoming of buildRoundTrips(candidates)) {
    if (!incoming.closedAt || incoming.openQuantity !== 0) continue;
    const group = rowById.get(incoming.executionIds[0]!)?.importMetadata?.group;
    const family = importFamily(group);
    if (!family) continue;
    const match = existing.some((saved) => {
      const savedFamily = importFamily(importGroupFromTradeKey(saved.key));
      return (
        saved.closedAt !== null &&
        savedFamily !== undefined &&
        savedFamily !== family &&
        saved.symbol === incoming.symbol &&
        saved.direction === incoming.direction &&
        closeNumber(saved.quantity, incoming.quantity, 1e-8) &&
        closeNumber(saved.avgEntry, incoming.avgEntry, 1e-6) &&
        closeNumber(saved.avgExit, incoming.avgExit, 1e-6) &&
        closeNumber(saved.netPnl, incoming.netPnl, 0.011) &&
        closeTime(saved.openedAt, incoming.openedAt) &&
        closeTime(saved.closedAt, incoming.closedAt)
      );
    });
    if (match) incoming.executionIds.forEach((id) => duplicates.add(id));
  }
  return duplicates;
};

/** Insert fills, rebuild trades, and attach optional manual notes in one transaction. */
export const insertExecutions = (
  accountId: string,
  rows: ImportedExecution[],
  source: ExecutionSource,
  manualNotes?: string,
  options: { preserveFees?: boolean } = {},
): InsertResult => {
  requireValue(
    manualNotes === undefined ||
      (source === "manual" && typeof manualNotes === "string" && manualNotes.length <= 100000),
    "Manual trade notes must be at most 100,000 characters.",
  );
  requireValue(
    db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).get(),
    "Account not found.",
  );
  const { usable: validated, skipped, skippedReasons } = partitionExecutions(rows, source);
  requireValue(
    !validated.some(
      (row) => row.ninjaTrader || row.importMetadata?.group?.startsWith("ninjatrader"),
    ),
    "NinjaTrader fills require the reviewed import endpoint.",
  );
  const economicDuplicates =
    source === "import" ? economicDuplicateIds(accountId, validated) : new Set<string>();
  const usable = validated.filter((_, index) => !economicDuplicates.has(`candidate-${index}`));
  let inserted = 0;
  let duplicates = validated.length - usable.length;
  const createdAt = nowIso();
  const defaults = getJournalDefaults();
  const note = manualNotes?.trim() ? manualNotes : undefined;

  db.transaction((tx) => {
    if (source === "import") {
      const existingHashes = new Set(
        tx
          .select({ hash: executions.contentHash })
          .from(executions)
          .where(and(eq(executions.accountId, accountId), eq(executions.source, "import")))
          .all()
          .map((row) => row.hash),
      );
      for (const row of usable) {
        if (existingHashes.has(executionHash(row))) continue;
        const candidates = [row.legacyExecutedAt, row.executedAt.replace(/\.\d{3}Z$/, ".000Z")];
        requireValue(
          !candidates.some(
            (executedAt) =>
              executedAt &&
              executedAt !== row.executedAt &&
              existingHashes.has(executionHash({ ...row, executedAt })),
          ),
          "Matching imported fills have timestamps from an older parser or indistinguishable whole-second executions. Import the complete corrected history into a new journal account and compare it before retiring the old account; nothing was saved.",
        );
      }
    }
    const noteExecutionIds = new Set<string>();
    for (const row of usable) {
      const id = newId();
      const contentHash = executionHash(row);
      const result = tx
        .insert(executions)
        .values({
          id,
          accountId,
          symbol: row.symbol,
          side: row.side,
          quantity: row.quantity,
          price: row.price,
          fee:
            row.importMetadata?.preserveFee || options.preserveFees
              ? row.fee
              : defaultFee(row.fee, row.quantity, accountId, row.symbol, defaults),
          executedAt: row.executedAt,
          assetClass: row.assetClass ?? null,
          source,
          importMetadataJson: row.importMetadata ? JSON.stringify(row.importMetadata) : null,
          contentHash,
          createdAt,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) {
        inserted++;
        if (note) noteExecutionIds.add(id);
      } else {
        duplicates++;
        if (note) {
          const existing = tx
            .select({ id: executions.id })
            .from(executions)
            .where(
              and(eq(executions.accountId, accountId), eq(executions.contentHash, contentHash)),
            )
            .get();
          if (existing) noteExecutionIds.add(existing.id);
        }
      }
    }
    if (inserted > 0) rebuildAccount(accountId);
    if (note) {
      const affected = tx
        .select({
          key: trades.key,
          notes: trades.notes,
          executionIdsJson: trades.executionIdsJson,
        })
        .from(trades)
        .where(eq(trades.accountId, accountId))
        .all();
      for (const trade of affected) {
        const ids = JSON.parse(trade.executionIdsJson) as string[];
        if (!ids.some((id) => noteExecutionIds.has(id))) continue;
        // Keep prior annotations when these fills extend or close an existing position.
        // Retrying the same submission must not append the note a second time.
        if (trade.notes === note || trade.notes?.endsWith(`\n\n${note}`)) continue;
        const notes = trade.notes?.trim() ? `${trade.notes}\n\n${note}` : note;
        requireValue(
          notes.length <= 100000,
          "Combined trade notes must be at most 100,000 characters.",
        );
        tx.update(trades).set({ notes }).where(eq(trades.key, trade.key)).run();
      }
    }
  });

  return { inserted, duplicates, skipped, skippedReasons };
};

export const deleteExecutionsForTrades = (accountId: string, executionIds: string[]): void => {
  if (executionIds.length === 0) return;
  db.delete(executions)
    .where(and(eq(executions.accountId, accountId), inArray(executions.id, executionIds)))
    .run();
  rebuildAccount(accountId);
};

export const listExecutions = (accountId: string, ids?: string[]) => {
  if (ids && ids.length > 0) {
    return db
      .select()
      .from(executions)
      .where(and(eq(executions.accountId, accountId), inArray(executions.id, ids)))
      .all();
  }
  return db.select().from(executions).where(eq(executions.accountId, accountId)).all();
};
