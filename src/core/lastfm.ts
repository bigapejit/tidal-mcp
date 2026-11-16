/**
 * Reads a user's scrobbles from the Last.fm API (https://www.last.fm/api/show/user.getRecentTracks).
 * Runtime-neutral: plain fetch.
 */

const API = "https://ws.audioscrobbler.com/2.0/";

/** Last.fm's largest page. */
export const LASTFM_PAGE = 200;

export interface Scrobble {
  /** Unix seconds. */
  uts: number;
  artist: string;
  title: string;
  album?: string;
}

export interface ScrobblePage {
  /** Newest first. Excludes the "now playing" entry, which has no timestamp yet. */
  scrobbles: Scrobble[];
  /** Scrobbles in the requested window. */
  total: number;
  totalPages: number;
}

interface RawTrack {
  name?: string;
  artist?: { "#text"?: string; name?: string };
  album?: { "#text"?: string };
  date?: { uts?: string };
  "@attr"?: { nowplaying?: string };
}

/** Some tags are absurdly long; nothing useful lives past this. */
const clip = (s: string | undefined) => (s ?? "").trim().slice(0, 300);

/** Last.fm errors worth retrying: operation failed, service offline, temporarily unavailable, rate limited. */
const TRANSIENT = new Set([8, 11, 16, 29]);
const RETRIES = 2;

export class LastFm {
  constructor(
    private readonly apiKey: string,
    readonly user: string,
  ) {}

  /** One page of scrobbles in the window from `from` (inclusive) to `to` (exclusive), newest first. */
  async recent(window: { from?: number; to?: number }): Promise<ScrobblePage> {
    const params = new URLSearchParams({
      method: "user.getrecenttracks",
      user: this.user,
      api_key: this.apiKey,
      format: "json",
      limit: String(LASTFM_PAGE),
    });
    if (window.from) params.set("from", String(window.from));
    if (window.to) params.set("to", String(window.to));
    type Body = {
      error?: number;
      message?: string;
      recenttracks?: { track?: RawTrack | RawTrack[]; "@attr"?: { total?: string; totalPages?: string } };
    };
    let json: Body;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API}?${params}`, { headers: { "User-Agent": "tidal-mcp" } });
      json = (await res.json().catch(() => ({}))) as Body;
      if (res.ok && !json.error && json.recenttracks) break;
      const transient = res.status >= 500 || res.status === 429 || TRANSIENT.has(json.error ?? 0);
      if (!transient || attempt >= RETRIES) {
        throw new Error(`Last.fm failed (${json.error ?? res.status}): ${json.message ?? "unexpected response"}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    const raw = json.recenttracks!.track;
    const scrobbles: Scrobble[] = [];
    for (const t of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const uts = Number(t.date?.uts);
      const artist = clip(t.artist?.["#text"] ?? t.artist?.name);
      const title = clip(t.name);
      if (t["@attr"]?.nowplaying || !uts || !artist || !title) continue;
      scrobbles.push({ uts, artist, title, album: clip(t.album?.["#text"]) || undefined });
    }
    const attr = json.recenttracks!["@attr"];
    return { scrobbles, total: Number(attr?.total ?? 0), totalPages: Number(attr?.totalPages ?? 0) };
  }
}
