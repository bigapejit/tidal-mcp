/**
 * Remote MCP server on Cloudflare Workers, for ChatGPT and other clients that need an HTTPS URL.
 *
 * The Worker is the OAuth authorization server for MCP clients, and signs people in through TIDAL:
 * MCP client -> /authorize (consent) -> TIDAL login -> /callback -> MCP client gets a token.
 * TIDAL tokens live encrypted in the grant's props (KV), never in plain storage.
 */
import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  OAuthError,
  authorizationErrorRedirect,
  getOAuthApi,
  type ConsentDescription,
  type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { AUTHORIZE_URL, TIDAL_SCOPES, Tidal, TidalError, pkceChallenge, tidalToken } from "../core/tidal.js";
import { feedbackConfig } from "../core/feedback.js";
import { History, type Sql } from "../core/history.js";
import { LastFm } from "../core/lastfm.js";
import { createServer } from "../core/tools.js";

interface Env {
  OAUTH_KV: KVNamespace;
  TIDAL_CLIENT_ID: string;
  TIDAL_CLIENT_SECRET?: string;
  /** Comma-separated TIDAL user ids allowed to connect. Unset: any TIDAL account may. */
  ALLOWED_TIDAL_USER_IDS?: string;
  /** Optional: enables send_feedback, filing issues on FEEDBACK_REPO ("owner/name"). */
  GITHUB_TOKEN?: string;
  FEEDBACK_REPO?: string;
  /** Optional: enable the listening-history tools for the first account in ALLOWED_TIDAL_USER_IDS. */
  LASTFM_API_KEY?: string;
  LASTFM_USER?: string;
  HISTORY_DB?: D1Database;
}

/** What each MCP grant carries (encrypted at rest by the OAuth library). */
interface Props {
  tidalUserId: string;
  countryCode?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the TIDAL access token expires. */
  expiresAt: number;
}

const MCP_SCOPE = "playlists";

const client = (env: Env) => ({ clientId: env.TIDAL_CLIENT_ID, clientSecret: env.TIDAL_CLIENT_SECRET });

const secondsLeft = (props: Props) => Math.max(60, Math.floor((props.expiresAt - Date.now()) / 1000) - 60);

// ---------------------------------------------------------------- Listening history

/**
 * Rows the history backfill may write per UTC day. D1's free plan allows 100k across the account,
 * so this leaves room for new scrobbles, TIDAL matches and other databases.
 */
const HISTORY_DAILY_WRITES = 60_000;
/**
 * Last.fm pages per cron run, budgeted separately so a busy day (more than 200 plays to re-read)
 * can't starve the backfill. About 1 ms of CPU each, against the free plan's 10 ms.
 */
const HISTORY_PAGES_PER_RUN = { forward: 2, backfill: 2 };

const d1Sql = new WeakMap<D1Database, Sql>();

function history(env: Env, ctx?: ExecutionContext): History | undefined {
  const apiKey = env.LASTFM_API_KEY?.trim();
  const user = env.LASTFM_USER?.trim();
  const db = env.HISTORY_DB;
  if (!apiKey || !user || !db) return undefined;
  let sql = d1Sql.get(db);
  if (!sql) {
    sql = {
      async all<T>(query: string, params: unknown[] = []) {
        return (await db.prepare(query).bind(...params).all<T>()).results;
      },
      async batch(statements) {
        const results = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? []))));
        return results.map((r) => r.meta.rows_written ?? r.meta.changes ?? 0);
      },
    };
    d1Sql.set(db, sql);
  }
  return new History(sql, new LastFm(apiKey, user), {
    dailyWrites: HISTORY_DAILY_WRITES,
    defer: ctx && ((work) => ctx.waitUntil(work)),
  });
}

/**
 * The scrobbles are one person's, so only the first account in ALLOWED_TIDAL_USER_IDS sees them.
 * Without an allow-list, nobody does.
 */
const historyOwner = (env: Env) =>
  env.ALLOWED_TIDAL_USER_IDS?.split(",")
    .map((s) => s.trim())
    .find(Boolean);

