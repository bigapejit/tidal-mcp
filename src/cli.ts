#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Tidal } from "./core/tidal.js";
import { createServer } from "./core/tools.js";
import { getTokens, login, openInBrowser } from "./node/auth.js";
import {
  DEFAULT_PORT,
  clearAll,
  homeDir,
  loadSettings,
  loadTokens,
  redirectUri,
  saveSettings,
} from "./node/config.js";

async function runServer() {
  const tidal = new Tidal(async () => (await getTokens()).accessToken, (await loadTokens())?.countryCode);
  await createServer(tidal).connect(new StdioServerTransport());
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
  tidal-mcp logout               Delete the saved session and settings
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
