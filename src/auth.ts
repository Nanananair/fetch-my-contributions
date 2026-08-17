import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HostAuth {
  host: string; // e.g. "github.com" or "github.mycorp.com"
  token: string;
}

function ghAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hosts gh is authenticated against, from ~/.config/gh/hosts.yml.
 * Minimal YAML handling: top-level unindented keys are hostnames.
 */
function ghHosts(): string[] {
  const file = path.join(
    process.env.GH_CONFIG_DIR ?? path.join(os.homedir(), ".config", "gh"),
    "hosts.yml"
  );
  if (!fs.existsSync(file)) return [];
  const hosts: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z0-9.-]+):\s*$/);
    if (m) hosts.push(m[1]);
  }
  return hosts;
}

function ghToken(host: string): string | null {
  try {
    const out = execFileSync("gh", ["auth", "token", "--hostname", host], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve GitHub credentials, per run, never persisted:
 *   1. gh CLI tokens (every authenticated host, so GHE works out of the box)
 *   2. GITHUB_TOKEN / GH_TOKEN env (github.com)
 */
export function resolveAuth(): HostAuth[] {
  const auths: HostAuth[] = [];

  if (ghAvailable()) {
    const hosts = ghHosts();
    for (const host of hosts.length > 0 ? hosts : ["github.com"]) {
      const token = ghToken(host);
      if (token) auths.push({ host, token });
    }
  }

  if (!auths.some((a) => a.host === "github.com")) {
    const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (envToken) auths.push({ host: "github.com", token: envToken });
  }

  if (auths.length === 0) {
    throw new Error(
      "No GitHub credentials found. Run `gh auth login`, or set GITHUB_TOKEN in your environment."
    );
  }
  return auths;
}
