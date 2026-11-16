# tidal-mcp

MCP server for TIDAL playlists. One codebase, two runtimes: `src/core` (runtime-neutral client, tools, inline view) is shared by `src/cli.ts` (local stdio) and `src/worker` (Cloudflare Worker that ChatGPT connects to). Layout and setup are in `README.md`.

## Checking a change

- `npm run check` must pass: both typechecks, a parse check of the view's script, and the history boundary tests (`scripts/test-history.mjs`, offline).
- Live-test tool changes against the real TIDAL API: `npm run build && node scripts/call-tool.mjs <tool> '<json>' [--json]`. It prints timings, which matter here (users notice slow tool chains). The local session in `~/.tidal-mcp` is the owner's real account: read freely, and only create, edit or delete playlists you made for the test, deleting them afterwards.
- The history tools (`src/core/history.ts`) appear locally only with `LASTFM_API_KEY` and `LASTFM_USER` in the environment (values in `.dev.vars`), and read `~/.tidal-mcp/history.sqlite`. Run `node dist/cli.js sync-history` first if that file is missing or stale.

## Rules no config will tell you

- **Bump `VERSION`** in `src/core/tools.ts` (and `package.json`) for any change to tools or the view. The view's `ui://` URI embeds it, and ChatGPT caches templates by URI, so a stale version means users keep seeing the old view.
- **The view is a `String.raw` literal** (`src/core/widget.ts`): it must not contain a backtick or `${`. Tool data goes into the DOM through `textContent` only. Its CSP allows images from `https://resources.tidal.com` only, so new image hosts need adding to `resourceDomains` in `tools.ts`.
- **Tool text is for the model, `structuredContent` is for the view.** Keep text compact. Visual tools end with the view hint so the model doesn't restate the list.
- **Fewer round trips beat more tools.** If a common request needs two sequential tool calls, give one tool a parameter that does both.
- **Worker config is secrets, not `vars`**: `TIDAL_CLIENT_ID`, `ALLOWED_TIDAL_USER_IDS`, `GITHUB_TOKEN`, `FEEDBACK_REPO`, `LASTFM_API_KEY`, `LASTFM_USER`. A `vars` entry would collide with a secret and clobber it on deploy. For local runs, the owner's values for the Last.fm pair live in `.dev.vars` in the root checkout (gitignored; copy it into a worktree, never commit it).
- **Cloudflare free plan is the budget.** New bindings (D1, cron triggers) go in `wrangler.jsonc`; leave IDs out and Wrangler provisions them on deploy, as it did for `OAUTH_KV`. Limits that shape designs: 50 subrequests per invocation, D1 at 100k rows written and 5M rows read per day. Bulk imports must resume across runs and days.
- **Deploying** is `npm run deploy` from an up-to-date `main` on the owner's machine (Wrangler is logged in there). There is no deploy from CI.
- **After a deploy that changes tool names, descriptions or schemas,** ChatGPT keeps the old definitions until someone clicks **Refresh tools** at https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_6afa71a11db08191a6d5a70c8ed47cfe (the T3 browser is signed in to ChatGPT).
- **A new TIDAL scope** (e.g. `recommendations.read` for mixes) takes three steps, all doable in the signed-in T3 browser: enable it on the app at https://developer.tidal.com/dashboard (app `tidal-mcp`, Settings → Edit), add it to `TIDAL_SCOPES` in `src/core/tidal.ts`, and after deploying reconnect TIDAL from the ChatGPT plugin settings page so the grant includes it. Re-run `node dist/cli.js login` for the local session too. Until a user reconnects, tools needing the scope should return a clear "reconnect TIDAL" error, not a raw 403.
- **TIDAL's API has no listening-history endpoint.** The closest signals are personalized mixes (`userDailyMixes`, `userDiscoveryMixes`, `userRecommendationBlocks`) and TIDAL-generated playlists in the user's library (check `playlistType`).
- The npm name `tidal-mcp` belongs to an unrelated package; docs should only ever say to run this project from a clone.
- **Subagents run on Opus or Fable, never Sonnet or Haiku** (the owner's rule). Some built-in agent types, such as web fetch, default to Haiku, so pass `model` explicitly whenever you spawn one.

## Reviews

CodeRabbit reviews every PR (config in `.coderabbit.yaml`), and CI runs `npm run check` plus a Worker dry-run bundle. Fix every critical or major finding, and anything that could leak tokens, weaken the OAuth checks, or let another TIDAL account connect. Collect remaining minor findings into one follow-up issue linked from the PR.
