import { describe, expect, it } from "vitest";
import { stripGaps } from "../src/commands/distill.js";

describe("stripGaps", () => {
  it("drops the thin-evidence section and keeps the rest", () => {
    const { text, stripped } = stripGaps(
      [
        "# Work summary: 2026-01-01 to 2026-03-31",
        "",
        "## What shipped",
        "",
        "- Built a thing.",
        "",
        "## Gaps — thin evidence",
        "",
        "- Was this abandoned or misattributed?",
        "- These may represent rubber stamps.",
      ].join("\n")
    );
    expect(stripped).toBe(1);
    expect(text).toContain("Built a thing.");
    expect(text).not.toContain("rubber stamps");
    expect(text).not.toContain("Gaps");
  });

  it("resumes at the next same-level heading", () => {
    const { text } = stripGaps(
      [
        "## Gaps — thin evidence",
        "",
        "- unclear if merged",
        "",
        "## Platform & infra work",
        "",
        "- Fixed the build.",
      ].join("\n")
    );
    expect(text).not.toContain("unclear if merged");
    expect(text).toContain("Fixed the build.");
    expect(text).toContain("Platform & infra work");
  });

  it("keeps a deeper subheading inside the gaps section stripped", () => {
    const { text } = stripGaps(
      ["## Gaps — thin evidence", "", "### A sub-note", "", "- private", "", "## Next", "", "- kept"].join("\n")
    );
    expect(text).not.toContain("A sub-note");
    expect(text).not.toContain("private");
    expect(text).toContain("kept");
  });

  it("matches the real heading variants the report prompt produces", () => {
    for (const heading of [
      "## Gaps — thin evidence",
      "## Gaps - thin evidence",
      "### Gaps — thin evidence",
      "## gaps",
    ]) {
      const { stripped } = stripGaps(`${heading}\n\n- note\n`);
      expect(stripped, heading).toBe(1);
    }
  });

  it("leaves a report with no gaps section untouched", () => {
    const input = "## What shipped\n\n- Built a thing.\n";
    const { text, stripped } = stripGaps(input);
    expect(stripped).toBe(0);
    expect(text.trim()).toBe(input.trim());
  });

  it("does not strip headings that merely mention gaps", () => {
    const { text, stripped } = stripGaps(
      "## Closed coverage gaps in the test suite\n\n- Added tests.\n"
    );
    expect(stripped).toBe(0);
    expect(text).toContain("Added tests.");
  });
});
