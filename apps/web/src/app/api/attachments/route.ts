import { and, eq } from "drizzle-orm";
import { db, attachments, trades, notes, missedTrades, propAccounts, propEntries } from "@/db";
import { handler, ok, requireValue } from "@/server/api";
import { newId, nowIso } from "@/server/ids";
import { attachmentMime, MAX_ATTACHMENT_SIZE } from "@/lib/attachment-validation";
function owner(type: string, id: string) {
  if (type === "opportunity") type = "missed";
  if (type === "prop-account")
    return !!db
      .select({ id: propAccounts.id })
      .from(propAccounts)
      .where(eq(propAccounts.id, id))
      .get();
  if (type === "prop-entry")
    return !!db
      .select({ id: propEntries.id })
      .from(propEntries)
      .where(eq(propEntries.id, id))
      .get();
  if (type === "trade")
    return !!db.select({ key: trades.key }).from(trades).where(eq(trades.key, id)).get();
  if (type === "note")
    return !!db.select({ id: notes.id }).from(notes).where(eq(notes.id, id)).get();
  if (type === "missed")
    return !!db
      .select({ id: missedTrades.id })
      .from(missedTrades)
      .where(eq(missedTrades.id, id))
      .get();
  return (
    type === "day" &&
    /^\d{4}-\d{2}-\d{2}$/.test(id) &&
    !isNaN(Date.parse(id)) &&
    new Date(id).toISOString().slice(0, 10) === id
  );
}
const roles = ["general", "before", "context", "after"] as const;
type AttachmentRole = (typeof roles)[number];
const validRole = (value: string): value is AttachmentRole =>
  roles.includes(value as AttachmentRole);
const externalUrl = (value: unknown) => {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
};
const storedType = (type: string) => (type === "opportunity" ? "missed" : type);

export const GET = handler((request: Request) => {
  const p = new URL(request.url).searchParams;
  const type = p.get("type") ?? "",
    id = p.get("id") ?? "",
    role = p.get("role");
  requireValue(owner(type, id), "Attachment owner not found.");
  requireValue(role === null || validRole(role), "Invalid attachment role.");
  return ok({
    attachments: db
      .select({
        id: attachments.id,
        name: attachments.name,
        mime: attachments.mime,
        size: attachments.size,
        role: attachments.role,
        sourceUrl: attachments.sourceUrl,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.ownerType, storedType(type)),
          eq(attachments.ownerId, id),
          role
            ? eq(attachments.role, role as "general" | "before" | "context" | "after")
            : undefined,
        ),
      )
      .all(),
  });
});
export const POST = handler(async (request: Request) => {
  if (request.headers.get("content-type")?.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    const type = String(body.type ?? ""),
      ownerId = String(body.id ?? ""),
      role = String(body.role ?? "general"),
      sourceUrl = externalUrl(body.url);
    requireValue(owner(type, ownerId), "Attachment owner not found.");
    requireValue(validRole(role), "Invalid attachment role.");
    requireValue(sourceUrl, "Paste a valid HTTPS link.");
    const url = new URL(sourceUrl);
    const label = `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 200);
    const id = newId();
    db.insert(attachments)
      .values({
        id,
        ownerType: storedType(type),
        ownerId,
        name: label,
        mime: "application/x.external-link",
        size: 0,
        role,
        sourceUrl,
        data: Buffer.alloc(0),
        createdAt: nowIso(),
      })
      .run();
    return ok({ id });
  }
  requireValue(
    Number(request.headers.get("content-length") ?? 0) <= MAX_ATTACHMENT_SIZE + 10000,
    "Files must be 8 MB or smaller.",
  );
  const form = await request.formData();
  const type = String(form.get("type") ?? ""),
    ownerId = String(form.get("id") ?? ""),
    file = form.get("file"),
    role = String(form.get("role") ?? "general");
  requireValue(owner(type, ownerId), "Attachment owner not found.");
  requireValue(validRole(role), "Invalid attachment role.");
  requireValue(
    file instanceof File && file.size > 0 && file.size <= MAX_ATTACHMENT_SIZE,
    "Choose a file up to 8 MB.",
  );
  const bytes = Buffer.from(await file.arrayBuffer()),
    mime = attachmentMime(bytes);
  requireValue(mime, "Supported files: PNG, JPEG, WebP and PDF.");
  const id = newId();
  db.insert(attachments)
    .values({
      id,
      ownerType: storedType(type),
      ownerId,
      name: file.name.slice(0, 200),
      mime,
      size: bytes.length,
      role,
      sourceUrl: null,
      data: bytes,
      createdAt: nowIso(),
    })
    .run();
  return ok({ id });
});
