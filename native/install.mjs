#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const extensionId = process.argv[2];
if (!/^[a-p]{32}$/.test(extensionId ?? "")) {
  console.error("Usage: node native/install.mjs <32-character-extension-id>");
  process.exit(1);
}

const host = resolve(dirname(fileURLToPath(import.meta.url)), platform() === "win32" ? "host.cmd" : "host.mjs");
if (platform() !== "win32") await chmod(host, 0o755);
const manifest = JSON.stringify({
  name: "com.surfwax.host",
  description: "Surf Wax desktop capability host",
  path: host,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2);

if (platform() === "win32") {
  const target = resolve(homedir(), "AppData", "Local", "SurfWax", "com.surfwax.host.json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, manifest);
  execFileSync("reg.exe", ["ADD", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.surfwax.host", "/ve", "/t", "REG_SZ", "/d", target, "/f"], { stdio: "inherit" });
  console.log(target);
} else {
  const base = platform() === "darwin"
    ? resolve(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    : resolve(homedir(), ".config", "google-chrome", "NativeMessagingHosts");
  const target = resolve(base, "com.surfwax.host.json");
  await mkdir(base, { recursive: true });
  await writeFile(target, manifest);
  console.log(target);
}
