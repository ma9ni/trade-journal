export const imageFiles = (data: DataTransfer) =>
  Array.from(data.files).filter((file) => file.type.startsWith("image/"));

const httpsUrl = (value: string) => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
};

export function captureUrls(data: DataTransfer) {
  const candidates = [data.getData("text/uri-list"), data.getData("text/plain")]
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean);
  const html = data.getData("text/html");
  if (html && typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(html, "text/html");
    for (const element of document.querySelectorAll("a[href], img[src]")) {
      candidates.push(element.getAttribute(element.tagName === "IMG" ? "src" : "href") ?? "");
    }
  }
  return [...new Set(candidates.map(httpsUrl).filter((url): url is string => Boolean(url)))];
}

export function mergeFiles(current: File[], incoming: File[]) {
  const seen = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  return [
    ...current,
    ...incoming.filter((file) => {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}
