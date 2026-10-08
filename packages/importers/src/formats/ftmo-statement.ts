import { headerKey, parseCsv, toRecords } from "../csv";
import { parseTimestamp } from "../dates";
import { parseMoney } from "../numbers";
import type { ImportFormat, ImportedExecution, ImportOptions, ParsedImport } from "../types";

const sectionIndex = (rows: string[][], name: string): number =>
  rows.findIndex((row) => row.length === 1 && row[0]?.trim().toLowerCase() === name.toLowerCase());

const recordsBetween = (rows: string[][], section: string, nextSection: string) => {
  const start = sectionIndex(rows, section);
  const end = sectionIndex(rows, nextSection);
  if (start < 0 || end < 0 || end <= start + 1) return [];
  return toRecords([rows[start + 1]!, ...rows.slice(start + 2, end)]);
};

const offsetFromHeader = (header: string | undefined): string | undefined => {
  const match = header?.match(/UTC\s*([+-])\s*(\d{1,2})(?::(\d{2}))?/i);
  if (!match) return undefined;
  return `${match[1]}${match[2]!.padStart(2, "0")}:${(match[3] ?? "00").padStart(2, "0")}`;
};

const parseClosingTime = (
  value: string | undefined,
  offset: string | undefined,
  options: ImportOptions,
) => (value ? parseTimestamp(offset ? `${value} ${offset}` : value, options.timeZone) : null);

const quantity = (value: string | undefined): number => {
  const parsed = parseMoney(value?.replace(/[^\d.,()\-]/g, ""));
  return Number.isFinite(parsed) ? Math.abs(parsed) : NaN;
};

const accountSizeLabel = (amount: number): string => {
  if (amount >= 1_000 && Number.isInteger(amount / 1_000)) return `${amount / 1_000}K`;
  return amount.toLocaleString("en-US", { maximumFractionDigits: 0, useGrouping: false });
};

const parse = (content: string, options: ImportOptions): ParsedImport => {
  const rows = parseCsv(content);
  const dealsAt = sectionIndex(rows, "Deals");
  const transactionsAt = sectionIndex(rows, "Transactions");
  const summaryAt = sectionIndex(rows, "Summary");
  const dealHeader = dealsAt >= 0 ? rows[dealsAt + 1] : undefined;
  const dealRecords = recordsBetween(rows, "Deals", "Transactions");
  const transactionRecords = recordsBetween(rows, "Transactions", "Summary");
  const summaryRecords =
    summaryAt >= 0 && rows[summaryAt + 1] && rows[summaryAt + 2]
      ? toRecords([rows[summaryAt + 1]!, rows[summaryAt + 2]!])
      : [];
  const closingHeader = dealHeader?.find((header) => headerKey(header).startsWith("closingtime"));
  const offset = offsetFromHeader(closingHeader);
  const currency =
    dealHeader
      ?.map((header) => header.match(/(?:Net|Balance)\s+([A-Z]{3})/i)?.[1]?.toUpperCase())
      .find(Boolean) ?? "USD";

  const initialTransaction = transactionRecords.find(
    (row) =>
      /deposit/i.test(row["transactiontype"] ?? "") &&
      /initial account balance/i.test(row["note"] ?? ""),
  );
  const externalId = initialTransaction?.["id"]?.trim();
  const initialBalance = parseMoney(initialTransaction?.[`gross${currency.toLowerCase()}`]);
  const executions: ImportedExecution[] = [];
  const warnings = [
    "This statement reports closing times only; reconstructed entry and exit executions use the reported closing timestamp, so holding duration is unavailable.",
  ];
  const errors: string[] = [];
  let skippedRows = 0;
  let netTotal = 0;

  dealRecords.forEach((row, index) => {
    const symbol = row["symbol"]?.trim().toUpperCase();
    // The section's final totals row has no symbol and is not a malformed deal.
    if (!symbol) return;
    const directionText = row["openingdirection"]?.trim().toLowerCase();
    const direction = directionText === "buy" ? "long" : directionText === "sell" ? "short" : null;
    const closedAt = parseClosingTime(row[headerKey(closingHeader ?? "")], offset, options);
    const entryPrice = parseMoney(row["entryprice"]);
    const exitPrice = parseMoney(row["closingprice"]);
    const size = quantity(row["closingquantity"]);
    const netPnl = parseMoney(row[`net${currency.toLowerCase()}`]);
    if (
      !direction ||
      !closedAt ||
      !Number.isFinite(entryPrice) ||
      !Number.isFinite(exitPrice) ||
      !Number.isFinite(size) ||
      size <= 0 ||
      !Number.isFinite(netPnl)
    ) {
      skippedRows++;
      return;
    }
    netTotal += netPnl;
    const group = `prop-statement:${symbol}:${direction}:${closedAt}:${size}:${entryPrice}:${exitPrice}`;
    const entrySide = direction === "long" ? "buy" : "sell";
    executions.push(
      {
        symbol,
        side: entrySide,
        quantity: size,
        price: entryPrice,
        fee: 0,
        executedAt: closedAt,
        assetClass: "cfd",
        importMetadata: {
          id: `entry-${index}`,
          group,
          order: 0,
          openedAtKnown: false,
          preserveFee: true,
        },
      },
      {
        symbol,
        side: entrySide === "buy" ? "sell" : "buy",
        quantity: size,
        price: exitPrice,
        fee: 0,
        executedAt: closedAt,
        assetClass: "cfd",
        importMetadata: {
          id: `exit-${index}`,
          group,
          order: 1,
          openedAtKnown: false,
          reportedGrossPnl: netPnl,
          preserveFee: true,
        },
      },
    );
  });

  const realised = parseMoney(summaryRecords[0]?.["realisedpl"]);
  if (Number.isFinite(realised) && Math.abs(realised - netTotal) > 0.011)
    errors.push(
      `Deal P&L (${netTotal.toFixed(2)} ${currency}) does not reconcile with the statement summary (${realised.toFixed(2)} ${currency}).`,
    );
  if (!executions.length && !errors.length)
    errors.push("No complete deals were found in this statement.");

  const safeInitialBalance =
    Number.isFinite(initialBalance) && initialBalance >= 0 ? initialBalance : undefined;
  const accountName = `FTMO${safeInitialBalance !== undefined ? ` ${accountSizeLabel(safeInitialBalance)}` : ""}${externalId ? ` - ${externalId}` : ""}`;
  return {
    format: "prop-statement",
    executions: errors.length ? [] : executions,
    skippedRows,
    warnings,
    ...(errors.length ? { errors } : {}),
    accountHint: {
      broker: "FTMO",
      name: accountName,
      currency,
      ...(externalId ? { externalId } : {}),
      ...(safeInitialBalance !== undefined ? { initialBalance: safeInitialBalance } : {}),
    },
  };
};

/** FTMO web statement: Deals, Transactions, Summary and Balance sections. */
export const propStatement: ImportFormat = {
  id: "prop-statement",
  label: "Prop trading account statement",
  detect: (_headers, content) => {
    const rows = parseCsv(content);
    const dealsAt = sectionIndex(rows, "Deals");
    const keys = new Set((dealsAt >= 0 ? (rows[dealsAt + 1] ?? []) : []).map(headerKey));
    return (
      sectionIndex(rows, "Transactions") > dealsAt &&
      sectionIndex(rows, "Summary") > dealsAt &&
      ["symbol", "openingdirection", "entryprice", "closingprice", "closingquantity"].every((key) =>
        keys.has(key),
      ) &&
      [...keys].some((key) => key.startsWith("closingtime")) &&
      [...keys].some((key) => key.startsWith("net"))
    );
  },
  parse,
};
