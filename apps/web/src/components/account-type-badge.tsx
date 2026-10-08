import { Badge } from "@/components/ui/badge";
import { ACCOUNT_TYPE_META, type AccountType } from "@/lib/account-profile";
import { cn } from "@/lib/utils";

export function AccountTypeDot({ type }: { type: AccountType }) {
  return (
    <span
      aria-hidden="true"
      className={cn("h-2 w-2 shrink-0 rounded-full", ACCOUNT_TYPE_META[type].dot)}
    />
  );
}

export function AccountTypeBadge({
  type,
  profitTargetPct,
}: {
  type: AccountType;
  profitTargetPct?: number | null;
}) {
  const meta = ACCOUNT_TYPE_META[type];
  return (
    <Badge variant="outline" className={cn("gap-1.5", meta.badge)}>
      <AccountTypeDot type={type} />
      {meta.label}
      {profitTargetPct != null ? ` · ${profitTargetPct}%` : ""}
    </Badge>
  );
}
