/**
 * Files user feedback as a GitHub issue, so it can be triaged (or picked up by automation)
 * like any other issue. Runtime-neutral: plain fetch.
 */

export interface FeedbackConfig {
  /** "owner/name" of the repository that receives issues. */
  repo: string;
  /** Token allowed to create issues there (a fine-grained PAT with Issues: write is enough). */
  token: string;
}

export interface Feedback {
  title: string;
  body: string;
  kind: "bug" | "idea" | "ux";
}

/** Every filed issue carries this label; automation keys off it. */
export const FEEDBACK_LABEL = "feedback";

export function feedbackConfig(env: { GITHUB_TOKEN?: string; FEEDBACK_REPO?: string }): FeedbackConfig | undefined {
  const repo = env.FEEDBACK_REPO?.trim();
  const token = env.GITHUB_TOKEN?.trim();
  if (!repo || !token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
  return { repo, token };
}

export async function fileIssue(
  config: FeedbackConfig,
  feedback: Feedback,
  context: { version: string },
): Promise<{ number: number; url: string }> {
  const body =
    `${feedback.body.trim()}\n\n---\n` +
    `<sub>Filed from a chat through the tidal-mcp \`send_feedback\` tool (v${context.version}, ${feedback.kind}).</sub>`;
  const res = await fetch(`https://api.github.com/repos/${config.repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "tidal-mcp",
    },
    body: JSON.stringify({ title: feedback.title.trim(), body, labels: [FEEDBACK_LABEL, feedback.kind] }),
  });
  const json = (await res.json().catch(() => ({}))) as { number?: number; html_url?: string; message?: string };
  if (!res.ok || !json.html_url || json.number === undefined) {
    throw new Error(`Couldn't file the issue on GitHub (${res.status}): ${json.message ?? "unknown error"}`);
  }
  return { number: json.number, url: json.html_url };
}
