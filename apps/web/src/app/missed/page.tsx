import { redirect } from "next/navigation";

export default async function LegacyMissedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const source = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(source)) {
    for (const item of Array.isArray(value) ? value : value ? [value] : []) query.append(key, item);
  }
  redirect(`/opportunities${query.size ? `?${query.toString()}` : ""}`);
}
