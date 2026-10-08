export const ACCOUNT_TYPES = ["challenge", "verification", "funded", "personal", "demo"] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const isAccountType = (value: unknown): value is AccountType =>
  typeof value === "string" && ACCOUNT_TYPES.includes(value as AccountType);

export const needsProfitTarget = (type: AccountType): boolean =>
  type === "challenge" || type === "verification";

export const ACCOUNT_TYPE_META: Record<
  AccountType,
  { label: string; dot: string; optionDot: string; badge: string }
> = {
  challenge: {
    label: "Challenge",
    dot: "bg-amber-500",
    optionDot: "before:bg-amber-500",
    badge: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  verification: {
    label: "Verification",
    dot: "bg-sky-500",
    optionDot: "before:bg-sky-500",
    badge: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  funded: {
    label: "Funded",
    dot: "bg-emerald-500",
    optionDot: "before:bg-emerald-500",
    badge: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  personal: {
    label: "Personal",
    dot: "bg-zinc-400",
    optionDot: "before:bg-zinc-400",
    badge: "border-zinc-500/20 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  },
  demo: {
    label: "Demo",
    dot: "bg-rose-500",
    optionDot: "before:bg-rose-500",
    badge: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
};

export const validProfitTarget = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
