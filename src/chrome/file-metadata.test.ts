import { describe, expect, it } from "vitest";
import { linkedFilename } from "./file-metadata";

describe("linked file identity", () => {
  it("preserves the link's download name over other source names", () => {
    expect(linkedFilename("sample-17.bin", 'attachment; filename="server.bin"', "https://example.test/other.bin")).toBe("sample-17.bin");
    expect(linkedFilename("sample-17.bin", null, "blob:https://example.test/random-id")).toBe("sample-17.bin");
  });

  it("resolves ordinary links from source response metadata", () => {
    expect(linkedFilename(null, "attachment; filename=old.bin; filename*=UTF-8''%E6%B5%8B%E8%AF%95.bin", "https://example.test/file")).toBe("测试.bin");
    expect(linkedFilename("", 'attachment; filename="a; b.bin"', "https://example.test/file")).toBe("a; b.bin");
    expect(linkedFilename(null, 'attachment; filename="a\\"b.bin"', "https://example.test/file")).toBe('a"b.bin');
    expect(linkedFilename(null, null, "https://example.test/sample%20file.bin?token=1")).toBe("sample file.bin");
  });

  it("never invents a filename from a blob identity", () => {
    expect(() => linkedFilename(null, null, "blob:https://example.test/7d04e09f-5393")).toThrow("no source filename");
    expect(linkedFilename(null, "attachment; filename*=UTF-8''%XX; filename=original.bin", "https://example.test/file")).toBe("original.bin");
  });
});
