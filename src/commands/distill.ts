import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { Llm, renderPrompt } from "../llm.js";

/** Output formats, each backed by prompts/<prompt>.md. */
export const FORMATS = {
  "resume-bullets": {
    prompt: "resume-bullets",
    maxTokens: 4096,
    ext: "md",
    /** Extra placeholders this template needs beyond since/until/reports. */
    vars: (o: DistillOptions) => ({ role: o.role ?? "Software Engineer" }),
  },
  "linkedin-post": {
    prompt: "linkedin-post",
    maxTokens: 1024,
    ext: "md",
    vars: (o: DistillOptions) => ({
      theme: o.theme ?? "the most significant thing built in this period",
    }),
  },
  "work-history": {
    prompt: "work-history",
    maxTokens: 8192,
    ext: "md",
    vars: () => ({}),
  },
} as const;

export type Format = keyof typeof FORMATS;

export interface DistillOptions {
  config: Config;
  format: Format;
  /** Report files to distill. */
  files: string[];
  out?: string;
  dryRun: boolean;
  /** Target role, for resume-bullets. */
  role?: string;
  /** Post subject, for linkedin-post. */
  theme?: string;
}

const REPORT_FILE = /^report-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})\.md$/;

export async function runDistill(opts: DistillOptions): Promise<void> {
  const spec = FORMATS[opts.format];

  const reports = opts.files
    .map((f) => readReport(f))
    .sort((a, b) => a.since.localeCompare(b.since));
  if (reports.length === 0) {
    console.error("No report files given. Run `fmc report` first.");
    process.exitCode = 1;
    return;
  }

  const since = reports[0].since;
  const until = reports[reports.length - 1].until;

  // The "Gaps — thin evidence" sections are the engineer's private
  // notes-to-self about weak evidence. The prompts also forbid using them, but
  // strip here too: like the denylist, the safe thing to do is filter twice, so
  // self-critical audit notes can never reach a resume, a public post, or a
  // chatbot's system prompt even if a model ignores an instruction.
  let strippedGaps = 0;
  const body = reports
    .map((r) => {
      const { text, stripped } = stripGaps(r.text);
      strippedGaps += stripped;
      return `## Report: ${r.since} to ${r.until}\n\n${text.trim()}`;
    })
    .join("\n\n---\n\n");

  console.error(
    `→ distilling ${reports.length} report(s) (${since}..${until}, ${body.length.toLocaleString()} chars) into ${opts.format}` +
      (strippedGaps > 0 ? `; stripped ${strippedGaps} thin-evidence section(s)` : "")
  );

  const prompt = renderPrompt(spec.prompt, {
    since,
    until,
    reports: body,
    ...spec.vars(opts),
  });

  if (opts.dryRun) {
    console.error("--dry-run: printing the exact prompt, sending nothing.\n");
    console.log(prompt);
    return;
  }

  const llm = new Llm(opts.config);
  const result = await llm.complete(prompt, {
    task: "distill",
    maxTokens: spec.maxTokens,
  });

  const text = result.text.trimEnd() + "\n";
  if (opts.out === "-") {
    console.log(text.trimEnd());
  } else {
    const outFile = opts.out ?? `${opts.format}-${since}-${until}.${spec.ext}`;
    fs.writeFileSync(outFile, text);
    console.error(`wrote ${outFile}`);
  }

  console.error(
    `cost: ${result.usage.promptTokens} prompt + ${result.usage.completionTokens} completion tokens on ${result.model}` +
      (result.costUsd != null ? ` ≈ $${result.costUsd.toFixed(4)}` : "")
  );
}

interface LoadedReport {
  since: string;
  until: string;
  text: string;
}

function readReport(file: string): LoadedReport {
  const text = fs.readFileSync(file, "utf8");
  const name = path.basename(file);
  const m = name.match(REPORT_FILE);
  if (m) return { since: m[1], until: m[2], text };
  // Fall back to the "# Work summary: <since> to <until>" heading `report`
  // writes, so renamed files still carry their window.
  const h = text.match(
    /^#\s*Work summary:\s*(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/im
  );
  if (h) return { since: h[1], until: h[2], text };
  throw new Error(
    `Cannot determine the window for "${name}". Expected a report-<since>-<until>.md name or a "# Work summary: <since> to <until>" heading.`
  );
}

/**
 * Drop the "Gaps — thin evidence" section: everything from that heading to the
 * next heading of the same level (or end of file).
 */
export function stripGaps(text: string): { text: string; stripped: number } {
  const lines = text.split("\n");
  const out: string[] = [];
  let stripped = 0;
  let skippingLevel: number | null = null;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      if (skippingLevel !== null && level <= skippingLevel) skippingLevel = null;
      if (skippingLevel === null && /^gaps\b/i.test(heading[2].trim())) {
        skippingLevel = level;
        stripped++;
        continue;
      }
    }
    if (skippingLevel === null) out.push(line);
  }
  // A trailing "---" separator can be left behind once the last section goes.
  while (out.length > 0 && /^\s*(-{3,}|\s*)$/.test(out[out.length - 1])) {
    out.pop();
  }
  return { text: out.join("\n"), stripped };
}
