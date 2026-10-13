import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-opportunities-"));
process.env.JOURNAL_DATA_DIR = scratch;
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const { db, accounts, attachments, executions, missedTrades, trades } = await import("../src/db");
const { insertExecutions } = await import("../src/server/executions");
const workspace = await import("../src/app/api/workspace/[resource]/route");
const attachmentApi = await import("../src/app/api/attachments/route");
const attachmentFileApi = await import("../src/app/api/attachments/[id]/route");

const context = (resource: string) => ({ params: Promise.resolve({ resource }) });
const request = (resource: string, body: unknown) =>
  new Request(`http://localhost/api/workspace/${resource}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv("JOURNAL_PASSWORD", "");
  db.delete(attachments).run();
  db.delete(missedTrades).run();
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(accounts).run();
  db.insert(accounts)
    .values({ id: "account", name: "FTMO", kind: "manual", createdAt: "2026-01-01" })
    .run();
  insertExecutions(
    "account",
    [
      {
        symbol: "EURUSD",
        side: "buy",
        quantity: 1,
        price: 1.1,
        fee: 0,
        executedAt: "2026-10-10T08:00:00Z",
      },
      {
        symbol: "EURUSD",
        side: "sell",
        quantity: 1,
        price: 1.11,
        fee: 0,
        executedAt: "2026-10-10T09:00:00Z",
      },
    ],
    "manual",
  );
});

afterAll(() => {
  db.$client.close();
  vi.unstubAllEnvs();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("opportunities API", () => {
  it("creates a forming setup, then confirms a taken setup and its linked trade", async () => {
    const created = await workspace.POST(
      request("opportunities", {
        accountId: "account",
        symbol: "eurusd",
        direction: "undecided",
        timeframe: "1h",
        status: "forming",
        observedAt: "2026-10-10T07:45:00Z",
        notes: "Wait for confirmation",
      }),
      context("opportunities"),
    );
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const trade = db.select().from(trades).get()!;

    const updated = await workspace.POST(
      request("opportunities", {
        id,
        accountId: "account",
        symbol: "EURUSD",
        direction: "long",
        timeframe: "1h",
        status: "taken",
        observedAt: "2026-10-10T07:45:00Z",
        triggeredAt: "2026-10-10T07:55:00Z",
        linkedTradeKey: trade.key,
        notes: "Confirmed manually",
        reviewed: true,
      }),
      context("opportunities"),
    );
    expect(updated.status).toBe(200);
    expect(db.select().from(missedTrades).get()).toMatchObject({
      id,
      symbol: "EURUSD",
      status: "taken",
      linkedTradeKey: trade.key,
      accountId: "account",
    });
    expect(db.select().from(missedTrades).get()!.reviewedAt).not.toBeNull();
  });

  it("keeps legacy missed-trade posts compatible", async () => {
    const response = await workspace.POST(
      request("missed", {
        symbol: "XAUUSD",
        direction: "short",
        observedAt: "2026-10-11T10:00:00Z",
        notes: "Legacy record",
      }),
      context("missed"),
    );
    expect(response.status).toBe(200);
    expect(db.select().from(missedTrades).get()).toMatchObject({
      status: "missed",
      timeframe: "unknown",
      notes: "Legacy record",
    });
  });

  it("stores multiple capture types through the opportunity alias", async () => {
    const created = await workspace.POST(
      request("opportunities", {
        symbol: "NAS100",
        direction: "short",
        timeframe: "15m",
        status: "triggered",
        observedAt: "2026-10-11T10:00:00Z",
      }),
      context("opportunities"),
    );
    const { id } = (await created.json()) as { id: string };
    const form = new FormData();
    form.set("type", "opportunity");
    form.set("id", id);
    form.set("role", "before");
    form.set(
      "file",
      new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "before.png", {
        type: "image/png",
      }),
    );
    const uploaded = await attachmentApi.POST(
      new Request("http://localhost/api/attachments", { method: "POST", body: form }),
    );
    expect(uploaded.status).toBe(200);
    const linked = await attachmentApi.POST(
      new Request("http://localhost/api/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "opportunity",
          id,
          role: "before",
          url: "https://www.tradingview.com/x/example/",
        }),
      }),
    );
    expect(linked.status).toBe(200);
    const { id: linkId } = (await linked.json()) as { id: string };

    const listed = await attachmentApi.GET(
      new Request(`http://localhost/api/attachments?type=opportunity&id=${id}&role=before`),
    );
    const result = (await listed.json()) as { attachments: Record<string, unknown>[] };
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "before.png", role: "before", mime: "image/png" }),
        expect.objectContaining({
          role: "before",
          sourceUrl: "https://www.tradingview.com/x/example/",
        }),
      ]),
    );
    const redirect = await attachmentFileApi.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: linkId }),
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://www.tradingview.com/x/example/");
  });

  it("rejects non-HTTPS capture links", async () => {
    const row = db
      .insert(missedTrades)
      .values({
        id: "opportunity",
        symbol: "EURUSD",
        direction: "long",
        observedAt: "2026-10-10T08:00:00Z",
        createdAt: "2026-10-10T08:00:00Z",
      })
      .run();
    expect(row.changes).toBe(1);
    const response = await attachmentApi.POST(
      new Request("http://localhost/api/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "opportunity",
          id: "opportunity",
          role: "before",
          url: "http://example.com/image.png",
        }),
      }),
    );
    expect(response.status).toBe(400);
  });
});