// ---------------------------------------------------------------- MCP endpoint

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: Props }): Promise<Response> {
    const props = ctx.props;
    if (Date.now() >= props.expiresAt) {
      // Our token outlived TIDAL's; make the client refresh, which refreshes TIDAL too.
      return new Response("TIDAL session expired", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer error="invalid_token", error_description="TIDAL token expired"' },
      });
    }
    const tidal = new Tidal(async () => props.accessToken, props.countryCode);
    const server = createServer(
      tidal,
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
      {
        feedback: feedbackConfig(env),
        history: props.tidalUserId === historyOwner(env) ? history(env, ctx) : undefined,
      },
    );
    // Stateless: every request is self-contained, so no Durable Objects are needed.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

// ---------------------------------------------------------------- Sign-in pages

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --ink:#111; --muted:#5f5f5a; --line:#e3e3df; --accent:#111; --accent-ink:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0b0b; --card:#161616; --ink:#f2f2f2; --muted:#a3a3a3; --line:#2a2a2a; --accent:#f2f2f2; --accent-ink:#0b0b0b; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px; }
  h1 { font-size:20px; line-height:1.3; margin:0 0 12px; }
  p { margin:0 0 12px; color:var(--muted); }
  strong { color:var(--ink); }
  ul { margin:0 0 20px; padding-left:20px; color:var(--muted); }
  .warn { color:#b45309; }
  .row { display:flex; gap:10px; margin-top:20px; }
  button { flex:1; font:inherit; font-weight:600; padding:12px 16px; border-radius:10px; border:1px solid var(--line); background:transparent; color:var(--ink); cursor:pointer; }
  button.primary { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
  button:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
</style>
<main>${body}</main></html>`;
  return new Response(html, { status, headers });
}

function consentPage(d: ConsentDescription, handle: string, headers: Headers): Response {
  const name = escape(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escape(d.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  return page(
    `Connect ${d.clientName} to TIDAL`,
    `<h1>Let ${name} manage your TIDAL playlists?</h1>
<p>${origin} Access goes to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>` : ""}
<p>It will be able to:</p>
<ul><li>Search the TIDAL catalog</li><li>See your playlists</li><li>Create, edit and delete your playlists</li></ul>
<p>Next you'll sign in to TIDAL.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <div class="row">
    <button name="decision" value="deny">Cancel</button>
    <button class="primary" name="decision" value="approve">Continue to TIDAL</button>
  </div>
</form>`,
    200,
    headers,
  );
}

const errorPage = (message: string, status = 400) =>
  page("Couldn't connect", `<h1>Couldn't connect to TIDAL</h1><p>${escape(message)}</p>`, status);

const redirect = (location: string, headers = new Headers()) => {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
};

