import { parseTimestamp } from "../dates";
import { extractHtmlTables } from "../history/html";
import { parseMoney, parseQuantity } from "../numbers";
import type { ImportFormat, ImportedExecution, ImportOptions, ParsedImport } from "../types";

const CLOSED_HEADER = [
  "Ticket #",
  "Symbol",
  "Volume",
  "Date",
  "Sold",
  "Bought",
  "Gross P/L",
  "Markups (pips)",
  "Comm",
  "Dividends",
  "Rollover",
  "Adj",
  "Net P/L",
  "Condition",
  "Created By",
];

const sameHeader = (cells: readonly string[]): boolean =>
  CLOSED_HEADER.every((header, index) => cells[index]?.trim() === header);

const labelKey = (value: string): string => value.replace(/\s+/g, "").toLowerCase();

const quotedPrintable = (body: string): string => {
  const input = body.replace(/=\r?\n/g, "");
  return input.replace(/(?:=[0-9a-f]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded.replaceAll("=", "%"));
    } catch {
      return encoded.replace(/=([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
  });
};

/** Extract the HTML document from Chrome/Edge's multipart MHTML save format. */
const statementHtml = (content: string): string | null => {
  if (/^\s*</.test(content) && /name=["']closed_trades["']/i.test(content)) return content;
  const boundary = content
    .match(/boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i)
    ?.slice(1)
    .find(Boolean);
  const partAt = content.search(/(?:^|\r?\n)Content-Type:\s*text\/html\b/i);
  if (partAt < 0) return null;
  const headerEnd = content.slice(partAt).search(/\r?\n\r?\n/);
  if (headerEnd < 0) return null;
  const separator = content.slice(partAt + headerEnd).match(/^\r?\n\r?\n/)?.[0] ?? "";
  const bodyAt = partAt + headerEnd + separator.length;
  const boundaryAt = boundary
    ? content.indexOf(`\r\n--${boundary}`, bodyAt) >= 0
      ? content.indexOf(`\r\n--${boundary}`, bodyAt)
      : content.indexOf(`\n--${boundary}`, bodyAt)
    : -1;
  const body = content.slice(bodyAt, boundaryAt >= 0 ? boundaryAt : undefined);
  const headers = content.slice(partAt, partAt + headerEnd);
  return /Content-Transfer-Encoding:\s*quoted-printable/i.test(headers)
    ? quotedPrintable(body)
    : body;
};

const normalizedSymbol = (value: string): string => value.trim().toUpperCase().replaceAll("/", "");

const parse = (content: string, options: ImportOptions): ParsedImport => {
  const html = statementHtml(content);
  const errors: string[] = [];
  if (!html) {
    return {
      format: "fxcm-statement",
      executions: [],
      skippedRows: 0,
      warnings: [],
      errors: ["The FXCM statement does not contain a readable HTML document."],
    };
  }

  const extracted = extractHtmlTables(html);
  const tables = extracted.tables.map((table) => table.records);
  const closed = tables.find((records) => records.some((record) => sameHeader(record.cells)));
  const accountRow = tables
    .flat()
    .find((record) => record.cells.some((cell) => labelKey(cell) === "tradeaccount#:"))?.cells;
  const summary = tables.find((records) =>
    records.some((record) => record.cells.some((cell) => cell.trim() === "Beginning Balance")),
  );
  const accountIndex = accountRow?.findIndex((cell) => labelKey(cell) === "tradeaccount#:") ?? -1;
  const currencyIndex = accountRow?.findIndex((cell) => labelKey(cell) === "basecurrency:") ?? -1;
  const externalId = accountIndex >= 0 ? accountRow?.[accountIndex + 1]?.trim() : undefined;
  const currency =
    (currencyIndex >= 0 ? accountRow?.[currencyIndex + 1]?.trim().toUpperCase() : undefined) ||
    "USD";
  const beginningRow = summary?.find((record) =>
    record.cells.some((cell) => cell.trim() === "Beginning Balance"),
  )?.cells;
  const beginningLabelAt =
    beginningRow?.findIndex((cell) => cell.trim() === "Beginning Balance") ?? -1;
  const beginningBalance =
    beginningLabelAt >= 0 ? parseMoney(beginningRow?.[beginningLabelAt + 1]) : Number.NaN;
  const cashMovementLabels = new Set(["deposit", "withdrawal", "fundstransfer"]);
  const cashMovements = (summary ?? []).reduce((total, record) => {
    const labelAt = record.cells.findIndex((cell) => cashMovementLabels.has(labelKey(cell)));
    if (labelAt < 0) return total;
    const amount = parseMoney(record.cells[labelAt + 1]);
    return Number.isFinite(amount) ? total + amount : total;
  }, 0);
  const initialBalance = Number.isFinite(beginningBalance)
    ? beginningBalance + cashMovements
    : Number.NaN;

  if (!closed) errors.push("No FXCM closed-trade table was found in this statement.");
  if (!externalId) errors.push("The FXCM account number is missing from this statement.");

  const executions: ImportedExecution[] = [];
  let skippedRows = 0;
  let netTotal = 0;
  let statedNet: number | undefined;
  if (closed) {
    const headerAt = closed.findIndex((record) => sameHeader(record.cells));
    const records = closed.slice(headerAt + 1);
    for (let index = 0; index < records.length; index++) {
      const opening = records[index]!.cells;
      if (opening[0]?.trim() === "Total:") {
        const value = opening
          .map(parseMoney)
          .find((number, cell) => cell > 0 && Number.isFinite(number));
        statedNet = value;
        break;
      }
      if (opening.length !== CLOSED_HEADER.length || !/^\d+$/.test(opening[0]?.trim() ?? ""))
        continue;
      const closing = records[index + 1]?.cells;
      index++;
      const openingSold = parseMoney(opening[4]);
      const openingBought = parseMoney(opening[5]);
      const direction = Number.isFinite(openingBought)
        ? "long"
        : Number.isFinite(openingSold)
          ? "short"
          : null;
      const entryPrice = direction === "long" ? openingBought : openingSold;
      const exitPrice = direction === "long" ? parseMoney(closing?.[4]) : parseMoney(closing?.[5]);
      const quantity = parseQuantity(opening[2]);
      const openedAt = parseTimestamp(opening[3], options.timeZone);
      const closedAt = parseTimestamp(closing?.[3], options.timeZone);
      const grossPnl = parseMoney(closing?.[6]);
      const netPnl = parseMoney(closing?.[12]);
      const ticket = opening[0]!.trim();
      const symbol = normalizedSymbol(opening[1] ?? "");
      if (
        !closing ||
        !direction ||
        !symbol ||
        !openedAt ||
        !closedAt ||
        !Number.isFinite(entryPrice) ||
        !Number.isFinite(exitPrice) ||
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(grossPnl) ||
        !Number.isFinite(netPnl)
      ) {
        skippedRows++;
        continue;
      }
      netTotal += netPnl;
      const fee = Math.max(0, grossPnl - netPnl);
      const reportedGrossPnl = netPnl + fee;
      const group = `fxcm:${externalId ?? "unknown"}:${ticket}`;
      const entrySide = direction === "long" ? "buy" : "sell";
      const assetClass = /^[A-Z]{6}$/.test(symbol) ? "forex" : "cfd";
      executions.push(
        {
          symbol,
          side: entrySide,
          quantity,
          price: entryPrice,
          fee: 0,
          executedAt: openedAt,
          assetClass,
          importMetadata: { id: `${ticket}:open`, group, order: 0, preserveFee: true },
        },
        {
          symbol,
          side: entrySide === "buy" ? "sell" : "buy",
          quantity,
          price: exitPrice,
          fee,
          executedAt: closedAt,
          assetClass,
          importMetadata: {
            id: `${ticket}:close`,
            group,
            order: 1,
            reportedGrossPnl,
            preserveFee: true,
          },
        },
      );
    }
  }

  // The FXCM total row places Gross P/L first and Net P/L later. Read the
  // explicit Net P/L by locating the final numeric value in that compact row.
  const totalRow = closed?.find((record) => record.cells[0]?.trim() === "Total:")?.cells;
  if (totalRow) {
    const values = totalRow.slice(1).map(parseMoney).filter(Number.isFinite);
    statedNet = values.at(-1);
  }
  if (statedNet !== undefined && Math.abs(statedNet - netTotal) > 0.011)
    errors.push(
      `Closed-trade P&L (${netTotal.toFixed(2)} ${currency}) does not reconcile with the FXCM total (${statedNet.toFixed(2)} ${currency}).`,
    );
  if (!executions.length && !errors.length) errors.push("No complete closed trades were found.");

  return {
    format: "fxcm-statement",
    executions: errors.length ? [] : executions,
    skippedRows,
    warnings: [
      "FXCM closed positions are reconstructed as entry and exit executions from each ticket; commissions, dividends, rollover and adjustments are included in the reported net P&L.",
      ...(cashMovements !== 0
        ? [
            `Cash deposits, withdrawals and transfers (${cashMovements.toFixed(2)} ${currency} net) are included in the account's starting capital.`,
          ]
        : []),
    ],
    ...(errors.length ? { errors } : {}),
    accountHint: {
      broker: "FXCM",
      ...(externalId ? { externalId, name: `FXCM - ${externalId}` } : {}),
      currency,
      ...(Number.isFinite(initialBalance) && initialBalance >= 0 ? { initialBalance } : {}),
    },
  };
};

/** FXCM Combined Account Statement saved by Chrome/Edge as MHTML or raw HTML. */
export const fxcmStatement: ImportFormat = {
  id: "fxcm-statement",
  label: "FXCM combined account statement",
  detect: (_headers, content) => {
    const head = content.slice(0, 100_000);
    return (
      (/REPORT_NAME_CUSTOMER_ACCOUNT_STATEMENT/i.test(head) ||
        /Subject:\s*Combined Account Statement/i.test(head) ||
        /name=["']closed_trades["']/i.test(head)) &&
      /FXCM|fxcorporate\.com|closed_trades/i.test(head)
    );
  },
  parse,
};
