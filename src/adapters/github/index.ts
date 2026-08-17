import type { Octokit } from "octokit";
import type { HostAuth } from "../../auth.js";
import { makeOctokit, graphqlFor } from "../../github.js";
import {
  extractTextRefs,
  type EventRecord,
  type FetchOptions,
  type SourceAdapter,
} from "../types.js";
import {
  COMMIT_REPOS_QUERY,
  PR_CONTRIBUTIONS_QUERY,
  REVIEW_CONTRIBUTIONS_QUERY,
  VIEWER_QUERY,
  type CommitRepoEntry,
  type PageInfo,
  type PrNode,
  type ReviewNode,
} from "./queries.js";

const MAX_COMMIT_PATHS = 200;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

type GraphqlFn = <T>(query: string, vars?: Record<string, unknown>) => Promise<T>;

interface PrDetails {
  nodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged: boolean;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  repo: string;
}

/**
 * GitHub adapter. Bulk discovery goes through the GraphQL
 * contributionsCollection (few round trips), but contributionsCollection can
 * silently restrict private contributions (restrictedContributionsCount) even
 * for the viewer's own token, so every category also has a REST fallback:
 * repo listing for commits, issue search for PRs and reviews. The union is
 * deduplicated by natural event id, and detail fetches are skipped for events
 * already stored.
 */
export class GitHubAdapter implements SourceAdapter {
  readonly name: string;
  private octokit: Octokit;
  private graphql: GraphqlFn;
  private prefix: string;
  private cachedLogin: string | null = null;

  constructor(private auth: HostAuth) {
    this.name = `github:${auth.host}`;
    this.octokit = makeOctokit(auth);
    this.graphql = graphqlFor(this.octokit, auth.host) as GraphqlFn;
    // Ids stay unique across hosts; keep the bare "gh:" for github.com.
    this.prefix = auth.host === "github.com" ? "gh" : `gh:${auth.host}`;
  }

  private async login(): Promise<string> {
    if (!this.cachedLogin) {
      this.cachedLogin = (
        await this.graphql<{ viewer: { login: string } }>(VIEWER_QUERY)
      ).viewer.login;
    }
    return this.cachedLogin;
  }

  /** Cursor identity includes the login: two accounts on one host never share a cursor. */
  async identity(): Promise<string> {
    return `${this.name}:${await this.login()}`;
  }

  async *fetchEvents(opts: FetchOptions): AsyncIterable<EventRecord> {
    const login = await this.login();
    opts.onProgress?.(`authenticated as ${login} on ${this.auth.host}`);

    const commitRepos = new Set<string>();
    const seenPrIds = new Set<string>();
    const seenReviewIds = new Set<string>();

    // contributionsCollection allows at most a 1-year from/to window.
    for (const [from, to] of windows(opts.since, opts.until)) {
      for (const entry of await this.commitRepos(login, from, to)) {
        commitRepos.add(entry.repository.nameWithOwner);
      }
      yield* this.pullRequests(login, from, to, opts, seenPrIds);
      yield* this.reviews(login, from, to, opts, seenReviewIds);
    }

    // REST fallbacks for whatever contributionsCollection restricted.
    for (const repo of await this.pushedRepos(opts)) commitRepos.add(repo);
    yield* this.searchPullRequests(login, opts, seenPrIds);
    yield* this.searchReviews(login, opts, seenReviewIds);

    yield* this.commits(login, commitRepos, opts);
  }

