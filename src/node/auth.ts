import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AUTHORIZE_URL, TIDAL_SCOPES, pkceChallenge, tidalToken, type TidalTokenResponse } from "../core/tidal.js";
import { loadSettings, loadTokens, saveTokens, type Settings, type Tokens } from "./config.js";

function toTokens(json: TidalTokenResponse, previous?: Tokens): Tokens {
  const userId = json.user_id ?? json.user?.userId;
  return {
    accessToken: json.access_token,
    // TIDAL may omit refresh_token on refresh; keep the one we have.
    refreshToken: json.refresh_token ?? previous?.refreshToken,
    // Refresh a minute early so a request never races expiry.
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    scope: json.scope ?? previous?.scope,
    userId: userId !== undefined ? String(userId) : previous?.userId,
    countryCode: json.user?.countryCode ?? previous?.countryCode,
  };
}

let refreshing: Promise<Tokens> | undefined;

/** Returns valid tokens, refreshing them when needed. */
export async function getTokens(): Promise<Tokens> {
  const settings = await loadSettings();
  const tokens = await loadTokens();
  if (!settings || !tokens) {
    throw new Error("Not signed in to TIDAL. Run `tidal-mcp login --client-id <id>` in a terminal first (see the README).");
  }
  if (Date.now() < tokens.expiresAt) return tokens;
  if (!tokens.refreshToken) throw new Error("TIDAL session expired. Run `tidal-mcp login` again.");
  refreshing ??= tidalToken(settings, { grant_type: "refresh_token", refresh_token: tokens.refreshToken })
    .then(async (json) => {
      const next = toTokens(json, tokens);
      await saveTokens(next);
      return next;
    })
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/**
 * Authorization Code + PKCE against a one-shot localhost callback server.
 * `onUrl` receives the sign-in URL so the caller can print or open it.
 */
export async function login(settings: Settings, onUrl: (url: string) => void): Promise<Tokens> {
  const redirect = new URL(settings.redirectUri);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    scope: TIDAL_SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: await pkceChallenge(verifier),
    state,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", settings.redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, message: string, settle: () => void) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>TIDAL MCP</title>` +
            `<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;background:#111;color:#eee">` +
            `<p>${message}</p></body>`,
        );
        server.close();
        settle();
      };
      const error = url.searchParams.get("error");
      if (error) {
        const detail = url.searchParams.get("error_description") ?? error;
        return finish(400, "Sign-in failed. You can close this tab.", () =>
          reject(new Error(`TIDAL sign-in failed: ${detail}`)),
        );
      }
      if (url.searchParams.get("state") !== state) {
        return finish(400, "Sign-in failed (state mismatch). Try again.", () =>
          reject(new Error("OAuth state mismatch; possible stale or forged callback.")),
        );
      }
      const got = url.searchParams.get("code");
      if (!got) {
        return finish(400, "No authorization code received.", () => reject(new Error("Callback had no code.")));
      }
      finish(200, "Signed in to TIDAL. You can close this tab.", () => resolve(got));
    });
    server.on("error", reject);
    server.listen(Number(redirect.port || 80), "127.0.0.1", () => onUrl(authUrl.toString()));
  });

  const json = await tidalToken(settings, {
    grant_type: "authorization_code",
    code,
    redirect_uri: settings.redirectUri,
    code_verifier: verifier,
  });
  const tokens = toTokens(json);
  await saveTokens(tokens);
  return tokens;
}
