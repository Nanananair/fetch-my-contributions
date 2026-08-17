import fs from "node:fs";
import { z } from "zod";
import { configPath, ensureDirs } from "./paths.js";

const ConfigSchema = z.object({
  models: z
    .object({
      report: z.string().default("anthropic/claude-sonnet-4.5"),
      resolve: z.string().default("google/gemini-2.5-flash"),
      distill: z.string().default("anthropic/claude-sonnet-4.5"),
      fallback: z.string().default("openai/gpt-4o-mini"),
    })
    .prefault({}),
  // "owner/repo" exact, or simple "*" globs. Filters both fetching and report egress.
  denylist: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  ensureDirs();
  const file = configPath();
  if (!fs.existsSync(file)) {
    const defaults = ConfigSchema.parse({});
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2) + "\n");
    return defaults;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${file}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`);
}

/** Patterns are "owner/repo" exact or simple "*" globs within either segment. */
export function repoMatches(repo: string, patterns: string[]): boolean {
  return patterns.some((entry) => entry === repo || globToRegExp(entry).test(repo));
}

export function isDenylisted(repo: string | null, denylist: string[]): boolean {
  return repo !== null && repoMatches(repo, denylist);
}