  private async commitRepos(login: string, from: Date, to: Date) {
    const res = await this.graphql<{
      user: {
        contributionsCollection: {
          commitContributionsByRepository: CommitRepoEntry[];
        };
      };
    }>(COMMIT_REPOS_QUERY, {
      login,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    return res.user.contributionsCollection.commitContributionsByRepository;
  }

  /** REST fallback: any repo the user can push to that changed in the window. */
  private async pushedRepos(opts: FetchOptions): Promise<string[]> {
    const out: string[] = [];
    try {
      for await (const page of this.octokit.paginate.iterator(
        this.octokit.rest.repos.listForAuthenticatedUser,
        { per_page: 100, sort: "pushed" }
      )) {
        let done = false;
        for (const repo of page.data) {
          if (!repo.pushed_at || Date.parse(repo.pushed_at) < opts.since.getTime()) {
            done = true; // sorted by pushed desc — everything after is older
            break;
          }
          out.push(repo.full_name);
        }
        if (done) break;
      }
    } catch (err) {
      opts.onProgress?.(
        `warning: could not list your repos: ${(err as Error).message}`
      );
    }
    return out;
  }

  private prEvent(pr: PrDetails): EventRecord {
    const text = `${pr.title}\n${pr.body ?? ""}\n${pr.headRefName}`;
    const { issueKeys, prNumbers } = extractTextRefs(text);
    return {
      id: `${this.prefix}:pr:${pr.nodeId}`,
      source: "github_pr",
      // "What shipped" cares about when it landed, not when it was opened.
      timestamp: pr.mergedAt ?? pr.closedAt ?? pr.createdAt,
      repo: pr.repo,
      title: `PR #${pr.number}: ${pr.title} [${pr.merged ? "merged" : pr.state.toLowerCase()}]`,
      body: pr.body ?? null,
      refs: {
        issueKeys,
        prNumbers: [...new Set([pr.number, ...prNumbers])],
        branches: [pr.headRefName],
        paths: [],
      },
      raw: pr,
    };
  }

  private async *pullRequests(
    login: string,
    from: Date,
    to: Date,
    opts: FetchOptions,
    seen: Set<string>
  ): AsyncIterable<EventRecord> {
    let cursor: string | null = null;
    do {
      const res: {
        user: {
          contributionsCollection: {
            pullRequestContributions: {
              pageInfo: PageInfo;
              nodes: Array<{ pullRequest: PrNode } | null>;
            };
          };
        };
      } = await this.graphql(PR_CONTRIBUTIONS_QUERY, {
        login,
        from: from.toISOString(),
        to: to.toISOString(),
        cursor,
      });
      const page = res.user.contributionsCollection.pullRequestContributions;
      for (const node of page.nodes) {
        if (!node?.pullRequest) continue;
        const pr = node.pullRequest;
        const repo = pr.repository.nameWithOwner;
        if (opts.isRepoDenylisted(repo)) continue;
        seen.add(pr.id);
        yield this.prEvent({
          nodeId: pr.id,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          merged: pr.merged,
          createdAt: pr.createdAt,
          mergedAt: pr.mergedAt,
          closedAt: pr.closedAt,
          headRefName: pr.headRefName,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          repo,
        });
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
  }

  /** REST fallback for PRs contributionsCollection didn't surface. */
  private async *searchPullRequests(
    login: string,
    opts: FetchOptions,
    seen: Set<string>
  ): AsyncIterable<EventRecord> {
    const q = `type:pr author:${login} updated:>=${opts.since.toISOString().slice(0, 10)}`;
    let found: Array<{ nodeId: string; number: number; repo: string }> = [];
    try {
      for await (const page of this.octokit.paginate.iterator(
        this.octokit.rest.search.issuesAndPullRequests,
        { q, per_page: 100 }
      )) {
        for (const item of page.data) {
          const repo = item.repository_url.replace(/.*\/repos\//, "");
          if (opts.isRepoDenylisted(repo)) continue;
          if (item.node_id && seen.has(item.node_id)) continue;
          found.push({ nodeId: item.node_id, number: item.number, repo });
        }
      }
    } catch (err) {
      opts.onProgress?.(
        `warning: PR search fallback failed: ${(err as Error).message}`
      );
      return;
    }
    const fresh = found.filter(
      (f) => !opts.hasEvent(`${this.prefix}:pr:${f.nodeId}`)
    );
    if (found.length > 0) {
      opts.onProgress?.(
        `PR search fallback: ${found.length} PRs, ${fresh.length} new`
      );
    }
    for (const f of fresh) {
      const [owner, repo] = f.repo.split("/");
      let pr;
      try {
        pr = (
          await this.octokit.rest.pulls.get({ owner, repo, pull_number: f.number })
        ).data;
      } catch (err) {
        opts.onProgress?.(
          `warning: could not fetch PR ${f.repo}#${f.number}: ${(err as Error).message}`
        );
        continue;
      }
      seen.add(pr.node_id);
      yield this.prEvent({
        nodeId: pr.node_id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state.toUpperCase(),
        merged: pr.merged,
        createdAt: pr.created_at,
        mergedAt: pr.merged_at,
        closedAt: pr.closed_at,
        headRefName: pr.head.ref,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        repo: f.repo,
      });
    }
  }

  private reviewEvent(review: {
    nodeId: string;
    state: string;
    body: string | null;
    submittedAt: string | null;
    comments: Array<{ body: string | null; path: string | null }>;
    prNumber: number;
    prTitle: string;
    prAuthor: string | null;
    headRefName: string;
    repo: string;
    fallbackTimestamp: string;
    raw: unknown;
  }): EventRecord {
    const bodyParts = [
      review.body?.trim(),
      ...review.comments.map((c) => c.body?.trim()),
    ].filter((s): s is string => !!s);
    const { issueKeys, prNumbers } = extractTextRefs(
      `${review.prTitle}\n${bodyParts.join("\n")}`
    );
    return {
      id: `${this.prefix}:review:${review.nodeId}`,
      source: "github_review",
      timestamp: review.submittedAt ?? review.fallbackTimestamp,
      repo: review.repo,
      title: `Reviewed PR #${review.prNumber} (${review.prAuthor ?? "unknown"}): ${review.prTitle} [${review.state.toLowerCase()}]`,
      body: bodyParts.length > 0 ? bodyParts.join("\n---\n") : null,
      refs: {
        issueKeys,
        prNumbers: [...new Set([review.prNumber, ...prNumbers])],
        branches: [review.headRefName],
        paths: [
          ...new Set(
            review.comments.map((c) => c.path).filter((p): p is string => !!p)
          ),
        ],
      },
      raw: review.raw,
    };
  }

  private async *reviews(
    login: string,
    from: Date,
    to: Date,
    opts: FetchOptions,
    seen: Set<string>
  ): AsyncIterable<EventRecord> {
    let cursor: string | null = null;
    do {
      const res: {
        user: {
          contributionsCollection: {
            pullRequestReviewContributions: {
              pageInfo: PageInfo;
              nodes: Array<{ pullRequestReview: ReviewNode | null } | null>;
            };
          };
        };
      } = await this.graphql(REVIEW_CONTRIBUTIONS_QUERY, {
        login,
        from: from.toISOString(),
        to: to.toISOString(),
        cursor,
      });
      const page =
        res.user.contributionsCollection.pullRequestReviewContributions;
      for (const node of page.nodes) {
        const review = node?.pullRequestReview;
        if (!review) continue;
        // Only reviews on OTHER people's PRs count as review work.
        if (review.pullRequest.author?.login === login) continue;
        const repo = review.pullRequest.repository.nameWithOwner;
        if (opts.isRepoDenylisted(repo)) continue;
        seen.add(review.id);
        yield this.reviewEvent({
          nodeId: review.id,
          state: review.state,
          body: review.body,
          submittedAt: review.submittedAt,
          comments: review.comments.nodes.filter(Boolean),
          prNumber: review.pullRequest.number,
          prTitle: review.pullRequest.title,
          prAuthor: review.pullRequest.author?.login ?? null,
          headRefName: review.pullRequest.headRefName,
          repo,
          fallbackTimestamp: from.toISOString(),
          raw: review,
        });
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
  }

  /** REST fallback for reviews contributionsCollection didn't surface. */
  private async *searchReviews(
    login: string,
    opts: FetchOptions,
    seen: Set<string>
  ): AsyncIterable<EventRecord> {
    const q = `type:pr reviewed-by:${login} -author:${login} updated:>=${opts.since.toISOString().slice(0, 10)}`;
    const prs: Array<{ number: number; repo: string; title: string; author: string | null }> = [];
    try {
      for await (const page of this.octokit.paginate.iterator(
        this.octokit.rest.search.issuesAndPullRequests,
        { q, per_page: 100 }
      )) {
        for (const item of page.data) {
          const repo = item.repository_url.replace(/.*\/repos\//, "");
          if (opts.isRepoDenylisted(repo)) continue;
          prs.push({
            number: item.number,
            repo,
            title: item.title,
            author: item.user?.login ?? null,
          });
        }
      }
    } catch (err) {
      opts.onProgress?.(
        `warning: review search fallback failed: ${(err as Error).message}`
      );
      return;
    }
    for (const pr of prs) {
      const [owner, repo] = pr.repo.split("/");
      try {
        const reviews = await this.octokit.paginate(
          this.octokit.rest.pulls.listReviews,
          { owner, repo, pull_number: pr.number, per_page: 100 }
        );
        const mine = reviews.filter(
          (r) =>
            r.user?.login === login &&
            !seen.has(r.node_id) &&
            !opts.hasEvent(`${this.prefix}:review:${r.node_id}`)
        );
        if (mine.length === 0) continue;
        const comments = await this.octokit.paginate(
          this.octokit.rest.pulls.listReviewComments,
          { owner, repo, pull_number: pr.number, per_page: 100 }
        );
        const detail = (
          await this.octokit.rest.pulls.get({ owner, repo, pull_number: pr.number })
        ).data;
        for (const r of mine) {
          seen.add(r.node_id);
          yield this.reviewEvent({
            nodeId: r.node_id,
            state: r.state,
            body: r.body ?? null,
            submittedAt: r.submitted_at ?? null,
            comments: comments
              .filter((c) => c.pull_request_review_id === r.id)
              .map((c) => ({ body: c.body, path: c.path })),
            prNumber: pr.number,
            prTitle: pr.title,
            prAuthor: pr.author,
            headRefName: detail.head.ref,
            repo: pr.repo,
            fallbackTimestamp: opts.since.toISOString(),
            raw: r,
          });
        }
      } catch (err) {
        opts.onProgress?.(
          `warning: could not fetch reviews on ${pr.repo}#${pr.number}: ${(err as Error).message}`
        );
      }
    }
  }

  private async *commits(
    login: string,
    repos: Set<string>,
    opts: FetchOptions
  ): AsyncIterable<EventRecord> {
    for (const repoFull of repos) {
      if (opts.isRepoDenylisted(repoFull)) {
        opts.onProgress?.(`skipping denylisted repo ${repoFull}`);
        continue;
      }
      const [owner, repo] = repoFull.split("/");
      const shas: Array<{ sha: string; date: string }> = [];
      try {
        for await (const page of this.octokit.paginate.iterator(
          this.octokit.rest.repos.listCommits,
          {
            owner,
            repo,
            author: login,
            since: opts.since.toISOString(),
            until: opts.until.toISOString(),
            per_page: 100,
          }
        )) {
          shas.push(
            ...page.data.map((c) => ({
              sha: c.sha,
              date:
                c.commit.author?.date ??
                c.commit.committer?.date ??
                opts.since.toISOString(),
            }))
          );
        }
      } catch (err) {
        // 409: empty repository. Anything else is worth surfacing but not fatal for other repos.
        opts.onProgress?.(
          `warning: could not list commits in ${repoFull}: ${(err as Error).message}`
        );
        continue;
      }

      const fresh = shas.filter(
        (c) => !opts.hasEvent(`${this.prefix}:commit:${c.sha}`)
      );
      opts.onProgress?.(
        `${repoFull}: ${shas.length} commits, ${fresh.length} new`
      );

      for (const { sha } of fresh) {
        let detail;
        try {
          detail = (
            await this.octokit.rest.repos.getCommit({ owner, repo, ref: sha })
          ).data;
        } catch (err) {
          opts.onProgress?.(
            `warning: could not fetch ${repoFull}@${sha.slice(0, 7)}: ${(err as Error).message}`
          );
          continue;
        }
        const message = detail.commit.message;
        const [title, ...rest] = message.split("\n");
        const paths = (detail.files ?? [])
          .map((f) => f.filename)
          .slice(0, MAX_COMMIT_PATHS);
        const { issueKeys, prNumbers } = extractTextRefs(message);
        yield {
          id: `${this.prefix}:commit:${sha}`,
          source: "github_commit",
          timestamp:
            detail.commit.author?.date ??
            detail.commit.committer?.date ??
            opts.since.toISOString(),
          repo: repoFull,
          title,
          body: rest.join("\n").trim() || null,
          refs: { issueKeys, prNumbers, branches: [], paths },
          raw: {
            sha,
            stats: detail.stats,
            files: (detail.files ?? []).map((f) => ({
              filename: f.filename,
              additions: f.additions,
              deletions: f.deletions,
              status: f.status,
            })),
            message,
          },
        };
      }
    }
  }
}

function windows(since: Date, until: Date): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = [];
  let start = since.getTime();
  const end = until.getTime();
  while (start < end) {
    const stop = Math.min(start + ONE_YEAR_MS - 1, end);
    out.push([new Date(start), new Date(stop)]);
    start = stop + 1;
  }
  return out;
}
