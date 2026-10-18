import { headerKey, parseCsv } from "../csv";
import { parseTimestamp } from "../dates";
import { parseMoney, parseQuantity } from "../numbers";
import type { ImportFormat, ParsedImport } from "../types";

/** Closed-trade CSV with French headings and two positional "Prix" columns. */
export const frenchTradingJournal: ImportFormat = {
  id: "french-trading-journal",
  label: "Trading journal (French closed trades CSV)",
  detect: (headers) => {
    const keys = headers.map(headerKey);
    return (
      keys.includes("ticket") &&
      keys.includes("ouvrir") &&
      keys.includes("fermeture") &&
      keys.includes("symbole") &&
      keys.includes("type") &&
      keys.includes("volume") &&
      keys.includes("swap") &&
      keys.includes("commissions") &&
      keys.includes("profit") &&
      keys.filter((key) => key === "prix").length === 2 &&
      keys.indexOf("ouvrir") < keys.indexOf("prix") &&
      keys.indexOf("prix") < keys.indexOf("fermeture") &&
      keys.indexOf("fermeture") < keys.lastIndexOf("prix")
    );
  },
  parse: (content, options): ParsedImport => {
    const [headers = [], ...rows] = parseCsv(content);
    const keys = headers.map(headerKey);
    const column = (name: string) => keys.indexOf(name);
    const prices = keys.flatMap((key, index) => (key === "prix" ? [index] : []));
    const executions: ParsedImport["executions"] = [];
    let skippedRows = 0;

    for (const cells of rows) {
      const value = (name: string) => cells[column(name)];
      const ticket = value("ticket")?.trim();
      const symbol = value("symbole")?.trim().toUpperCase();
      const side = value("type")?.trim().toLowerCase();
      const quantity = parseQuantity(value("volume"));
      const entryPrice = parseMoney(cells[prices[0]!]);
      const exitPrice = parseMoney(cells[prices[1]!]);
      const openedAt = parseTimestamp(value("ouvrir"), options.timeZone);
      const closedAt = parseTimestamp(value("fermeture"), options.timeZone);
      const profit = parseMoney(value("profit"));
      const commission = value("commissions")?.trim()
        ? parseMoney(value("commissions"))
        : 0;
      const swap = value("swap")?.trim() ? parseMoney(value("swap")) : 0;
      if (
        !ticket ||
        !symbol ||
        (side !== "buy" && side !== "sell") ||
        !(quantity > 0) ||
        !Number.isFinite(entryPrice) ||
        !Number.isFinite(exitPrice) ||
        !openedAt ||
        !closedAt ||
        closedAt < openedAt ||
        !Number.isFinite(profit) ||
        !Number.isFinite(commission) ||
        !Number.isFinite(swap)
      ) {
        skippedRows++;
        continue;
      }

      // Profit is the price P&L; commission and swap are signed adjustments.
      // A positive combined adjustment is a credit, kept in gross P&L.
      const adjustment = commission + swap;
      const fee = Math.max(0, -adjustment);
      const reportedGrossPnl = profit + Math.max(0, adjustment);
      const group = `french-trading-journal:${ticket}:${symbol}:${openedAt}`;
      const entrySide = side === "buy" ? "buy" : "sell";
      executions.push(
        {
          symbol,
          side: entrySide,
          quantity,
          price: entryPrice,
          fee: 0,
          executedAt: openedAt,
          importMetadata: { id: `${ticket}:entry`, group, order: 0, preserveFee: true },
        },
        {
          symbol,
          side: entrySide === "buy" ? "sell" : "buy",
          quantity,
          price: exitPrice,
          fee,
          executedAt: closedAt,
          importMetadata: {
            id: `${ticket}:exit`,
            group,
            order: 1,
            preserveFee: true,
            reportedGrossPnl,
          },
        },
      );
    }

    return {
      format: "french-trading-journal",
      executions,
      skippedRows,
      warnings: [
        "Closed trades were reconstructed as entry and exit executions. Profit, swap and commissions were kept as reported.",
        ...(skippedRows ? [`${skippedRows} invalid trade row(s) were skipped.`] : []),
      ],
    };
  },
};
