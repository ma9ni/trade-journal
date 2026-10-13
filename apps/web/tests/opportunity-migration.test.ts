import Database from "better-sqlite3";
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-opportunity-migration-"));
process.env.JOURNAL_DATA_DIR = scratch;

const legacy = new Database(join(scratch, "journal.db"));
legacy.exec(`
  CREATE TABLE missed_trades (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    playbook_id TEXT,
    entry REAL,
    stop REAL,
    target REAL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    archived_at TEXT
  );
  INSERT INTO missed_trades
    (id, symbol, direction, observed_at, notes, created_at)
  VALUES
    ('legacy', 'EURUSD', 'long', '2026-09-01T10:00:00Z', 'kept', '2026-09-01T10:00:00Z');
`);
legacy.close();

const { db, missedTrades } = await import("../src/db");

afterAll(() => {
  db.$client.close();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

it("upgrades legacy missed trades before creating the opportunity index", () => {
  expect(db.select().from(missedTrades).get()).toMatchObject({
    id: "legacy",
    status: "missed",
    timeframe: "unknown",
    notes: "kept",
  });
  const indexes = db.$client.pragma("index_list(missed_trades)") as { name: string }[];
  expect(indexes.map((index) => index.name)).toContain("missed_trades_status_date");
});
