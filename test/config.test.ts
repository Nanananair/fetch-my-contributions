import { describe, expect, it } from "vitest";
import { isDenylisted, repoMatches } from "../src/config.js";

describe("repoMatches", () => {
  it("keeps exact repository matching", () => {
    expect(repoMatches("acme/app", ["acme/app"])).toBe(true);
    expect(repoMatches("acme/api", ["acme/app"])).toBe(false);
  });

  it("keeps owner-wide wildcard matching", () => {
    expect(repoMatches("acme/app", ["acme/*"])).toBe(true);
    expect(repoMatches("acme/api", ["acme/*"])).toBe(true);
    expect(repoMatches("other/app", ["acme/*"])).toBe(false);
  });

  it("supports globs within the repository segment", () => {
    expect(repoMatches("acme/secret-api", ["acme/secret-*"])).toBe(true);
    expect(repoMatches("acme/public-api", ["acme/secret-*"])).toBe(false);
  });

  it("supports globs within the owner segment", () => {
    expect(repoMatches("acme/app", ["*/app"])).toBe(true);
    expect(repoMatches("other/api", ["*/app"])).toBe(false);
  });

  it("does not let wildcards cross the owner/repo separator", () => {
    expect(repoMatches("acme/app", ["acme*"])).toBe(false);
  });
});

describe("isDenylisted", () => {
  it("applies repository glob patterns to nullable repo names", () => {
    expect(isDenylisted("acme/secret-api", ["acme/secret-*"])).toBe(true);
    expect(isDenylisted(null, ["acme/*"])).toBe(false);
  });
});
