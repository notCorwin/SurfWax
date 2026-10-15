import { describe, expect, it } from "vitest";
import { downloadConfirmationSnapshot, requestDownloadConfirmation, respondToDownloadConfirmation } from "./download-confirmation";

describe("download confirmation", () => {
  it("requires an explicit response before allowing a download", async () => {
    const pending = requestDownloadConfirmation({ filename: "report.pdf", mimeType: "application/pdf", byteLength: 42 });
    const request = downloadConfirmationSnapshot();
    expect(request).toMatchObject({ filename: "report.pdf", byteLength: 42 });
    respondToDownloadConfirmation(request!.id, true);
    await expect(pending).resolves.toBeUndefined();
    expect(downloadConfirmationSnapshot()).toBeUndefined();
  });

  it("returns a durable denial code when the user cancels", async () => {
    const pending = requestDownloadConfirmation({ filename: "private.txt", mimeType: "text/plain", byteLength: 7 });
    respondToDownloadConfirmation(downloadConfirmationSnapshot()!.id, false);
    await expect(pending).rejects.toMatchObject({ code: "download-denied" });
  });
});
