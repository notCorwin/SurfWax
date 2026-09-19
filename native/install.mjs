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

const nativeDirectory = dirname(fileURLToPath(import.meta.url));
const hostScript = resolve(nativeDirectory, "host.mjs");
const launcher = resolve(nativeDirectory, platform() === "win32" ? "surfwax-native-host.cmd" : "surfwax-native-host");
if (platform() === "win32") {
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${hostScript}"\r\n`);
} else {
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hostScript)}\n`);
  await chmod(launcher, 0o755);
}
const manifest = JSON.stringify({
  name: "com.surfwax.host",
  description: "Surf Wax desktop capability host",
  path: launcher,
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
