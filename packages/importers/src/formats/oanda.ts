import { makeFillsFormat } from "./fills";
import { pick } from "../csv";
import { parseQuantity } from "../numbers";
import type { ImportFormat } from "../types";

/**
 * OANDA order history export (from TradingView broker integration or OANDA web portal).
 * Supports both French and English column headers:
 * - French: Symbole, Côté, Type, Qté, Quantité remplie, Limite de Prix, Prix d’arrêt,
 *   Prix moyen de la transaction, Statut, Mettre à jour l’heure, Nom, Prix du Take Profit,
 *   Prix du Stop Loss, Commission, Stop loss garanti, Numéro de commande
 * - English: Symbol, Side, Type, Qty, Filled Qty, Price Limit, Stop Price,
 *   Average Execution Price, Status, Update Time, Name, Take Profit Price,
 *   Stop Loss Price, Commission, Guaranteed Stop Loss, Order Number
 */
const oandaFills = makeFillsFormat({
  id: "oanda",
  label: "OANDA (orders export)",
  required: [
    ["symbol", "symbole", "nom", "name"],
    ["side", "cote", "ct", "sens"],
    [
      "prixmoyendelatransaction",
      "averageexecutionprice",
      "avgexecutionprice",
      "averageprice",
      "avgfillprice",
      "avgprice",
    ],
    ["quantiteremplie", "quantitremplie", "filledqty", "filledquantity", "filled"],
    ["statut", "status"],
  ],
  columns: {
    symbol: ["symbole", "symbol", "nom", "name"],
    side: ["cote", "ct", "side", "sens"],
    quantity: [
      "quantiteremplie",
      "quantitremplie",
      "filledqty",
      "filledquantity",
      "filled",
      "qte",
      "qt",
      "qty",
      "quantity",
    ],
    price: [
      "prixmoyendelatransaction",
      "averageexecutionprice",
      "avgexecutionprice",
      "averageprice",
      "avgfillprice",
      "avgprice",
      "prix",
      "price",
    ],
    fees: [["commission"], ["commissions"], ["frais", "fees"]],
    timestamp: [
      "mettreajourlheure",
      "updatetime",
      "updatedtime",
      "updated",
      "time",
      "datetime",
      "date",
    ],
  },
  rowFilter: (row) => {
    const status = pick(row, ["statut", "status"])?.toLowerCase() ?? "";
    if (status && !/^(rempli|filled)$/i.test(status)) return false;
    const filledQty = pick(row, [
      "quantiteremplie",
      "quantitremplie",
      "filledqty",
      "filledquantity",
      "filled",
    ]);
    if (filledQty !== undefined) {
      const qty = parseQuantity(filledQty);
      if (!Number.isFinite(qty) || qty <= 0) return false;
    }
    return true;
  },
  normalizeSymbol: (symbol) => symbol.split(":").pop()!.trim().toUpperCase(),
  account: { broker: "OANDA", namePrefix: "OANDA", externalId: ["account", "compte", "accountid"] },
});

export const oanda: ImportFormat = {
  ...oandaFills,
  parse: (content, options) => {
    const result = oandaFills.parse(content, options);
    return {
      ...result,
      warnings: [
        ...result.warnings,
        "This is an order history, not a trade statement. Update time may differ from execution time, and realized P&L and swap are absent. Do not add it to an account that already contains these trades from a closed-trade export.",
      ],
    };
  },
};
