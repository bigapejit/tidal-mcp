import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  AUTHORIZE_URL,
  SCOPES,
  TOKEN_URL,
  loadSettings,
  loadTokens,
  saveTokens,
  type Settings,
  type Tokens,
} from "./config.js";

const base64url = (buf: Buffer) => buf.toString("base64url");

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  user_id?: number | string;
  user?: { userId?: number | string; countryCode?: string };
  error?: string;
  error_description?: string;
}

async function requestToken(settings: Settings, params: Record<string, string>): Promise<TokenResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams({ client_id: settings.clientId, ...params });
  if (settings.clientSecret) {
    headers.Authorization =
      "Basic " + Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64");
  }
  const res = await fetch(TOKEN_URL, { method: "POST", headers, body });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    const reason = json.error_description ?? json.error ?? `HTTP ${res.status}`;
    throw new Error(`TIDAL token request failed: ${reason}`);
  }
  return json;
}

function toTokens(json: TokenResponse, previous?: Tokens): Tokens {
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

/** Returns a valid access token, refreshing it when needed. */
export async function getTokens(): Promise<Tokens> {
  const settings = await loadSettings();
  const tokens = await loadTokens();
  if (!settings || !tokens) {
    throw new Error("Not signed in to TIDAL. Run `tidal-mcp login --client-id <id>` in a terminal first (see the README).");
  }
  if (Date.now() < tokens.expiresAt) return tokens;
  if (!tokens.refreshToken) {
    throw new Error("TIDAL session expired. Run `tidal-mcp login` again.");
  }
  refreshing ??= requestToken(settings, {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  })
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
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    scope: SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", settings.redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, message: string, result: () => void) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>TIDAL MCP</title>` +
            `<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;background:#111;color:#eee">` +
            `<p>${message}</p></body>`,
        );
        server.close();
        result();
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
        return finish(400, "No authorization code received.", () =>
          reject(new Error("Callback had no authorization code.")),
        );
      }
      finish(200, "Signed in to TIDAL. You can close this tab.", () => resolve(got));
    });
    server.on("error", reject);
    server.listen(Number(redirect.port || 80), "127.0.0.1", () => onUrl(authUrl.toString()));
  });

  const json = await requestToken(settings, {
    grant_type: "authorization_code",
    code,
    redirect_uri: settings.redirectUri,
    code_verifier: verifier,
  });
  const tokens = toTokens(json);
  await saveTokens(tokens);
  return tokens;
}
