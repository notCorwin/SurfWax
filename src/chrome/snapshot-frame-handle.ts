/** Encode all UUID bits in a shorter, URL-safe opaque frame handle. */
export function createFrameHandle(uuid: string = crypto.randomUUID()): string {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(uuid)) throw new TypeError("Invalid frame UUID");
  const hex = uuid.replaceAll("-", "");
  let binary = "";
  for (let offset = 0; offset < hex.length; offset += 2) binary += String.fromCharCode(Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `f${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}
