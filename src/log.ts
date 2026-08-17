import fs from "node:fs";
import path from "node:path";
import { ensureDirs, logsDir } from "./paths.js";

export interface UsageEntry {
  timestamp: string;
  task: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | null;
  egress_file: string | null;
}

/**
 * Commit messages and PR bodies from private repos are sensitive. Every byte
 * that leaves the machine for an LLM is written verbatim to an egress file
 * first, so "what did I send?" always has an exact answer.
 */
export function logEgress(payload: string): string {
  ensureDirs();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(logsDir(), `egress-${ts}.txt`);
  fs.writeFileSync(file, payload);
  return file;
}

export function logUsage(entry: UsageEntry): void {
  ensureDirs();
  fs.appendFileSync(
    path.join(logsDir(), "usage.jsonl"),
    JSON.stringify(entry) + "\n"
  );
}
