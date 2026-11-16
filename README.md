# tidal-mcp

An [MCP](https://modelcontextprotocol.io) server that lets ChatGPT, Claude, or any MCP client build and manage your TIDAL playlists.

> "Make me a 25-song playlist of late-90s neo-soul, skip anything over 6 minutes."

It talks to the [official TIDAL API](https://tidal-music.github.io/tidal-api-reference/) with your own developer app. It does not use reverse-engineered endpoints or a shared client id, so a TIDAL app update won't break it.

Run it two ways:

- **Remote, on Cloudflare Workers (free plan).** You get an HTTPS URL for ChatGPT, Claude.ai, or anything else that needs one. Always on.
- **Local, over stdio.** For Claude Code, Claude Desktop, Codex, and other clients that launch a local command.

## Inline view

In clients that support [MCP Apps](https://modelcontextprotocol.io/extensions/apps), including ChatGPT, Claude, and VS Code, results render as a card instead of text:

- **Playlists:** cover, track count, total length, an "Open in TIDAL" button, and the track list.
- **Track lists** (search, matches, similar tracks): album art, artists, album, explicit badges, and durations, 12 at a time.
- **Listening history:** the same rows with play counts or play times, and ranked artists with their pictures.
- **Your library:** a grid of playlist covers, two rows at a time.

Clicking a track or playlist opens it in TIDAL. The card follows the host's light or dark theme. Clients without MCP Apps support get the same results as compact text.

The view is one self-contained page (`src/core/widget.ts`) that talks to the host over the MCP Apps postMessage protocol directly, with no bundle or external scripts. Its only network access is TIDAL's image CDN.

## Feedback from chat

Optionally, the server can expose `send_feedback`: tell the assistant "file this as feedback" and it writes up the problem and opens a GitHub issue labeled `feedback`. Enable it with two Worker secrets (or env vars for the local server):

```sh
npx wrangler secret put FEEDBACK_REPO    # owner/name, e.g. you/tidal-mcp
npx wrangler secret put GITHUB_TOKEN     # fine-grained token: that one repo, Issues read & write, Pull requests read
```

Issues are public, so the tool tells the model to leave out personal details. Without these secrets the tool doesn't exist.

This repo goes one step further: a GitHub webhook hands each `feedback` issue to a coding agent, which opens a PR. CodeRabbit and CI review the PR, then the agent merges and deploys it.

## Listening history (Last.fm)

TIDAL's API has no listening history, but TIDAL can scrobble to [Last.fm](https://www.last.fm). With a Last.fm account connected to TIDAL, the server adds `listening_history`, `top_tracks` and `top_artists`. They answer "what did I play last week", "my most-played Khruangbin songs" and "who did I listen to most in 2024" with real play counts, and match tracks and artists to TIDAL so the results can go straight into a playlist.

Scrobbles are copied into a database (Cloudflare D1 on the Worker, SQLite locally), so a ranking over years of history is one query. TIDAL matches are cached after the first lookup.

**Remote:** set two Worker secrets ([get an API key](https://www.last.fm/api/account/create)):

```sh
npx wrangler secret put LASTFM_API_KEY
npx wrangler secret put LASTFM_USER         # your Last.fm username
```

The D1 database and a 5-minute cron are in `wrangler.jsonc`; Wrangler creates the database on deploy. Each cron run imports new scrobbles and continues the initial import, which stays under the free plan's daily D1 write limit, so a large history (100k scrobbles) takes about two days to finish. The tools work meanwhile and say how far back the data goes. Only the first account in `ALLOWED_TIDAL_USER_IDS` gets these tools, since the history is yours; without that secret, nobody does.

**Local:** set `LASTFM_API_KEY` and `LASTFM_USER` in the environment the MCP client starts the server with, and import once with `node dist/cli.js sync-history` (a few minutes; rerun it any time). The server then keeps the data current on its own. Needs Node 22.13 or newer.

## Tools

| Tool | What it does |
| --- | --- |
| `search_tracks` | Search the catalog for tracks |
| `find_tracks` | Turn a list of "Artist - Title" strings into track ids in one call |
| `similar_tracks` | Tracks TIDAL considers similar to a given track |
| `list_my_playlists` | Your playlists, most recently changed first |
| `get_playlist` | A playlist's details and tracks |
| `create_playlist` | Create a playlist, optionally filled with tracks |
| `add_tracks` | Append tracks (skips duplicates by default) |
| `remove_tracks` | Remove tracks from a playlist |
| `update_playlist` | Rename, re-describe, or change visibility |
| `delete_playlist` | Delete a playlist (annotated as destructive, so clients ask first) |
| `listening_history` | What you played, newest first, for any period (only with Last.fm configured) |
| `top_tracks` | Your most-played tracks with play counts, optionally for one artist or period |
| `top_artists` | Your most-played artists with play counts |
| `send_feedback` | File feedback as a GitHub issue and show a live tracker until it ships (only when configured) |
| `feedback_status` | Where a filed issue is: queued, building, in review, shipping, live, or blocked |

## 1. Create a TIDAL developer app

1. Go to the [TIDAL Developer Dashboard](https://developer.tidal.com/dashboard), sign in, and create an app.
2. Under **Settings → Edit**, add your redirect URIs:
   - Remote: `https://<your-worker>.workers.dev/callback` (you'll know the URL after the first deploy)
   - Local: `http://127.0.0.1:8765/callback`
3. Enable these scopes: `user.read`, `search.read`, `playlists.read`, `playlists.write`, `collection.read`
4. Copy the **Client ID**. No client secret is needed; sign-in uses PKCE.

## 2a. Remote: deploy to Cloudflare

You need Node 20+ and a free Cloudflare account.

```sh
git clone https://github.com/bigapejit/tidal-mcp.git
cd tidal-mcp
npm install
npx wrangler login
npx wrangler deploy                                  # prints your workers.dev URL; creates the KV store
npx wrangler secret put TIDAL_CLIENT_ID              # paste your client id
npx wrangler secret put ALLOWED_TIDAL_USER_IDS       # optional: your TIDAL user id, so only you can connect
```

Add `https://<your-worker>.workers.dev/callback` to your TIDAL app's redirect URIs. Your MCP URL is `https://<your-worker>.workers.dev/mcp`.

To find your TIDAL user id, set `ALLOWED_TIDAL_USER_IDS` to `0`, connect once, and read the id from the "isn't open to your TIDAL account" page. If you've used the local setup, `node dist/cli.js status` also prints it.

**ChatGPT:** Plugins → **Add** → **Add custom MCP server**. Paste the MCP URL, keep authentication on **OAuth**, and create it. ChatGPT sends you through a consent page and then TIDAL's own sign-in.

**Claude.ai:** Settings → Connectors → **Add custom connector**, then paste the MCP URL.

How it works: the Worker is an OAuth 2.1 authorization server for MCP clients ([`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)), and it signs you in through TIDAL. Your TIDAL tokens are stored only inside the encrypted grant in KV, and they refresh whenever the client refreshes its token. Requests are stateless, so no Durable Objects are needed, and normal use stays well inside the free plan.

## 2b. Local: run over stdio

```sh
git clone https://github.com/bigapejit/tidal-mcp.git
cd tidal-mcp
npm install          # also builds
node dist/cli.js login --client-id YOUR_CLIENT_ID
```

A browser opens to TIDAL's sign-in page. The session is saved to `~/.tidal-mcp/`, readable only by your user, and refreshes automatically. Use `--no-browser` to print the URL instead, and `--port` if 8765 is taken (then register that redirect URI instead).

Then point your client at it, using the absolute path to `dist/cli.js`:

```sh
claude mcp add tidal -- node /absolute/path/to/tidal-mcp/dist/cli.js     # Claude Code
codex mcp add tidal -- node /absolute/path/to/tidal-mcp/dist/cli.js      # Codex
```

```json
{
  "mcpServers": {
    "tidal": { "command": "node", "args": ["/absolute/path/to/tidal-mcp/dist/cli.js"] }
  }
}
```

The JSON form is for Claude Desktop and other clients that use a config file.

```
node dist/cli.js            Run the MCP server over stdio
node dist/cli.js login      Sign in to TIDAL
node dist/cli.js status     Check whether you're signed in
node dist/cli.js sync-history   Import your Last.fm history (see Listening history)
node dist/cli.js logout     Delete the saved session, settings and history
```

`TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET`, and `TIDAL_MCP_HOME` (the session folder) can also be set as environment variables.

> An unrelated package on npm is already named `tidal-mcp`. Run this project from your clone as shown above, not with `npx tidal-mcp`.

## Notes

- New playlists are **unlisted** unless you ask for a public one.
- Search and availability follow your account's country.
- Writes send an `Idempotency-Key`, so a retried request never adds tracks twice.

## Project layout

```
src/core/     TIDAL API client, MCP tools, and the inline view (runtime-neutral: fetch + Web Crypto)
src/node/     Local login flow and token storage
src/worker/   Cloudflare Worker: OAuth server, TIDAL sign-in, stateless MCP endpoint
src/cli.ts    Local entry point (stdio server + login/status/logout)
```

## License

MIT
