export const VIEWER_QUERY = `
query {
  viewer { login }
}
`;

export const COMMIT_REPOS_QUERY = `
query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner isPrivate }
        contributions { totalCount }
      }
    }
  }
}
`;

export const PR_CONTRIBUTIONS_QUERY = `
query ($login: String!, $from: DateTime!, $to: DateTime!, $cursor: String) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      pullRequestContributions(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          pullRequest {
            id
            number
            title
            body
            state
            merged
            createdAt
            mergedAt
            closedAt
            headRefName
            baseRefName
            additions
            deletions
            changedFiles
            repository { nameWithOwner isPrivate }
          }
        }
      }
    }
  }
}
`;

export const REVIEW_CONTRIBUTIONS_QUERY = `
query ($login: String!, $from: DateTime!, $to: DateTime!, $cursor: String) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      pullRequestReviewContributions(first: 25, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          pullRequestReview {
            id
            state
            body
            submittedAt
            comments(first: 50) {
              nodes { body path }
            }
            pullRequest {
              number
              title
              headRefName
              author { login }
              repository { nameWithOwner isPrivate }
            }
          }
        }
      }
    }
  }
}
`;

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface PrNode {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged: boolean;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  repository: { nameWithOwner: string; isPrivate: boolean };
}

export interface ReviewNode {
  id: string;
  state: string;
  body: string | null;
  submittedAt: string | null;
  comments: { nodes: Array<{ body: string; path: string | null }> };
  pullRequest: {
    number: number;
    title: string;
    headRefName: string;
    author: { login: string } | null;
    repository: { nameWithOwner: string; isPrivate: boolean };
  };
}

export interface CommitRepoEntry {
  repository: { nameWithOwner: string; isPrivate: boolean };
  contributions: { totalCount: number };
}
