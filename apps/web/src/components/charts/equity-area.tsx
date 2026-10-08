"use client";

import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtMoney, fmtPercent } from "@/lib/utils";
import { usePrivacy } from "../privacy";
import { tooltipStyle, useVizTokens } from "./tokens";
import { ChartFrame } from "./chart-frame";

export interface EquityPointDatum {
  t: string;
  cumNetPnl: number;
}

export interface EquityTarget {
  pnl: number;
  balance: number;
}

/** Cumulative P&L area — single series, crosshair tooltip, zero baseline. */
export function EquityArea({
  data,
  height = 240,
  valueFormat = "money",
  valueLabel = "Cumulative P&L",
  currency = "USD",
  curve = "monotone",
  target = null,
}: {
  data: EquityPointDatum[];
  height?: number;
  valueFormat?: "money" | "percent";
  valueLabel?: string;
  currency?: string;
  curve?: "monotone" | "stepAfter";
  target?: EquityTarget | null;
}) {
  const t = useVizTokens();
  const id = useId().replace(/:/g, "");
  const privacy = usePrivacy();
  const privateMode = privacy && valueFormat === "money";
  const formatValue = (value: number) =>
    valueFormat === "percent" ? fmtPercent(value, 2) : fmtMoney(value, currency);
  if (!t) return <div style={{ height }} />;
  const line = t.brand;
  const dataTop = Math.max(0, ...data.map((point) => point.cumNetPnl));
  const bottom = Math.min(0, ...data.map((point) => point.cumNetPnl));
  const top = Math.max(dataTop, target?.pnl ?? 0);
  const domainTop =
    target && target.pnl >= dataTop ? top + Math.max((top - bottom) * 0.08, 1) : top;
  const zero = domainTop === bottom ? 100 : (domainTop / (domainTop - bottom)) * 100;
  const targetLabel = target
    ? `Target ${formatValue(target.balance).replace(/^\+/, "").replace(/\.00$/, "")}`
    : "";
  return (
    <ChartFrame height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          key={String(privateMode)}
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
        >
          <defs>
            <linearGradient id={`${id}-line`} x1="0" y1="0" x2="0" y2="1">
              <stop offset={`${zero}%`} stopColor={line} />
              <stop offset={`${zero}%`} stopColor={t.loss} />
            </linearGradient>
            <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={line} stopOpacity={0.3} />
              <stop offset={`${zero}%`} stopColor={line} stopOpacity={0.035} />
              <stop offset={`${zero}%`} stopColor={t.loss} stopOpacity={0.035} />
              <stop offset="100%" stopColor={t.loss} stopOpacity={0.3} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={t.gridline} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="t"
            tick={{ fill: t.inkMuted, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: t.baseline }}
            minTickGap={48}
            tickFormatter={(value: string) => value.slice(0, 10)}
          />
          <YAxis
            tick={{ fill: t.inkMuted, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={70}
            domain={[bottom, domainTop === bottom ? 1 : domainTop]}
            tickFormatter={(value: number) =>
              privateMode ? "••••" : formatValue(value).replace(".00", "")
            }
          />
          <ReferenceLine y={0} stroke={t.baseline} />
          {target && (
            <ReferenceLine
              y={target.pnl}
              stroke={t.profit}
              strokeWidth={1.5}
              strokeDasharray="6 5"
              label={{
                value: privateMode ? "Target ••••" : targetLabel,
                position: "insideTopLeft",
                fill: t.profit,
                fontSize: 11,
              }}
            />
          )}
          <Tooltip
            contentStyle={tooltipStyle(t)}
            labelFormatter={(value) => String(value).slice(0, 10)}
            formatter={(value) => [privateMode ? "Hidden" : formatValue(Number(value)), valueLabel]}
            cursor={{ stroke: t.inkMuted, strokeDasharray: "3 3" }}
          />
          <Area
            type={curve}
            dataKey="cumNetPnl"
            stroke={bottom < 0 ? (top > 0 ? `url(#${id}-line)` : t.loss) : line}
            strokeWidth={2}
            fill={`url(#${id}-fill)`}
            baseValue={0}
            dot={data.length === 1 ? { r: 3 } : false}
            activeDot={({ cx, cy, payload }) => (
              <circle
                cx={cx}
                cy={cy}
                r={4}
                fill={payload.cumNetPnl < 0 ? t.loss : line}
                stroke={t.card}
                strokeWidth={2}
              />
            )}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