const signIn = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const oauth = getOAuthApi(providerOptions(url.origin), env);
    try {
      if (url.pathname === "/authorize" && request.method === "GET") {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        return consentPage(details, consent.handle, consent.headers);
      }

      if (url.pathname === "/authorize" && request.method === "POST") {
        const form = await request.formData();
        const handle = String(form.get("handle"));
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(request, handle);
        const verifier = crypto.randomUUID() + crypto.randomUUID();
        const { state, headers } = await oauth.beginUpstream(approved.request, {
          data: { verifier },
          headers: approved.headers,
        });
        const tidalUrl = new URL(AUTHORIZE_URL);
        tidalUrl.search = new URLSearchParams({
          response_type: "code",
          client_id: env.TIDAL_CLIENT_ID,
          redirect_uri: `${url.origin}/callback`,
          scope: TIDAL_SCOPES.join(" "),
          code_challenge_method: "S256",
          code_challenge: await pkceChallenge(verifier),
          state,
        }).toString();
        return redirect(tidalUrl.toString(), headers);
      }

      if (url.pathname === "/callback") {
        const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
        const code = url.searchParams.get("code");
        if (url.searchParams.get("error") || !code) {
          return redirect(authorizationErrorRedirect(original, "access_denied"), headers);
        }
        const token = await tidalToken(client(env), {
          grant_type: "authorization_code",
          code,
          redirect_uri: `${url.origin}/callback`,
          code_verifier: data.verifier,
        });
        const me = await new Tidal(async () => token.access_token).me();
        const allowed = env.ALLOWED_TIDAL_USER_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
        if (allowed?.length && !allowed.includes(me.id)) {
          return errorPage(`This server isn't open to your TIDAL account (user id ${me.id}).`, 403);
        }
        const props: Props = {
          tidalUserId: me.id,
          countryCode: me.country ?? token.user?.countryCode,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + token.expires_in * 1000,
        };
        const { redirectTo } = await oauth.completeAuthorization({
          request: original,
          userId: me.id,
          metadata: {},
          scope: original.scope,
          props,
        });
        return redirect(redirectTo, headers);
      }

      if (url.pathname === "/") {
        return page(
          "TIDAL MCP",
          `<h1>TIDAL MCP server</h1><p>Add <strong>${escape(url.origin)}/mcp</strong> as a connector in ChatGPT, Claude or any MCP client.</p>
<p><a href="https://github.com/bigapejit/tidal-mcp">Source on GitHub</a></p>`,
        );
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return redirect(error.redirectTo);
      if (error instanceof AuthorizationError) return errorPage(error.description ?? "The sign-in link expired. Start again from your app.");
      if (error instanceof CimdFetchError) return errorPage("This app could not be verified.");
      if (error instanceof TidalError) return errorPage(error.message, 502);
      throw error;
    }
  },
};

// ---------------------------------------------------------------- Token lifetimes

async function tokenExchangeCallback({ grantType, props, env }: TokenExchangeCallbackOptions<Env>) {
  const current = props as Props;
  if (grantType === "authorization_code") {
    // Expire our access token with TIDAL's, so the client refreshes both together.
    return { accessTokenTTL: secondsLeft(current) };
  }
  if (grantType !== "refresh_token") return;
  if (current.expiresAt - Date.now() > 5 * 60_000) return { accessTokenTTL: secondsLeft(current) };
  if (!current.refreshToken) {
    throw new OAuthError("invalid_grant", { description: "TIDAL session can't be refreshed; reconnect." });
  }
  try {
    const token = await tidalToken(client(env), {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
    });
    const next: Props = {
      ...current,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? current.refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
    return { newProps: next, accessTokenTTL: secondsLeft(next) };
  } catch (err) {
    if (err instanceof TidalError && (err.code === "invalid_grant" || err.code === "invalid_client")) {
      throw new OAuthError("invalid_grant", { description: "TIDAL access was revoked; reconnect." });
    }
    throw new OAuthError("temporarily_unavailable", { description: "TIDAL is unavailable", statusCode: 503 });
  }
}

// ---------------------------------------------------------------- Wiring

/** Options depend on the public origin, which is only known per request. */
function providerOptions(origin: string) {
  return {
    apiRoute: "/mcp",
    apiHandler: mcpHandler as any,
    defaultHandler: signIn as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [MCP_SCOPE],
    requiredScopes: [MCP_SCOPE],
    resourceMetadata: { resource: `${origin}/mcp` },
    refreshTokenTTL: 90 * 24 * 3600,
    tokenExchangeCallback,
  };
}

const providers = new Map<string, OAuthProvider<Env>>();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = new URL(request.url).origin;
    let provider = providers.get(origin);
    if (!provider) providers.set(origin, (provider = new OAuthProvider<Env>(providerOptions(origin))));
    return provider.fetch(request, env, ctx);
  },

  /** Cron: imports new scrobbles and continues the history backfill. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const h = history(env);
    if (!h) return;
    const c = await h.sync(HISTORY_PAGES_PER_RUN);
    if (!c.complete) {
      const since = c.since ? new Date(c.since * 1000).toISOString().slice(0, 10) : "?";
      console.log(`History import ${Math.round((c.progress ?? 0) * 100)}% done, back to ${since}`);
    }
  },
} satisfies ExportedHandler<Env>;
