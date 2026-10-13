"use client";
import { HoverHint } from "./ui/tooltip";
import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  ExternalLink,
  ImagePlus,
  Paperclip,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { postJson, useApi } from "@/lib/use-api";
import { captureUrls, imageFiles } from "@/lib/capture-paste";
export function Attachments({
  type,
  id,
  role = "general",
  heading,
  allowPaste = false,
}: {
  type: "trade" | "day" | "note" | "missed" | "opportunity" | "prop-account" | "prop-entry";
  id: string;
  role?: "general" | "before" | "context" | "after";
  heading?: string;
  allowPaste?: boolean;
}) {
  const { data, error, refresh } = useApi<{
    attachments: {
      id: string;
      name: string;
      mime: string;
      size: number;
      role: string;
      sourceUrl: string | null;
    }[];
  }>(`/api/attachments?type=${type}&id=${encodeURIComponent(id)}&role=${encodeURIComponent(role)}`);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(""),
    [previewId, setPreviewId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const images =
    data?.attachments.filter((attachment) => attachment.mime.startsWith("image/")) ?? [];
  const previewIndex = images.findIndex((attachment) => attachment.id === previewId);
  const preview = previewIndex >= 0 ? images[previewIndex] : null;
  useEffect(() => {
    if (!previewId) return;
    const navigate = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && previewIndex > 0) setPreviewId(images[previewIndex - 1]!.id);
      if (event.key === "ArrowRight" && previewIndex < images.length - 1)
        setPreviewId(images[previewIndex + 1]!.id);
    };
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [images, previewId, previewIndex]);
  async function upload(files: File[], urls: string[] = []) {
    if (!files.length && !urls.length) return;
    setBusy(true);
    setFailure("");
    try {
      for (const file of files) {
        const body = new FormData();
        body.append("type", type);
        body.append("id", id);
        body.append("role", role);
        body.append("file", file);
        const r = await fetch("/api/attachments", { method: "POST", body });
        const result = await r.json();
        if (!r.ok) throw new Error(result.error);
      }
      for (const url of urls) {
        await postJson("/api/attachments", { type, id, role, url });
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
      refresh();
    }
  }
  return (
    <div
      className={
        allowPaste
          ? "space-y-3 rounded-md border border-dashed p-3 focus-within:border-ring"
          : "space-y-3 border-t pt-3"
      }
      tabIndex={allowPaste ? 0 : undefined}
      onPaste={
        allowPaste
          ? (event) => {
              const files = imageFiles(event.clipboardData);
              const urls = captureUrls(event.clipboardData);
              if (files.length || urls.length) {
                event.preventDefault();
                void upload(files, urls);
              }
            }
          : undefined
      }
      onDragOver={allowPaste ? (event) => event.preventDefault() : undefined}
      onDrop={
        allowPaste
          ? (event) => {
              const files = imageFiles(event.dataTransfer);
              const urls = captureUrls(event.dataTransfer);
              if (!files.length && !urls.length) return;
              event.preventDefault();
              void upload(files, urls);
            }
          : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {heading && (
          <p className="mr-auto text-xs font-medium uppercase text-muted-foreground">{heading}</p>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {allowPaste ? <ImagePlus /> : <Paperclip />}
          {busy ? "Uploading…" : allowPaste ? "Add image" : "Add attachment"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {allowPaste ? (
            <span className="inline-flex items-center gap-1">
              <ClipboardPaste className="h-3 w-3" /> Paste or drop multiple images and HTTPS links
            </span>
          ) : (
            "Images or PDF · up to 8 MB each"
          )}
        </span>
      </div>
      <input
        ref={input}
        aria-label="Upload attachment"
        type="file"
        accept={
          allowPaste
            ? "image/png,image/jpeg,image/webp"
            : "image/png,image/jpeg,image/webp,application/pdf"
        }
        className="hidden"
        multiple
        onChange={(event) => void upload(Array.from(event.target.files ?? []))}
      />
      {(failure || error) && (
        <p role="alert" className="text-xs text-destructive">
          {failure || error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {data?.attachments.map((a) => (
          <div key={a.id} className="min-w-0 rounded-md border p-2">
            <HoverHint content={a.name}>
              {a.mime.startsWith("image/") && !a.sourceUrl ? (
                <button
                  type="button"
                  className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Preview ${a.name}`}
                  onClick={() => setPreviewId(a.id)}
                >
                  <img
                    src={`/api/attachments/${a.id}`}
                    alt={a.name}
                    className="mb-2 h-28 w-full rounded object-contain"
                  />
                  <span className="block truncate text-xs underline">{a.name}</span>
                </button>
              ) : (
                <a
                  href={`/api/attachments/${a.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block"
                >
                  {a.sourceUrl && (
                    <span className="mb-2 flex h-28 items-center justify-center rounded bg-muted text-muted-foreground">
                      <ExternalLink className="h-5 w-5" />
                    </span>
                  )}
                  <span className="block truncate text-xs underline">{a.name}</span>
                </a>
              )}
            </HoverHint>
            <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>{a.sourceUrl ? "External link" : `${Math.round(a.size / 1024)} KB`}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Remove ${a.name}`}
                onClick={async () => {
                  if (!confirm(`Remove ${a.name}?`)) return;
                  try {
                    await postJson(`/api/attachments/${a.id}`, undefined, "DELETE");
                    refresh();
                  } catch (e) {
                    setFailure(String(e));
                  }
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
      {data && !data.attachments.length && allowPaste && (
        <p className="text-xs text-muted-foreground">No {role} capture yet.</p>
      )}
      <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreviewId(null)}>
        <DialogContent className="max-h-[96vh] max-w-[min(96vw,1100px)] overflow-hidden p-3 sm:max-w-[min(96vw,1100px)]">
          <DialogHeader className="sr-only">
            <DialogTitle>{preview?.name ?? "Image preview"}</DialogTitle>
            <DialogDescription>
              Image {previewIndex + 1} of {images.length}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="flex min-h-0 flex-col gap-3">
              <div className="relative flex min-h-0 items-center justify-center rounded-md bg-black/90 p-2">
                <img
                  src={`/api/attachments/${preview.id}`}
                  alt={preview.name}
                  className="max-h-[72vh] max-w-full object-contain"
                />
                {images.length > 1 && (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="absolute left-3 top-1/2 -translate-y-1/2"
                      disabled={previewIndex === 0}
                      aria-label="Previous image"
                      title="Previous image"
                      onClick={() => setPreviewId(images[previewIndex - 1]!.id)}
                    >
                      <ChevronLeft />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                      disabled={previewIndex === images.length - 1}
                      aria-label="Next image"
                      title="Next image"
                      onClick={() => setPreviewId(images[previewIndex + 1]!.id)}
                    >
                      <ChevronRight />
                    </Button>
                  </>
                )}
              </div>
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">{preview.name}</span>
                <span className="shrink-0">
                  {previewIndex + 1} / {images.length}
                </span>
              </div>
              {images.length > 1 && (
                <div
                  className="flex gap-2 overflow-x-auto pb-1"
                  aria-label="Image gallery thumbnails"
                >
                  {images.map((image, index) => (
                    <button
                      key={image.id}
                      type="button"
                      aria-label={`Show image ${index + 1}: ${image.name}`}
                      aria-current={image.id === preview.id ? "true" : undefined}
                      className={`h-14 w-20 shrink-0 overflow-hidden rounded border-2 ${
                        image.id === preview.id ? "border-ring" : "border-transparent"
                      }`}
                      onClick={() => setPreviewId(image.id)}
                    >
                      <img
                        src={`/api/attachments/${image.id}`}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
