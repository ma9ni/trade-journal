import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildRoundTrips } from "@luxalgo/journal-core";
import { detectFormat, parseAuto } from "../src/detect";

const csv = `Ticket,Ouvrir,Type,Volume,Symbole,Prix,SL,TP,Fermeture,Prix,Swap,Commissions,Profit,Pips,"Durée du trade en secondes"
123,"2026-10-16 16:52:36",sell,0.28,XAUUSD,4189.44,4192.26,4172.40,"2026-10-16 17:01:05",4192.93,0,-1.64,-97.72,-3.5,509
124,"2026-10-09 10:46:19",sell,0.54,EURJPY,177.839,178.067,176.536,"2026-10-13 11:55:39",176.537,-8.37,-2.7,442.28,130.2,349760
125,"2026-10-09 10:46:19",buy,1,EURUSD,1.10,1.05,1.20,"2026-10-09 11:00:00",1.11,2,-1,10,100,827`;

describe("French closed-trade CSV", () => {
  it("uses both Prix columns and preserves signed adjustments and ticket groups", () => {
    expect(detectFormat(csv)?.id).toBe("french-trading-journal");
    const result = parseAuto(csv, { timeZone: "Europe/Paris" })!;
    expect(result.executions).toHaveLength(6);
    expect(result.skippedRows).toBe(0);
    expect(result.executions[0]).toMatchObject({
      symbol: "XAUUSD",
      side: "sell",
      price: 4189.44,
      executedAt: "2026-10-16T14:52:36.000Z",
    });
    expect(result.executions[1]).toMatchObject({
      side: "buy",
      price: 4192.93,
      fee: 1.64,
      importMetadata: { reportedGrossPnl: -97.72, preserveFee: true },
    });

    const trades = buildRoundTrips(
      result.executions.map((execution, index) => ({
        ...execution,
        id: `csv-${index}`,
        accountId: "a",
        source: "import" as const,
      })),
    );
    expect(trades).toHaveLength(3);
    expect(trades.find((trade) => trade.symbol === "XAUUSD")?.netPnl).toBeCloseTo(-99.36, 2);
    expect(trades.find((trade) => trade.symbol === "EURJPY")?.netPnl).toBeCloseTo(431.21, 2);
    expect(trades.find((trade) => trade.symbol === "EURUSD")?.netPnl).toBeCloseTo(11, 2);
  });

  it("skips malformed rows without inventing prices or profit", () => {
    const result = parseAuto(`${csv}\n126,broken,buy,1,EURUSD,1,,,,1,0,0,5,,`)!;
    expect(result.executions).toHaveLength(6);
    expect(result.skippedRows).toBe(1);
  });

  it.runIf(Boolean(process.env.TRADING_JOURNAL_CSV))(
    "parses the supplied export without losing a trade or its net P&L",
    () => {
      const file = readFileSync(process.env.TRADING_JOURNAL_CSV!, "utf8");
      const result = parseAuto(file, { timeZone: "Europe/Paris" })!;
      expect(result.format).toBe("french-trading-journal");
      expect(result.executions).toHaveLength(16);
      expect(result.skippedRows).toBe(0);
      const trades = buildRoundTrips(
        result.executions.map((execution, index) => ({
          ...execution,
          id: `supplied-${index}`,
          accountId: "a",
          source: "import" as const,
        })),
      );
      expect(trades).toHaveLength(8);
      expect(trades.reduce((total, trade) => total + trade.netPnl, 0)).toBeCloseTo(-155.57, 2);
    },
  );
});
