import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const previous = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-import-account-"));
process.env.JOURNAL_DATA_DIR = scratch;
vi.stubEnv("JOURNAL_PASSWORD", "");
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
const { POST, GET } = await import("../src/app/api/accounts/route");
const { PATCH } = await import("../src/app/api/accounts/[id]/route");
const { GET: getStats } = await import("../src/app/api/stats/route");
const { accounts, db, executions, trades } = await import("../src/db");
const { insertExecutions } = await import("../src/server/executions");
const { loadDemoData } = await import("../src/server/demo");

it("creates an import destination with the chosen currency/balance and accepts fills under its returned id", async () => {
  const response = await POST(
    new Request("http://localhost/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Import verification",
        kind: "import",
        currency: "USD",
        initialBalance: 50000,
        accountType: "challenge",
        profitTargetPct: 8.5,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const { id } = await response.json();
  const listed = await (await GET(new Request("http://localhost/api/accounts"))).json();
  expect(listed.accounts).toMatchObject([
    {
      id,
      name: "Import verification",
      kind: "import",
      currency: "USD",
      initialBalance: 50000,
      accountType: "challenge",
      profitTargetPct: 8.5,
    },
  ]);
  insertExecutions(
    id,
    [
      {
        symbol: "TEST",
        side: "buy",
        quantity: 10,
        price: 100,
        fee: 0.35,
        executedAt: "2026-01-02T14:30:00Z",
        assetClass: "equity",
      },
      {
        symbol: "TEST",
        side: "sell",
        quantity: 10,
        price: 101,
        fee: 0.35,
        executedAt: "2026-01-02T15:30:00Z",
        assetClass: "equity",
      },
    ],
    "import",
  );
  expect(db.select().from(executions).all()).toHaveLength(2);
  expect(db.select().from(trades).all()).toMatchObject([
    { accountId: id, status: "win", netPnl: 9.3 },
  ]);
  const stats = await (
    await getStats(new Request(`http://localhost/api/stats?accounts=${id}`))
  ).json();
  expect(stats.profitTarget).toEqual({
    pnl: 4250,
    balance: 54250,
    percentage: 8.5,
    currency: "USD",
  });

  const invalid = await PATCH(
    new Request(`http://localhost/api/accounts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ profitTargetPct: null }),
    }),
    { params: Promise.resolve({ id }) },
  );
  expect(invalid.status).toBe(400);

  const funded = await PATCH(
    new Request(`http://localhost/api/accounts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ accountType: "funded" }),
    }),
    { params: Promise.resolve({ id }) },
  );
  expect(funded.status).toBe(200);
  expect(
    (await (await GET(new Request("http://localhost/api/accounts"))).json()).accounts[0],
  ).toMatchObject({ accountType: "funded", profitTargetPct: null });
  expect(
    await (await getStats(new Request(`http://localhost/api/stats?accounts=${id}`))).json(),
  ).toMatchObject({ profitTarget: null });
});

it("requires a configurable target for evaluation account types", async () => {
  const response = await POST(
    new Request("http://localhost/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Missing target",
        kind: "import",
        accountType: "verification",
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "Challenge and verification accounts need a target between 0 and 100%.",
  });
});

it("classifies demo data automatically and normalizes an existing demo account", () => {
  const first = loadDemoData();
  expect(first.alreadyLoaded).toBe(false);
  expect(db.select().from(accounts).where(eq(accounts.id, first.accountId)).get()).toMatchObject({
    accountType: "demo",
    profitTargetPct: null,
    archivedAt: null,
  });

  db.update(accounts)
    .set({ accountType: "challenge", profitTargetPct: 10, archivedAt: "2026-09-30" })
    .where(eq(accounts.id, first.accountId))
    .run();

  expect(loadDemoData()).toMatchObject({
    accountId: first.accountId,
    alreadyLoaded: true,
    inserted: 0,
  });
  expect(db.select().from(accounts).where(eq(accounts.id, first.accountId)).get()).toMatchObject({
    accountType: "demo",
    profitTargetPct: null,
    archivedAt: null,
  });
});

afterAll(() => {
  db.$client.close();
  vi.unstubAllEnvs();
  if (previous === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = previous;
  rmSync(scratch, { recursive: true, force: true });
});
