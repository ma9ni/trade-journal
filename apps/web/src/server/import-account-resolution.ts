import { and, eq, isNull } from "drizzle-orm";
import type { ParsedImport } from "@luxalgo/journal-importers";
import { accounts, db, executions, importSourceAliases, importSources } from "@/db";
import { newId, nowIso } from "./ids";
import type { AccountType } from "@/lib/account-profile";

export interface ImportAccountResolution {
  status: "matched" | "create" | "ambiguous";
  accountId?: string;
  reason: "selected" | "source-id" | "overlap" | "profile" | "only-account" | "new" | "ambiguous";
  suggestion?: { name: string; broker: string; currency: string; initialBalance: number };
}

const textKey = (value: string | undefined): string => value?.trim().toLowerCase() ?? "";

const newAccountResolution = (parsed: ParsedImport): ImportAccountResolution => ({
  status: "create",
  reason: "new",
  suggestion: {
    name: parsed.accountHint?.name?.trim() || `${parsed.format} import`,
    broker: parsed.accountHint?.broker?.trim() || "",
    currency: parsed.accountHint?.currency?.trim().toUpperCase() || "USD",
    initialBalance:
      typeof parsed.accountHint?.initialBalance === "number" &&
      Number.isFinite(parsed.accountHint.initialBalance)
        ? parsed.accountHint.initialBalance
        : 0,
  },
});

interface FillIdentity {
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  executedAt: string;
}

const fillKey = (fill: FillIdentity) =>
  [
    fill.symbol.trim().toUpperCase(),
    fill.side,
    fill.quantity.toPrecision(12),
    fill.price.toPrecision(12),
    fill.executedAt,
  ].join("|");

/** Resolve without side effects. A weak guess is reported as ambiguous, never silently committed. */
export const resolveImportAccount = (
  parsed: ParsedImport,
  requestedAccountId?: string,
): ImportAccountResolution => {
  const active = db.select().from(accounts).where(isNull(accounts.archivedAt)).all();
  if (requestedAccountId) {
    const selected = active.find((account) => account.id === requestedAccountId);
    if (selected) return { status: "matched", accountId: selected.id, reason: "selected" };
    return { status: "ambiguous", reason: "ambiguous" };
  }

  const externalId = textKey(parsed.accountHint?.externalId);
  if (externalId) {
    const aliasAccounts = new Set(
      db
        .select({
          accountId: importSourceAliases.accountId,
          aliasKey: importSourceAliases.aliasKey,
        })
        .from(importSourceAliases)
        .where(eq(importSourceAliases.format, parsed.format))
        .all()
        .filter((row) => textKey(row.aliasKey) === externalId)
        .map((row) => row.accountId),
    );
    if (aliasAccounts.size === 1)
      return { status: "matched", accountId: [...aliasAccounts][0], reason: "source-id" };
    const named = active.filter((account) => textKey(account.name).includes(externalId));
    if (named.length === 1)
      return { status: "matched", accountId: named[0]!.id, reason: "source-id" };
  }

  // A growing history export can identify its destination from fills already imported.
  const incoming = new Set(parsed.executions.map(fillKey));
  const overlap = new Map<string, number>();
  if (incoming.size) {
    for (const row of db
      .select({
        accountId: executions.accountId,
        symbol: executions.symbol,
        side: executions.side,
        quantity: executions.quantity,
        price: executions.price,
        executedAt: executions.executedAt,
      })
      .from(executions)
      .all()) {
      if (incoming.has(fillKey(row)))
        overlap.set(row.accountId, (overlap.get(row.accountId) ?? 0) + 1);
    }
  }
  const ranked = [...overlap.entries()].sort((a, b) => b[1] - a[1]);
  if (
    ranked[0] &&
    ranked[0][1] >= Math.min(2, incoming.size) &&
    ranked[0][1] > (ranked[1]?.[1] ?? 0)
  )
    return { status: "matched", accountId: ranked[0][0], reason: "overlap" };

  // A source-native account ID is authoritative. If it is new and no existing
  // fills overlap, it represents a new account rather than a weak broker-name match.
  if (externalId) return newAccountResolution(parsed);

  const broker = textKey(parsed.accountHint?.broker);
  const name = textKey(parsed.accountHint?.name);
  const profile = active.filter(
    (account) =>
      (broker && textKey(account.broker) === broker) || (name && textKey(account.name) === name),
  );
  if (profile.length === 1)
    return { status: "matched", accountId: profile[0]!.id, reason: "profile" };

  if (active.length === 1)
    return { status: "matched", accountId: active[0]!.id, reason: "only-account" };
  if (active.length > 0) return { status: "ambiguous", reason: "ambiguous" };

  return newAccountResolution(parsed);
};

export const createImportAccount = (
  resolution: ImportAccountResolution,
  profile: { accountType: AccountType; profitTargetPct: number | null },
): string => {
  if (resolution.status !== "create" || !resolution.suggestion)
    throw new Error("Import account cannot be created from this resolution.");
  const id = newId();
  db.insert(accounts)
    .values({
      id,
      ...resolution.suggestion,
      kind: "import",
      ...profile,
      profitCalcMethod: "fifo",
      createdAt: nowIso(),
    })
    .run();
  return id;
};

/** Persist exact broker account IDs so future files route without heuristics. */
export const rememberImportAccount = (accountId: string, parsed: ParsedImport): void => {
  const externalId = parsed.accountHint?.externalId?.trim();
  if (!externalId) return;
  const existing = db
    .select({ id: importSourceAliases.id })
    .from(importSourceAliases)
    .where(
      and(
        eq(importSourceAliases.accountId, accountId),
        eq(importSourceAliases.format, parsed.format),
        eq(importSourceAliases.aliasKey, externalId),
      ),
    )
    .get();
  if (existing) return;
  const sourceId = newId();
  db.transaction((tx) => {
    tx.insert(importSources)
      .values({
        id: sourceId,
        accountId,
        format: parsed.format,
        name: externalId,
        createdAt: nowIso(),
      })
      .run();
    tx.insert(importSourceAliases)
      .values({ id: newId(), accountId, format: parsed.format, aliasKey: externalId, sourceId })
      .run();
  });
};
