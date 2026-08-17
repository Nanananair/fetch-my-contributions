import { Octokit } from "octokit";
import type { HostAuth } from "./auth.js";

/**
 * Octokit factory. The `octokit` meta-package ships with the retry and
 * throttling plugins enabled and `octokit.paginate` built in.
 */
export function makeOctokit(auth: HostAuth): Octokit {
  const isDotCom = auth.host === "github.com";
  return new Octokit({
    auth: auth.token,
    baseUrl: isDotCom ? "https://api.github.com" : `https://${auth.host}/api/v3`,
    userAgent: "fetch-my-contributions",
    throttle: {
      onRateLimit: (retryAfter: number, _opts: unknown, _o: unknown, retryCount: number) => {
        console.warn(`  rate limited; retrying in ${retryAfter}s`);
        return retryCount < 3;
      },
      onSecondaryRateLimit: (retryAfter: number, _opts: unknown, _o: unknown, retryCount: number) => {
        console.warn(`  secondary rate limit; retrying in ${retryAfter}s`);
        return retryCount < 3;
      },
    },
  });
}

/** GHE serves GraphQL at /api/graphql, not /api/v3/graphql. */
export function graphqlFor(octokit: Octokit, host: string) {
  if (host === "github.com") return octokit.graphql;
  return octokit.graphql.defaults({
    baseUrl: `https://${host}/api`,
  });
}
