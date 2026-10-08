import { eq } from "drizzle-orm";
import { accounts, db, executions, trades } from "@/db";
import { bad, handler, ok, requireValue } from "@/server/api";
import { rebuildAccount } from "@/server/rebuild";
import { hasSyncedExecutions, isIbkrSyncAccount } from "@/server/ibkr-sync-timezone";
import {
  isAccountType,
  needsProfitTarget,
  validProfitTarget,
  type AccountType,
} from "@/lib/account-profile";

type Params = { params: Promise<{ id: string }> };

interface PatchBody {
  name?: string;
  broker?: string;
  currency?: string;
  initialBalance?: number;
  accountType?: AccountType;
  profitTargetPct?: number | null;
  profitCalcMethod?: "fifo" | "lifo" | "wavg";
  autoSync?: boolean;
}

export const PATCH = handler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const account = db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!account) return bad("Account not found", 404);

  const body = (await request.json()) as PatchBody;
  const patch: Partial<typeof accounts.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.broker !== undefined) patch.broker = body.broker;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.initialBalance !== undefined) patch.initialBalance = body.initialBalance;
  if (body.autoSync !== undefined) patch.autoSync = body.autoSync;
  if (body.profitCalcMethod !== undefined) patch.profitCalcMethod = body.profitCalcMethod;

  const nextAccountType = body.accountType ?? account.accountType;
  const nextProfitTarget =
    body.profitTargetPct !== undefined ? body.profitTargetPct : account.profitTargetPct;
  if (!isAccountType(nextAccountType)) return bad("Invalid account type");
  if (needsProfitTarget(nextAccountType) && !validProfitTarget(nextProfitTarget))
    return bad("Challenge and verification accounts need a target between 0 and 100%.");
  if (body.accountType !== undefined) patch.accountType = nextAccountType;
  if (needsProfitTarget(nextAccountType)) {
    if (body.profitTargetPct !== undefined) patch.profitTargetPct = body.profitTargetPct;
  } else if (body.accountType !== undefined || body.profitTargetPct !== undefined) {
    patch.profitTargetPct = null;
  }

  db.transaction(
    () => {
      const current = db.select().from(accounts).where(eq(accounts.id, id)).get();
      requireValue(current, "Account not found.");
      if (
        body.broker !== undefined &&
        body.broker !== current.broker &&
        isIbkrSyncAccount(current)
      ) {
        requireValue(
          !hasSyncedExecutions(id),
          "An IBKR account with synced history cannot change brokers. Connect a separate account to preserve its timestamp history.",
        );
      }
      if (Object.keys(patch).length > 0) {
        db.update(accounts).set(patch).where(eq(accounts.id, id)).run();
      }
      // A new profit-calc method changes per-exit attribution — recompute.
      if (body.profitCalcMethod && body.profitCalcMethod !== current.profitCalcMethod) {
        rebuildAccount(id);
      }
    },
    { behavior: "immediate" },
  );
  return ok({ updated: true });
});

export const DELETE = handler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  db.transaction((tx) => {
    tx.delete(trades).where(eq(trades.accountId, id)).run();
    tx.delete(executions).where(eq(executions.accountId, id)).run();
    tx.delete(accounts).where(eq(accounts.id, id)).run();
  });
  return ok({ deleted: true });
});
