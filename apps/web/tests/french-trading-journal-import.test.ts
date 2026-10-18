import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-french-csv-"));
process.env.JOURNAL_DATA_DIR = scratch;
const { db, accounts, executions, trades } = await import("../src/db");
const { POST } = await import("../src/app/api/import/route");
const content = `Ticket,Ouvrir,Type,Volume,Symbole,Prix,SL,TP,Fermeture,Prix,Swap,Commissions,Profit,Pips,"Durée du trade en secondes"
123,"2026-10-16 16:52:36",sell,0.28,XAUUSD,4189.44,4192.26,4172.40,"2026-10-16 17:01:05",4192.93,0,-1.64,-97.72,-3.5,509`;
const post = (mode: "preview" | "commit") =>
  POST(
    new Request("http://localhost/api/import", {
      method: "POST",
      body: JSON.stringify({ mode, content, accountId: "test", timeZone: "Europe/Paris" }),
    }),
  );

beforeEach(() => {
  vi.stubEnv("JOURNAL_PASSWORD", "");
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(accounts).run();
  db.insert(accounts)
    .values({ id: "test", name: "Regression", kind: "import", createdAt: "2026-01-01" })
    .run();
});

afterAll(() => {
  vi.unstubAllEnvs();
  db.$client.close();
  if (previousDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = previousDir;
  rmSync(scratch, { recursive: true, force: true });
});

it("previews, imports and deduplicates the French closed-trade CSV", async () => {
  const preview = await post("preview");
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({
    detected: "french-trading-journal",
    totals: { executions: 2, skippedRows: 0 },
  });

  const first = await post("commit");
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ inserted: 2, duplicates: 0 });
  expect(db.select().from(trades).all()).toMatchObject([
    { symbol: "XAUUSD", netPnl: -99.36 },
  ]);

  const repeat = await post("commit");
  expect(await repeat.json()).toMatchObject({ inserted: 0, duplicates: 2 });
  expect(db.select().from(trades).all()).toHaveLength(1);
});
