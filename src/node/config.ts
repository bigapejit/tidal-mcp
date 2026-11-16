import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 8765;

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

export interface Settings {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
  userId?: string;
  countryCode?: string;
}

/** Everything lives in one folder so `logout` can remove it cleanly. */
export function homeDir(): string {
  return process.env.TIDAL_MCP_HOME ?? join(homedir(), ".tidal-mcp");
}

const settingsPath = () => join(homeDir(), "settings.json");
const tokensPath = () => join(homeDir(), "tokens.json");

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(homeDir(), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  // writeFile's mode only applies on create; tighten an existing file too.
  await chmod(path, 0o600).catch(() => {});
}

/** Env vars win over the saved file, so an MCP client config can override login-time values. */
export async function loadSettings(): Promise<Settings | undefined> {
  const saved = await readJson<Settings>(settingsPath());
  const clientId = process.env.TIDAL_CLIENT_ID ?? saved?.clientId;
  if (!clientId) return undefined;
  return {
    clientId,
    clientSecret: process.env.TIDAL_CLIENT_SECRET ?? saved?.clientSecret,
    redirectUri: saved?.redirectUri ?? redirectUri(DEFAULT_PORT),
  };
}

export const saveSettings = (s: Settings) => writePrivateJson(settingsPath(), s);
export const loadTokens = () => readJson<Tokens>(tokensPath());
export const saveTokens = (t: Tokens) => writePrivateJson(tokensPath(), t);

export async function clearAll(): Promise<void> {
  await rm(homeDir(), { recursive: true, force: true });
}
