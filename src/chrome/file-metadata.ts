/** Self-contained: also executed in the link's frame through locator.evaluate. */
export function linkedFilename(download: string | null, disposition: string | null, responseURL: string): string {
  if (download) return download;
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(disposition ?? "")?.[1]?.trim();
  if (extended) {
    const encoded = /^utf-8'[^']*'(.*)$/i.exec(extended)?.[1];
    if (encoded !== undefined) {
      try { const name = decodeURIComponent(encoded); if (name) return name; } catch { /* Try ordinary metadata. */ }
    }
  }
  const ordinary = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(disposition ?? "");
  const headerName = ordinary?.[1]?.replace(/\\(.)/g, "$1") ?? ordinary?.[2]?.trim();
  if (headerName) return headerName;
  const url = new URL(responseURL);
  // A blob URL's random identity is not the source file's name.
  if (url.protocol === "http:" || url.protocol === "https:") {
    const tail = url.pathname.split("/").at(-1);
    if (tail) { try { return decodeURIComponent(tail); } catch { return tail; } }
  }
  throw new Error("The linked file has no source filename; provide a download attribute or Content-Disposition filename");
}
