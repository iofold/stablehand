/**
 * The Apify actors the scout and measure agents call, as HTTP tools with a
 * hard charge cap.
 *
 * Each tool starts one actor run through Apify's run-sync-get-dataset-items
 * endpoint and returns the run's items. The cap is `maxTotalChargeUsd` in the
 * endpoint URL. The model never sees or edits that URL, and Apify stops
 * charging and ends the run when the cap is reached. The model still writes
 * the actor input (search terms, how many posts), so a careless input costs
 * at most the cap.
 *
 * Apify's hosted MCP server has no equivalent: its actor tools start runs
 * without a charge cap and drop run options passed as arguments. That is why
 * the factory calls Apify's API directly.
 */

export interface ApifyHttpTool {
  name: string;
  description: string;
  endpoint: string;
  method: 'POST';
  inputSchema: Record<string, unknown>;
  authentication: { type: 'bearer'; secretName: 'APIFY_TOKEN' };
  timeoutMs: number;
}

/** The most Apify can charge for one call, in US dollars. */
export const APIFY_CHARGE_CAP_USD = {
  /** The harvestapi actors bill $0.002 per post, so 10 posts cost $0.02. */
  linkedin: 0.05,
  /** apidojo/tweet-scraper bills $0.0004 per tweet, so 20 tweets cost $0.008. */
  x: 0.02,
} as const;

/** Apify ends a run that takes longer than this. */
export const APIFY_RUN_TIMEOUT_SECS = 120;

const LINKEDIN_FIELDS = ['linkedinUrl', 'content', 'author', 'postedAt', 'engagement'];
const X_FIELDS = ['url', 'text', 'author', 'createdAt', 'likeCount', 'retweetCount', 'replyCount', 'quoteCount', 'viewCount'];

function runEndpoint(actor: string, maxTotalChargeUsd: number, limit: number, fields: string[]): string {
  const query = new URLSearchParams({
    maxTotalChargeUsd: String(maxTotalChargeUsd),
    timeout: String(APIFY_RUN_TIMEOUT_SECS),
    clean: 'true',
    limit: String(limit),
    fields: fields.join(','),
  });
  return `https://api.apify.com/v2/acts/${actor.replace('/', '~')}/run-sync-get-dataset-items?${query.toString()}`;
}

const AUTH = { type: 'bearer', secretName: 'APIFY_TOKEN' } as const;
const TIMEOUT_MS = (APIFY_RUN_TIMEOUT_SECS + 30) * 1000;

export const APIFY_LINKEDIN_SEARCH: ApifyHttpTool = {
  name: 'apify_linkedin_search',
  description: 'Search LinkedIn posts through Apify (harvestapi/linkedin-post-search). Returns up to 10 posts with '
    + `author, text, date and engagement. Apify charges $0.002 per post and stops this call at $${APIFY_CHARGE_CAP_USD.linkedin}.`,
  endpoint: runEndpoint('harvestapi/linkedin-post-search', APIFY_CHARGE_CAP_USD.linkedin, 10, LINKEDIN_FIELDS),
  method: 'POST',
  inputSchema: {
    type: 'object',
    properties: {
      searchQueries: { type: 'array', items: { type: 'string' }, description: 'One search query, e.g. ["LLM evals"]' },
      postedLimit: { type: 'string', description: 'Only posts newer than this: "24h", "week" or "month"' },
      sortBy: { type: 'string', description: '"relevance" or "date"' },
      maxPosts: { type: 'integer', description: 'Posts to fetch for the query, at most 10' },
    },
    required: ['searchQueries', 'maxPosts'],
  },
  authentication: AUTH,
  timeoutMs: TIMEOUT_MS,
};

export const APIFY_LINKEDIN_PROFILE_POSTS: ApifyHttpTool = {
  name: 'apify_linkedin_profile_posts',
  description: 'Fetch recent posts from LinkedIn profiles through Apify (harvestapi/linkedin-profile-posts). Returns up '
    + `to 10 posts with text, date and engagement. Apify charges $0.002 per post and stops this call at $${APIFY_CHARGE_CAP_USD.linkedin}.`,
  endpoint: runEndpoint('harvestapi/linkedin-profile-posts', APIFY_CHARGE_CAP_USD.linkedin, 10, LINKEDIN_FIELDS),
  method: 'POST',
  inputSchema: {
    type: 'object',
    properties: {
      targetUrls: { type: 'array', items: { type: 'string' }, description: 'LinkedIn profile URLs' },
      postedLimit: { type: 'string', description: 'Only posts newer than this: "24h", "week" or "month"' },
      maxPosts: { type: 'integer', description: 'Posts to fetch per profile, at most 10' },
    },
    required: ['targetUrls', 'maxPosts'],
  },
  authentication: AUTH,
  timeoutMs: TIMEOUT_MS,
};

export const APIFY_X_POSTS: ApifyHttpTool = {
  name: 'apify_x_posts',
  description: 'Fetch X posts through Apify (apidojo/tweet-scraper), by search terms or by handles. Returns up to 20 '
    + `posts with text, author, date and counts. Apify charges $0.0004 per post and stops this call at $${APIFY_CHARGE_CAP_USD.x}.`,
  endpoint: runEndpoint('apidojo/tweet-scraper', APIFY_CHARGE_CAP_USD.x, 20, X_FIELDS),
  method: 'POST',
  inputSchema: {
    type: 'object',
    properties: {
      searchTerms: { type: 'array', items: { type: 'string' }, description: 'X search queries, e.g. ["LLM evals min_faves:50"]' },
      twitterHandles: { type: 'array', items: { type: 'string' }, description: 'X handles without the @' },
      sort: { type: 'string', description: '"Top" or "Latest"' },
      maxItems: { type: 'integer', description: 'Posts to fetch, at most 20' },
    },
    required: ['maxItems'],
  },
  authentication: AUTH,
  timeoutMs: TIMEOUT_MS,
};

export const SCOUT_APIFY_TOOLS: ApifyHttpTool[] = [APIFY_LINKEDIN_SEARCH, APIFY_X_POSTS, APIFY_LINKEDIN_PROFILE_POSTS];
export const MEASURE_APIFY_TOOLS: ApifyHttpTool[] = [APIFY_LINKEDIN_PROFILE_POSTS, APIFY_X_POSTS];
