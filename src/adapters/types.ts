/**
 * Normalized event refs. Everything thread resolution keys on lives here,
 * extracted once at ingest time.
 */
export interface EventRefs {
  issueKeys: string[]; // e.g. "PROJ-123"
  prNumbers: number[]; // e.g. 456 (repo-scoped)
  branches: string[];
  paths: string[]; // changed file paths
}

export type EventSource =
  | "github_commit"
  | "github_pr"
  | "github_review"
  | "manual";

export interface EventRecord {
  id: string; // natural id: "gh:commit:<sha>", "gh:pr:<node_id>", "gh:review:<id>", "manual:<uuid>"
  source: EventSource;
  timestamp: string; // ISO 8601
  repo: string | null; // "owner/name"; null for source-less manual notes
  title: string;
  body: string | null;
  refs: EventRefs;
  raw: unknown;
}

export interface FetchOptions {
  since: Date;
  until: Date;
  /** Skip expensive detail fetches for events already stored. */
  hasEvent: (id: string) => boolean;
  isRepoDenylisted: (repo: string) => boolean;
  onProgress?: (message: string) => void;
}

/**
 * One per data source (GitHub today; Jira/Notion/calendar later).
 * New sources implement this — the schema and commands don't change.
 */
export interface SourceAdapter {
  name: string;
  /**
   * Stable identity for incremental-sync cursors, e.g. "github:github.com:alice".
   * Must include the authenticated user so switching accounts never reuses
   * another account's cursor. Falls back to `name` when absent.
   */
  identity?(): Promise<string>;
  fetchEvents(opts: FetchOptions): AsyncIterable<EventRecord>;
}

export const REF_PATTERNS = {
  issueKey: /\b[A-Z][A-Z0-9]+-\d+\b/g,
  prNumber: /(?:^|[\s(])#(\d+)\b/g,
};

export function extractTextRefs(text: string): {
  issueKeys: string[];
  prNumbers: number[];
} {
  const issueKeys = [...new Set(text.match(REF_PATTERNS.issueKey) ?? [])];
  const prNumbers = [
    ...new Set(
      [...text.matchAll(REF_PATTERNS.prNumber)].map((m) => Number(m[1]))
    ),
  ];
  return { issueKeys, prNumbers };
}
