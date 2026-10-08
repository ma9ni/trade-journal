"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_META,
  needsProfitTarget,
  type AccountType,
} from "@/lib/account-profile";
import { cn } from "@/lib/utils";

export function AccountProfileFields({
  accountType,
  profitTarget,
  onAccountTypeChange,
  onProfitTargetChange,
  disabled,
}: {
  accountType: AccountType;
  profitTarget: string;
  onAccountTypeChange: (value: AccountType) => void;
  onProfitTargetChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={`${id}-type`}>Account type</Label>
        <Select
          value={accountType}
          onValueChange={(value) => onAccountTypeChange(value as AccountType)}
          disabled={disabled}
        >
          <SelectTrigger id={`${id}-type`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACCOUNT_TYPES.map((type) => (
              <SelectItem
                key={type}
                value={type}
                className={cn(
                  "before:mr-2 before:inline-block before:h-2 before:w-2 before:rounded-full",
                  ACCOUNT_TYPE_META[type].optionDot,
                )}
              >
                {ACCOUNT_TYPE_META[type].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {needsProfitTarget(accountType) && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-target`}>Profit target (%)</Label>
          <Input
            id={`${id}-target`}
            required
            type="number"
            min="0.01"
            max="100"
            step="0.01"
            inputMode="decimal"
            value={profitTarget}
            onChange={(event) => onProfitTargetChange(event.target.value)}
            disabled={disabled}
            placeholder="10"
          />
        </div>
      )}
    </div>
  );
}
