import { asc, desc, eq } from "drizzle-orm";
import { dayKeyOf } from "@luxalgo/journal-core";
import {
  db,
  noteTemplates,
  progressRules,
  progressChecks,
  missedTrades,
  trades,
  playbooks,
  accounts,
} from "@/db";
import { handler, ok, bad, requireValue } from "@/server/api";
import { newId, nowIso } from "@/server/ids";
import { getJournalDefaults, getTimeZone, setSetting } from "@/server/settings";
import { scheduledRules } from "@/lib/progress";
import { parseJournalDefaults } from "@/lib/journal-defaults";

type Context = { params: Promise<{ resource: string }> };
const today = () => dayKeyOf(nowIso(), getTimeZone());
const rules = () =>
  db
    .select()
    .from(progressRules)
    .orderBy(asc(progressRules.createdAt))
    .all()
    .map((r) => ({ ...r, weekdays: JSON.parse(r.weekdaysJson) as number[] }));
const validDate = (s: unknown): s is string =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !isNaN(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;
const text = (s: unknown, max = 100000): s is string => typeof s === "string" && s.length <= max;
const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
const opportunityStatuses = ["forming", "triggered", "taken", "missed", "invalidated"];
const directions = ["long", "short", "undecided"];
const opportunityResource = (resource: string) =>
  resource === "opportunities" || resource === "missed";

export const GET = handler(async (_request: Request, { params }: Context) => {
  const { resource } = await params;
  if (resource === "templates") return ok({ templates: db.select().from(noteTemplates).all() });
  if (resource === "progress")
    return ok({ rules: rules(), checks: db.select().from(progressChecks).all(), today: today() });
  if (opportunityResource(resource)) {
    const opportunities = db
      .select()
      .from(missedTrades)
      .orderBy(desc(missedTrades.observedAt))
      .all();
    return ok({ opportunities, trades: opportunities });
  }
  if (resource === "defaults") return ok(getJournalDefaults());
  return bad("Unknown resource", 404);
});

export const POST = handler(async (request: Request, { params }: Context) => {
  const { resource } = await params;
  const b = await request.json();
  if (resource === "templates") {
    requireValue(
      text(b.name, 100) && b.name.trim() && text(b.content),
      "A template needs a name and content (up to 100,000 characters).",
    );
    const id = newId();
    db.insert(noteTemplates).values({ id, name: b.name.trim(), content: b.content }).run();
    return ok({ id });
  }
  if (resource === "progress") {
    if (b.ruleId) {
      requireValue(
        validDate(b.date) && b.date <= today() && typeof b.done === "boolean",
        "Choose a valid date up to today.",
      );
      requireValue(
        scheduledRules(rules(), b.date).some((r) => r.id === b.ruleId),
        "This routine is not scheduled on that date.",
      );
      const id = `${b.ruleId}:${b.date}`;
      db.insert(progressChecks)
        .values({ id, ruleId: b.ruleId, date: b.date, done: b.done })
        .onConflictDoUpdate({ target: progressChecks.id, set: { done: b.done } })
        .run();
      return ok({ saved: true });
    }
    requireValue(
      text(b.title, 200) &&
        b.title.trim() &&
        ["Before trading", "During trading", "After trading"].includes(b.stage),
      "Enter a routine title and stage.",
    );
    requireValue(
      Array.isArray(b.weekdays) &&
        b.weekdays.length > 0 &&
        b.weekdays.every((n: unknown) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 6),
      "Select at least one weekday.",
    );
    const id = newId();
    db.insert(progressRules)
      .values({
        id,
        title: b.title.trim(),
        stage: b.stage,
        weekdaysJson: JSON.stringify([...new Set(b.weekdays)]),
        createdAt: today(),
      })
      .run();
    return ok({ id });
  }
  if (opportunityResource(resource)) {
    const status = b.status ?? (resource === "missed" ? "missed" : "forming");
    const direction = b.direction ?? "undecided";
    const timeframe = b.timeframe ?? "unknown";
    requireValue(
      text(b.symbol, 80) && b.symbol.trim() && directions.includes(direction),
      "Enter a symbol and direction.",
    );
    requireValue(opportunityStatuses.includes(status), "Choose a valid opportunity status.");
    requireValue(
      text(timeframe, 20) && (timeframe === "unknown" || /^[1-9]\d*(m|h|d|w)$/.test(timeframe)),
      "Enter a valid timeframe such as 5m, 1h or 1d.",
    );
    requireValue(
      status === "forming" || status === "invalidated" || direction !== "undecided",
      "Choose a direction once the setup is triggered.",
    );
    requireValue(
      text(b.observedAt, 40) && !isNaN(Date.parse(b.observedAt)),
      "Enter a valid observation time.",
    );
    requireValue(
      b.triggeredAt == null || (text(b.triggeredAt, 40) && !isNaN(Date.parse(b.triggeredAt))),
      "Enter a valid trigger time.",
    );
    requireValue(
      text(b.notes ?? "") && text(b.missedReason ?? "", 500),
      "Notes or reason are too long.",
    );
    for (const key of ["entry", "stop", "target"])
      requireValue(b[key] == null || finite(b[key]), `Invalid ${key} price.`);
    requireValue(
      !b.playbookId || db.select().from(playbooks).where(eq(playbooks.id, b.playbookId)).get(),
      "Strategy not found.",
    );
    requireValue(
      !b.accountId || db.select().from(accounts).where(eq(accounts.id, b.accountId)).get(),
      "Account not found.",
    );
    const linkedTrade = b.linkedTradeKey
      ? db.select().from(trades).where(eq(trades.key, b.linkedTradeKey)).get()
      : null;
    requireValue(!b.linkedTradeKey || linkedTrade, "Linked trade not found.");
    requireValue(
      !linkedTrade || !b.accountId || linkedTrade.accountId === b.accountId,
      "The linked trade belongs to another account.",
    );
    const existing = b.id
      ? db.select().from(missedTrades).where(eq(missedTrades.id, b.id)).get()
      : null;
    const values = {
      accountId: b.accountId || null,
      symbol: b.symbol.trim().toUpperCase(),
      direction,
      timeframe,
      status,
      observedAt: new Date(b.observedAt).toISOString(),
      triggeredAt: b.triggeredAt ? new Date(b.triggeredAt).toISOString() : null,
      playbookId: b.playbookId || null,
      entry: b.entry ?? null,
      stop: b.stop ?? null,
      target: b.target ?? null,
      linkedTradeKey: b.linkedTradeKey || null,
      missedReason: b.missedReason ?? "",
      notes: b.notes ?? "",
      reviewedAt:
        b.reviewed === true
          ? (existing?.reviewedAt ?? nowIso())
          : b.reviewed === false
            ? null
            : (existing?.reviewedAt ?? null),
    };
    if (b.id) {
      requireValue(existing, "Opportunity not found.");
      db.update(missedTrades).set(values).where(eq(missedTrades.id, b.id)).run();
      return ok({ id: b.id });
    }
    const id = newId();
    db.insert(missedTrades)
      .values({ id, ...values, createdAt: nowIso() })
      .run();
    return ok({ id });
  }
  if (resource === "defaults") {
    const known = new Set(
      db
        .select({ id: accounts.id })
        .from(accounts)
        .all()
        .map((a) => a.id),
    );
    const parsed = parseJournalDefaults(b, (id) => known.has(id));
    if (parsed.error !== undefined) return bad(parsed.error);
    setSetting("journalDefaults", JSON.stringify(parsed.defaults));
    return ok({ saved: true });
  }
  return bad("Unknown resource", 404);
});

export const DELETE = handler(async (request: Request, { params }: Context) => {
  const { resource } = await params;
  const b = await request.json();
  requireValue(text(b.id, 200), "Invalid id.");
  if (resource === "templates") db.delete(noteTemplates).where(eq(noteTemplates.id, b.id)).run();
  else if (resource === "progress")
    db.update(progressRules).set({ archivedAt: today() }).where(eq(progressRules.id, b.id)).run();
  else if (opportunityResource(resource))
    db.update(missedTrades)
      .set({ archivedAt: b.restore ? null : nowIso() })
      .where(eq(missedTrades.id, b.id))
      .run();
  else return bad("Unknown resource", 404);
  return ok({ saved: true });
});
