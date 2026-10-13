import { describe, expect, it } from "vitest";
import { captureUrls, mergeFiles } from "../src/lib/capture-paste";

const transfer = (values: Record<string, string>) =>
  ({
    files: [],
    getData: (type: string) => values[type] ?? "",
  }) as unknown as DataTransfer;

describe("capture paste", () => {
  it("extracts and deduplicates multiple secure links", () => {
    expect(
      captureUrls(
        transfer({
          "text/uri-list": "https://www.tradingview.com/x/one/\nhttps://example.com/chart.png",
          "text/plain": "https://www.tradingview.com/x/one/ http://unsafe.test/image.png",
        }),
      ),
    ).toEqual(["https://www.tradingview.com/x/one/", "https://example.com/chart.png"]);
  });

  it("keeps distinct clipboard images and drops exact duplicates", () => {
    const first = new File(["one"], "chart.png", { type: "image/png", lastModified: 1 });
    const duplicate = new File(["one"], "chart.png", { type: "image/png", lastModified: 1 });
    const second = new File(["two"], "chart-2.png", { type: "image/png", lastModified: 2 });
    expect(mergeFiles([first], [duplicate, second])).toEqual([first, second]);
  });
});
