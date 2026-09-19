#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(exec);
const executeFile = promisify(execFile);
const controllers = new Map();
let input = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message, (_key, value) => typeof value === "bigint" ? `${value}n` : value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(header);
  process.stdout.write(body);
}

async function run({ id, code }) {
  const controller = new AbortController();
  controllers.set(id, controller);
  const emit = (value) => send({ id, event: "data", value });
  const native = { fs, path, os, process, exec: execute, execFile: executeFile, spawn, fetch };
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = await new AsyncFunction("native", "signal", "emit", `"use strict";\n${code}`)(native, controller.signal, emit);
    send({ id, result });
  } catch (error) {
    send({ id, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  } finally {
    controllers.delete(id);
  }
}

function receive(message) {
  if (!message?.id) return;
  if (message.operation === "cancel") controllers.get(message.id)?.abort();
  else if (message.operation === "execute" && typeof message.code === "string") void run(message);
  else send({ id: message.id, error: "Unknown native host operation" });
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < length + 4) return;
    const body = input.subarray(4, length + 4);
    input = input.subarray(length + 4);
    try { receive(JSON.parse(body.toString("utf8"))); }
    catch (error) { send({ error: error instanceof Error ? error.message : String(error) }); }
  }
});
