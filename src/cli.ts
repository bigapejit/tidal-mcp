#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Tidal } from "./core/tidal.js";
import { feedbackConfig } from "./core/feedback.js";
import { History } from "./core/history.js";
import { LastFm } from "./core/lastfm.js";
import { createServer } from "./core/tools.js";
import { getTokens, login, openInBrowser } from "./node/auth.js";
import { openHistoryDb } from "./node/history-db.js";
import {
  DEFAULT_PORT,
  clearAll,
  homeDir,
  loadSettings,
  loadTokens,
  redirectUri,
  saveSettings,
} from "./node/config.js";

/** Listening history, when LASTFM_API_KEY and LASTFM_USER are set. */
async function historyFromEnv(): Promise<History | undefined> {
  const apiKey = process.env.LASTFM_API_KEY?.trim();
  const user = process.env.LASTFM_USER?.trim();
  if (!apiKey || !user) return undefined;
  // The server process outlives each tool call, so deferred work just runs on.
  return new History(await openHistoryDb(), new LastFm(apiKey, user), { defer: () => {} });
}

async function runServer() {
  const tidal = new Tidal(async () => (await getTokens()).accessToken, (await loadTokens())?.countryCode);
  const extras = { feedback: feedbackConfig(process.env), history: await historyFromEnv() };
  await createServer(tidal, {}, extras).connect(new StdioServerTransport());
}

/** Imports the whole Last.fm history. Safe to stop and rerun: it picks up where it left off. */
async function syncHistory() {
  const history = await historyFromEnv();
  if (!history) {
    console.error("Set LASTFM_API_KEY and LASTFM_USER first (a Last.fm API key and your Last.fm username).");
    process.exit(1);
  }
  for (;;) {
    const c = await history.sync({ forward: 25, backfill: 25 });
    const since = c.since ? new Date(c.since * 1000).toISOString().slice(0, 10) : "now";
    // Both walks must finish: the backfill (complete) and the one for new scrobbles (current).
    if (c.complete && c.current) return console.log(`Done: history imported back to ${since}.`);
    console.log(
      c.complete
        ? `History imported back to ${since}; importing new scrobbles...`
        : `Imported back to ${since} (${Math.round((c.progress ?? 0) * 100)}%)...`,
    );
  }
}

const HELP = `tidal-mcp: an MCP server for managing TIDAL playlists

Usage:
  tidal-mcp                      Run the MCP server over stdio (what MCP clients call)
  tidal-mcp login [options]      Sign in to TIDAL and save the session
      --client-id <id>           Your app's client id from developer.tidal.com
      --client-secret <secret>   Only if your app has one
      --port <n>                 Callback port (default ${DEFAULT_PORT})
      --no-browser               Print the sign-in URL instead of opening it
  tidal-mcp status               Show whether you're signed in
  tidal-mcp sync-history         Import your Last.fm scrobbles for the history tools
                                 (needs LASTFM_API_KEY and LASTFM_USER)
  tidal-mcp logout               Delete the saved session, settings and history
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case undefined:
      return runServer();

    case "login": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "client-id": { type: "string" },
          "client-secret": { type: "string" },
          port: { type: "string" },
          "no-browser": { type: "boolean", default: false },
        },
      });
      const saved = await loadSettings();
      const clientId = values["client-id"] ?? saved?.clientId;
      if (!clientId) {
        console.error("Missing client id. Create an app at https://developer.tidal.com/dashboard, then run:\n");
        console.error("  tidal-mcp login --client-id <your client id>\n");
        process.exit(1);
      }
      const settings = {
        clientId,
        clientSecret: values["client-secret"] ?? saved?.clientSecret,
        redirectUri: values.port ? redirectUri(Number(values.port)) : (saved?.redirectUri ?? redirectUri(DEFAULT_PORT)),
      };
      await saveSettings(settings);
      console.log(`Make sure this redirect URI is registered on your TIDAL app:\n  ${settings.redirectUri}\n`);
      const tokens = await login(settings, (url) => {
        console.log(`Sign in here:\n  ${url}\n\nWaiting for TIDAL to redirect back...`);
        if (!values["no-browser"]) openInBrowser(url);
      });
      console.log(`\nSigned in${tokens.userId ? ` as user ${tokens.userId}` : ""}. Session saved to ${homeDir()}`);
      return;
    }

    case "status": {
      const [settings, tokens] = await Promise.all([loadSettings(), loadTokens()]);
      if (!settings || !tokens) {
        console.log("Not signed in. Run `tidal-mcp login --client-id <id>`.");
        process.exit(1);
      }
      const fresh = Date.now() < tokens.expiresAt;
      console.log(
        `Signed in${tokens.userId ? ` as user ${tokens.userId}` : ""}. ` +
          `Access token ${fresh ? "valid" : "expired"}${tokens.refreshToken ? ", refreshes automatically" : ""}.`,
      );
      return;
    }

    case "sync-history":
      return syncHistory();

    case "logout":
      await clearAll();
      console.log(`Removed ${homeDir()}`);
      return;

    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
