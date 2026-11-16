/**
 * Files user feedback as GitHub issues and reports how far each one is from shipping.
 * Runtime-neutral: plain fetch.
 *
 * Progress is read from the repo itself, following the agent's conventions in .agents/feedback-run.md:
 * labels `agent:working` / `agent:done` / `agent:blocked`, and a PR from branch `agent/issue-<n>`.
 */

export interface FeedbackConfig {
  /** "owner/name" of the repository that receives issues. */
  repo: string;
  /** Fine-grained token for that repo: Issues read & write, Pull requests read. */
  token: string;
}

export interface Feedback {
  title: string;
  body: string;
  kind: "bug" | "idea" | "ux";
}

/** Every filed issue carries this label; automation keys off it. */
export const FEEDBACK_LABEL = "feedback";

export type Stage = "queued" | "building" | "review" | "shipping" | "live" | "blocked" | "closed";

export interface FeedbackStatus {
  number: number;
  title: string;
  url: string;
  stage: Stage;
  /** One line for the user, e.g. "CodeRabbit and CI are reviewing the fix". */
  detail: string;
  filedAt: string;
  /** When it reached `live`, if it has. */
  shippedAt?: string;
  pr?: { number: number; url: string; state: "open" | "merged" | "closed" };
  /** Typical minutes from filing to shipped, from this repo's recent history. */
  typicalMinutes: number;
}

/** Used until the repo has shipped a few feedback issues of its own. */
const DEFAULT_TYPICAL_MINUTES = 35;

export function feedbackConfig(env: { GITHUB_TOKEN?: string; FEEDBACK_REPO?: string }): FeedbackConfig | undefined {
  const repo = env.FEEDBACK_REPO?.trim();
  const token = env.GITHUB_TOKEN?.trim();
  if (!repo || !token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
  return { repo, token };
}

async function github<T>(config: FeedbackConfig, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${config.repo}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tidal-mcp",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed (${res.status}): ${json.message ?? "unknown error"}`);
  return json;
}

interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  created_at: string;
  closed_at: string | null;
  labels: { name: string }[];
  pull_request?: unknown;
}
interface GhPull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
}

export async function fileIssue(config: FeedbackConfig, feedback: Feedback, context: { version: string }) {
  const body =
    `${feedback.body.trim()}\n\n---\n` +
    `<sub>Filed from a chat through the tidal-mcp \`send_feedback\` tool (v${context.version}, ${feedback.kind}).</sub>`;
  const issue = await github<GhIssue>(config, "/issues", {
    method: "POST",
    body: { title: feedback.title.trim(), body, labels: [FEEDBACK_LABEL, feedback.kind] },
  });
  return issue;
}

/** Median filed-to-shipped time over recently shipped feedback, in minutes. */
async function typicalMinutes(config: FeedbackConfig): Promise<number> {
  const shipped = await github<GhIssue[]>(config, "/issues?labels=agent:done&state=closed&per_page=20").catch(() => []);
  const minutes = shipped
    .filter((i) => i.closed_at && !i.pull_request)
    .map((i) => (Date.parse(i.closed_at!) - Date.parse(i.created_at)) / 60_000)
    .filter((m) => m > 0 && m < 24 * 60)
    .sort((a, b) => a - b);
  if (minutes.length < 2) return DEFAULT_TYPICAL_MINUTES;
  return Math.round(minutes[Math.floor(minutes.length / 2)]);
}

async function agentPull(config: FeedbackConfig, issue: number): Promise<GhPull | undefined> {
  const owner = config.repo.split("/")[0];
  const pulls = await github<GhPull[]>(
    config,
    `/pulls?state=all&head=${encodeURIComponent(`${owner}:agent/issue-${issue}`)}&per_page=5`,
  ).catch(() => []);
  return pulls[0];
}

export async function feedbackStatus(config: FeedbackConfig, issueNumber?: number, known?: GhIssue): Promise<FeedbackStatus> {
  let issue = known;
  if (!issue && issueNumber === undefined) {
    const [latest] = await github<GhIssue[]>(
      config,
      `/issues?labels=${FEEDBACK_LABEL}&state=all&sort=created&direction=desc&per_page=1`,
    );
    if (!latest) throw new Error("No feedback has been filed yet.");
    issue = latest;
  }
  issue ??= await github<GhIssue>(config, `/issues/${issueNumber}`);

  const [pull, typical] = await Promise.all([agentPull(config, issue.number), typicalMinutes(config)]);
  const labels = new Set(issue.labels.map((l) => l.name));
  const pr = pull && {
    number: pull.number,
    url: pull.html_url,
    state: pull.merged_at ? ("merged" as const) : pull.state,
  };

  let stage: Stage;
  let detail: string;
  if (labels.has("agent:done")) {
    stage = "live";
    detail = "Shipped. Try it again in a new message.";
  } else if (labels.has("agent:blocked")) {
    stage = "blocked";
    detail = "The agent needs a decision from you. Open the issue to answer.";
  } else if (pr?.state === "merged") {
    stage = "shipping";
    detail = "Merged. Deploying to the live server.";
  } else if (pr?.state === "open") {
    stage = "review";
    detail = "Fix is up for review: CodeRabbit and CI are checking it.";
  } else if (labels.has("agent:working")) {
    stage = "building";
    detail = "An agent is reproducing the problem and writing the fix.";
  } else if (issue.state === "closed") {
    stage = "closed";
    detail = "Closed without shipping a change.";
  } else {
    stage = "queued";
    detail = "Filed. An agent picks it up within a minute or two.";
  }

  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    stage,
    detail,
    filedAt: issue.created_at,
    shippedAt: stage === "live" ? issue.closed_at ?? undefined : undefined,
    pr,
    typicalMinutes: typical,
  };
}

/** Compact text for the model. */
export function describeStatus(s: FeedbackStatus): string {
  const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(s.filedAt)) / 60_000));
  const eta =
    s.stage === "live" || s.stage === "blocked" || s.stage === "closed"
      ? ""
      : ` Filed ${elapsed} min ago; fixes here typically ship in about ${s.typicalMinutes} min.`;
  return `Issue #${s.number} "${s.title}": ${s.stage}. ${s.detail}${eta}${s.pr ? ` PR #${s.pr.number} (${s.pr.state}).` : ""} ${s.url}`;
}
