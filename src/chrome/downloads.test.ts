import { describe, expect, it, vi } from "vitest";
import { downloadArtifact } from "./downloads";

const artifact = { id: 7, filename: "page.pdf", mimeType: "application/pdf", saved: false };
describe("required downloads", () => {
  it("saves existing bytes directly without checking or requesting permission", async () => {
    const api = { downloads: { download: vi.fn(async () => 17) } };
    await expect(downloadArtifact(api as never, artifact, "eA==")).resolves.toBe(17);
    expect(api.downloads.download).toHaveBeenCalledExactlyOnceWith({ url: "data:application/pdf;base64,eA==", filename: "page.pdf", saveAs: false });
  });
  it("keeps the artifact reference with a Chrome download failure", async () => {
    const error = new Error("Download failed");
    const api = { downloads: { download: vi.fn(async () => { throw error; }) } };
    await expect(downloadArtifact(api as never, artifact, "eA==")).rejects.toMatchObject({ message: "Download failed", artifact });
  });
  it("does not start a download after cancellation", async () => {
    const api = { downloads: { download: vi.fn(async () => 17) } };
    const controller = new AbortController();
    controller.abort(new DOMException("sidepanel-closed", "AbortError"));
    await expect(downloadArtifact(api as never, artifact, "eA==", controller.signal)).rejects.toMatchObject({ name: "AbortError", artifact });
    expect(api.downloads.download).not.toHaveBeenCalled();
  });
});
