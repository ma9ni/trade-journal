import { hasHeaders, parseCsv, pick, toRecords, type Row } from "../csv";
import { parseTimestamp } from "../dates";
import { parseMoney, parseQuantity } from "../numbers";
import type { ImportFormat, ImportedExecution, ImportOptions, ParsedImport } from "../types";
import { parseSide } from "./fills";

const REQUIRED = [
  ["symbol"],
  ["side"],
  ["qty"],
  ["fillprice"],
  ["profit"],
  ["swap"],
  ["datetime"],
  ["commission"],
  ["tradeid"],
  ["positionid"],
];

interface ParsedRow {
  row: Row;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
  reportedGrossPnl: number;
  executedAt: string;
  tradeId: string;
  positionId: string;
}

const parseRow = (row: Row, options: ImportOptions): ParsedRow | null => {
  const symbol = pick(row, ["symbol"])?.trim().toUpperCase();
  const side = parseSide(pick(row, ["side"]));
  const quantity = parseQuantity(pick(row, ["qty"]));
  const price = parseMoney(pick(row, ["fillprice"]));
  const executedAt = parseTimestamp(pick(row, ["datetime"]), options.timeZone);
  const tradeId = pick(row, ["tradeid"]);
  const positionId = pick(row, ["positionid"]);
  if (
    !symbol ||
    !side ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(price) ||
    !executedAt ||
    !tradeId ||
    !positionId
  )
    return null;

  const commission = parseMoney(pick(row, ["commission"]));
  const profit = parseMoney(pick(row, ["profit"]));
  const swap = parseMoney(pick(row, ["swap"]));
  return {
    row,
    symbol,
    side,
    quantity,
    price,
    fee: Number.isFinite(commission) ? Math.abs(commission) : 0,
    // The5ers reports Profit before commission and Swap separately.
    reportedGrossPnl: (Number.isFinite(profit) ? profit : 0) + (Number.isFinite(swap) ? swap : 0),
    executedAt,
    tradeId,
    positionId,
  };
};

const parse = (content: string, options: ImportOptions): ParsedImport => {
  const records = toRecords(parseCsv(content));
  const groups = new Map<string, ParsedRow[]>();
  let skippedRows = 0;
  for (const record of records) {
    const parsed = parseRow(record, options);
    if (!parsed) {
      skippedRows++;
      continue;
    }
    const group = groups.get(parsed.positionId);
    if (group) group.push(parsed);
    else groups.set(parsed.positionId, [parsed]);
  }

  const executions: ImportedExecution[] = [];
  const warnings: string[] = [];
  for (const [positionId, rows] of groups) {
    rows.sort(
      (a, b) => a.executedAt.localeCompare(b.executedAt) || a.tradeId.localeCompare(b.tradeId),
    );
    const symbols = new Set(rows.map((row) => row.symbol));
    if (symbols.size !== 1) {
      skippedRows += rows.length;
      warnings.push(`Position ${positionId} contains multiple symbols and was skipped.`);
      continue;
    }
    const grossPnl = rows.reduce((total, row) => total + row.reportedGrossPnl, 0);
    rows.forEach((row, order) => {
      const closing = order === rows.length - 1;
      executions.push({
        symbol: row.symbol,
        side: row.side,
        quantity: row.quantity,
        price: row.price,
        fee: row.fee,
        executedAt: row.executedAt,
        assetClass: "cfd",
        importMetadata: {
          id: row.tradeId,
          group: `the5ers-tradingview:${positionId}`,
          order,
          ...(closing ? { reportedGrossPnl: grossPnl } : {}),
          preserveFee: true,
        },
      });
    });
  }

  executions.sort(
    (a, b) =>
      a.executedAt.localeCompare(b.executedAt) ||
      (a.importMetadata?.group ?? "").localeCompare(b.importMetadata?.group ?? "") ||
      (a.importMetadata?.order ?? 0) - (b.importMetadata?.order ?? 0),
  );
  return {
    format: "the5ers-tradingview",
    executions,
    skippedRows,
    warnings,
    accountHint: { broker: "The5ers", name: "The5ers TradingView" },
  };
};

/** The5ers Trade History exported by its embedded TradingView account manager. */
export const the5ersTradingView: ImportFormat = {
  id: "the5ers-tradingview",
  label: "The5ers (TradingView trade history)",
  detect: (headers) => hasHeaders(headers, REQUIRED),
  parse,
};
