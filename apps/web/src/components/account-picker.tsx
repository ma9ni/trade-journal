"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { postJson, useApi } from "@/lib/use-api";
import { AccountProfileFields } from "@/components/account-profile-fields";
import {
  ACCOUNT_TYPE_META,
  needsProfitTarget,
  validProfitTarget,
  type AccountType,
} from "@/lib/account-profile";
import { cn } from "@/lib/utils";

interface AccountRow {
  id: string;
  name: string;
  kind: string;
  accountType: AccountType;
  profitTargetPct: number | null;
  archivedAt: string | null;
}

/** Account picker used by every method; offers creating a new one inline. */
export function AccountPicker({
  value,
  onChange,
  kind,
}: {
  value: string;
  onChange: (id: string) => void;
  kind: "import" | "manual";
}) {
  const {
    data,
    refresh,
    error: accountError,
  } = useApi<{ accounts: AccountRow[] }>("/api/accounts");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [balance, setBalance] = useState("0");
  const [accountType, setAccountType] = useState<AccountType>("personal");
  const [profitTarget, setProfitTarget] = useState("10");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<AccountRow[]>([]);
  const fieldId = useId();
  const accounts = [
    ...(data?.accounts ?? []),
    ...created.filter((item) => !data?.accounts.some((row) => row.id === item.id)),
  ].filter((account) => !account.archivedAt);
  const create = async () => {
    if (
      saving ||
      !name.trim() ||
      !/^[A-Z]{3}$/.test(currency) ||
      !balance.trim() ||
      !Number.isFinite(Number(balance)) ||
      Number(balance) < 0 ||
      (needsProfitTarget(accountType) && !validProfitTarget(Number(profitTarget)))
    )
      return;
    setSaving(true);
    setError("");
    try {
      const result = await postJson<{ id: string }>("/api/accounts", {
        name: name.trim(),
        kind,
        currency,
        initialBalance: Number(balance),
        accountType,
        profitTargetPct: needsProfitTarget(accountType) ? Number(profitTarget) : null,
      });
      setCreated((current) => [
        ...current,
        {
          id: result.id,
          name: name.trim(),
          kind,
          accountType,
          profitTargetPct: needsProfitTarget(accountType) ? Number(profitTarget) : null,
          archivedAt: null,
        },
      ]);
      onChange(result.id);
      refresh();
      setCreating(false);
      setName("");
      setBalance("0");
      setAccountType("personal");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account creation failed.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <div className="min-w-0 flex-[1_1_180px]">
        <Label htmlFor={`${fieldId}-account`} className="mb-1 block text-xs text-muted-foreground">
          Into account
        </Label>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={`${fieldId}-account`}>
            <SelectValue placeholder="Choose an account" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem
                key={account.id}
                value={account.id}
                className={cn(
                  "before:mr-2 before:inline-block before:h-2 before:w-2 before:rounded-full",
                  ACCOUNT_TYPE_META[account.accountType].optionDot,
                )}
              >
                {account.name} · {ACCOUNT_TYPE_META[account.accountType].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        type="button"
        variant="outline"
        aria-expanded={creating}
        onClick={() => {
          setCreating(!creating);
          setError("");
        }}
        disabled={saving}
      >
        {creating ? "Cancel new account" : "New account"}
      </Button>
      {accountError && (
        <p role="alert" className="w-full text-sm text-destructive">
          {accountError}
        </p>
      )}
      {creating && (
        <form
          className="w-full space-y-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!saving) void create();
          }}
        >
          <h3 className="text-sm font-medium">Create account</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-name`}>Account name</Label>
              <Input
                id={`${fieldId}-name`}
                autoFocus
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={saving}
                placeholder="Trading test account"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-currency`}>Currency</Label>
              <Input
                id={`${fieldId}-currency`}
                required
                pattern="[A-Z]{3}"
                maxLength={3}
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-balance`}>Starting balance</Label>
              <Input
                id={`${fieldId}-balance`}
                required
                type="number"
                min="0"
                step="0.01"
                value={balance}
                onChange={(event) => setBalance(event.target.value)}
                disabled={saving}
              />
            </div>
          </div>
          <AccountProfileFields
            accountType={accountType}
            profitTarget={profitTarget}
            onAccountTypeChange={setAccountType}
            onProfitTargetChange={setProfitTarget}
            disabled={saving}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            disabled={
              saving ||
              !name.trim() ||
              !/^[A-Z]{3}$/.test(currency) ||
              !balance.trim() ||
              !Number.isFinite(Number(balance)) ||
              Number(balance) < 0 ||
              (needsProfitTarget(accountType) && !validProfitTarget(Number(profitTarget)))
            }
          >
            {saving ? "Creating…" : "Create account"}
          </Button>
        </form>
      )}
    </div>
  );
}
