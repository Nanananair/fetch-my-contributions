import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// FMC_HOME override exists so tests and parallel setups never touch the real data dir.
export function fmcHome(): string {
  return process.env.FMC_HOME ?? path.join(os.homedir(), ".fmc");
}

export function configPath(): string {
  return path.join(fmcHome(), "config.json");
}

export function dbPath(): string {
  return path.join(fmcHome(), "data.db");
}

export function logsDir(): string {
  return path.join(fmcHome(), "logs");
}

export function ensureDirs(): void {
  fs.mkdirSync(fmcHome(), { recursive: true });
  fs.mkdirSync(logsDir(), { recursive: true });
}
