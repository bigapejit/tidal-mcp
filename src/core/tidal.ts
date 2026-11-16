/**
 * Thin client for the official TIDAL API (https://openapi.tidal.com/v2).
 * Runtime-neutral: uses only fetch and Web Crypto, so it runs in Node and Cloudflare Workers.
 */

export const API_BASE = "https://openapi.tidal.com/v2";
export const AUTHORIZE_URL = "https://login.tidal.com/authorize";
export const TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";

/** TIDAL OAuth scopes this server asks for. */
export const TIDAL_SCOPES = ["user.read", "search.read", "playlists.read", "playlists.write", "collection.read"];

/** JSON:API shapes, trimmed to what this client reads. */
interface Identifier {
  id: string;
  type: string;
  meta?: { itemId?: string; addedAt?: string };
}
interface Resource extends Identifier {
  attributes?: Record<string, any>;
  relationships?: Record<string, { data?: Identifier | Identifier[] }>;
}
interface Document {
  data: Resource | Resource[];
  included?: Resource[];
  links?: { next?: string };
}

export interface Track {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  duration?: string;
  explicit?: boolean;
  url: string;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  visibility?: string;
  trackCount?: number;
  url: string;
}

export class TidalError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** OAuth error code, for token endpoint failures. */
    readonly code?: string,
  ) {
    super(message);
  }
}

const MAX_BATCH = 50;
const chunk = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const ids = (rel: { data?: Identifier | Identifier[] } | undefined): string[] => {
  const d = rel?.data;
  return d ? (Array.isArray(d) ? d : [d]).map((x) => x.id) : [];
};

const index = (rs: Resource[]) => new Map(rs.map((r) => [`${r.type}:${r.id}`, r]));

function formatDuration(iso?: string): string | undefined {
  const m = iso?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.\d+)?S)?$/);
  if (!m) return iso;
  const [h, min, s] = [m[1], m[2], m[3]].map((x) => Number(x ?? 0));
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(min).padStart(2, "0")}:${ss}` : `${min}:${ss}`;
}

function toTrack(r: Resource, included: Map<string, Resource>): Track {
  const a = r.attributes ?? {};
  return {
    id: r.id,
    title: a.version ? `${a.title} (${a.version})` : a.title,
    artists: ids(r.relationships?.artists)
      .map((id) => included.get(`artists:${id}`)?.attributes?.name)
      .filter(Boolean),
    album: ids(r.relationships?.albums)
      .map((id) => included.get(`albums:${id}`)?.attributes?.title)
      .find(Boolean),
    duration: formatDuration(a.duration),
    explicit: a.explicit || undefined,
    url: `https://tidal.com/track/${r.id}`,
  };
}

function toPlaylist(r: Resource): Playlist {
  const a = r.attributes ?? {};
  return {
    id: r.id,
    name: a.name,
    description: a.description || undefined,
    visibility: a.accessType,
    trackCount: a.numberOfItems,
    url: `https://tidal.com/playlist/${r.id}`,
  };
}

export class Tidal {
  /**
   * @param accessToken returns a currently valid TIDAL access token
   * @param countryCode the account's country, if known; looked up on first use otherwise
   */
  constructor(
    private readonly accessToken: () => Promise<string>,
    private countryCode?: string,
  ) {}

  private async request(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<Document | undefined> {
    const url = new URL(path.startsWith("http") ? path : API_BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      Accept: "application/vnd.api+json",
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/vnd.api+json";
      // One key for all retries of this call, so a retried write never applies twice.
      headers["Idempotency-Key"] = crypto.randomUUID();
    }

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (res.status === 429 && attempt < 3) {
        const wait = Number(res.headers.get("Retry-After")) || 2 ** attempt;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (res.status === 204) return undefined;
      const text = await res.text();
      const json = text ? JSON.parse(text) : undefined;
      if (!res.ok) {
        const detail =
          json?.errors?.map((e: any) => e.detail ?? e.title ?? e.code).join("; ") ?? text.slice(0, 300);
        throw new TidalError(res.status, `TIDAL ${method} ${url.pathname} failed (${res.status}): ${detail}`);
      }
      return json as Document;
    }
  }

  /** Follows `links.next` cursors until `limit` primary resources are collected. */
  private async collect(path: string, query: Record<string, string | undefined>, limit: number) {
    const data: Resource[] = [];
    const included: Resource[] = [];
    let next: string | undefined = path;
    let q: typeof query | undefined = query;
    while (next && data.length < limit) {
      const doc = await this.request("GET", next.startsWith("/v2/") ? next.slice(3) : next, { query: q });
      if (!doc) break;
      data.push(...(Array.isArray(doc.data) ? doc.data : [doc.data]));
      included.push(...(doc.included ?? []));
      next = doc.links?.next;
      q = undefined; // the next link already carries the query string
    }
    return { data: data.slice(0, limit), included };
  }

  /** The signed-in user's id and country. */
  async me(): Promise<{ id: string; country?: string }> {
    const doc = await this.request("GET", "/users/me");
    const me = doc!.data as Resource;
    return { id: me.id, country: me.attributes?.country };
  }

  /** Catalog availability depends on the account's country. */
  private async country(): Promise<string> {
    this.countryCode ??= (await this.me()).country ?? "US";
    return this.countryCode;
  }

  /** Full track details (with artist and album names) for ids, preserving order. */
  async getTracks(trackIds: string[]): Promise<Track[]> {
    if (trackIds.length === 0) return [];
    const countryCode = await this.country();
    const byId = new Map<string, Track>();
    for (const batch of chunk([...new Set(trackIds)], 20)) {
      const { data, included } = await this.collect(
        "/tracks",
        { "filter[id]": batch.join(","), include: "artists,albums", countryCode },
        batch.length,
      );
      const inc = index(included);
      for (const r of data) byId.set(r.id, toTrack(r, inc));
    }
    return trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t);
  }

  async searchTracks(query: string, limit: number): Promise<Track[]> {
    const doc = await this.request("GET", `/searchResults/${encodeURIComponent(query)}/relationships/tracks`, {
      query: { countryCode: await this.country(), explicitFilter: "INCLUDE" },
    });
    const hits = ((doc?.data as Identifier[]) ?? []).slice(0, limit).map((d) => d.id);
    return this.getTracks(hits);
  }

  async similarTracks(trackId: string, limit: number): Promise<Track[]> {
    const { data } = await this.collect(
      `/tracks/${encodeURIComponent(trackId)}/relationships/similarTracks`,
      { countryCode: await this.country() },
      limit,
    );
    return this.getTracks(data.map((d) => d.id));
  }

  async listMyPlaylists(limit: number): Promise<Playlist[]> {
    const { data } = await this.collect(
      "/playlists",
      { "filter[owners.id]": "me", countryCode: await this.country(), sort: "-lastModifiedAt" },
      limit,
    );
    return data.map(toPlaylist);
  }

  async getPlaylist(id: string): Promise<Playlist> {
    const doc = await this.request("GET", `/playlists/${encodeURIComponent(id)}`, {
      query: { countryCode: await this.country() },
    });
    return toPlaylist(doc!.data as Resource);
  }

  /** Playlist entries in order, with the per-entry itemId TIDAL needs for removal. */
  private async playlistEntries(id: string, limit = 10_000): Promise<Identifier[]> {
    const { data } = await this.collect(
      `/playlists/${encodeURIComponent(id)}/relationships/items`,
      { countryCode: await this.country() },
      limit,
    );
    return data;
  }

  async getPlaylistTracks(id: string, limit: number): Promise<Track[]> {
    const entries = (await this.playlistEntries(id, limit)).filter((e) => e.type === "tracks");
    return this.getTracks(entries.map((e) => e.id));
  }

  async createPlaylist(name: string, opts: { description?: string; isPublic?: boolean }): Promise<Playlist> {
    const doc = await this.request("POST", "/playlists", {
      query: { countryCode: await this.country() },
      body: {
        data: {
          type: "playlists",
          attributes: {
            name,
            ...(opts.description ? { description: opts.description } : {}),
            accessType: opts.isPublic ? "PUBLIC" : "UNLISTED",
          },
        },
      },
    });
    return toPlaylist(doc!.data as Resource);
  }

  async updatePlaylist(id: string, changes: { name?: string; description?: string; isPublic?: boolean }) {
    const attributes: Record<string, string> = {};
    if (changes.name !== undefined) attributes.name = changes.name;
    if (changes.description !== undefined) attributes.description = changes.description;
    if (changes.isPublic !== undefined) attributes.accessType = changes.isPublic ? "PUBLIC" : "UNLISTED";
    await this.request("PATCH", `/playlists/${encodeURIComponent(id)}`, {
      body: { data: { id, type: "playlists", attributes } },
    });
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.request("DELETE", `/playlists/${encodeURIComponent(id)}`);
  }

  async addTracks(id: string, trackIds: string[], allowDuplicates: boolean): Promise<void> {
    for (const batch of chunk(trackIds, MAX_BATCH)) {
      await this.request("POST", `/playlists/${encodeURIComponent(id)}/relationships/items`, {
        body: {
          data: batch.map((t) => ({ id: t, type: "tracks" })),
          meta: { onDuplicates: allowDuplicates ? "ADD" : "SKIP" },
        },
      });
    }
  }

  /** Removes every occurrence of each given track. Returns how many entries were removed. */
  async removeTracks(id: string, trackIds: string[]): Promise<number> {
    const wanted = new Set(trackIds);
    const doomed = (await this.playlistEntries(id)).filter(
      (e) => e.type === "tracks" && wanted.has(e.id) && e.meta?.itemId,
    );
    for (const batch of chunk(doomed, MAX_BATCH)) {
      await this.request("DELETE", `/playlists/${encodeURIComponent(id)}/relationships/items`, {
        body: { data: batch.map((e) => ({ id: e.id, type: "tracks", meta: { itemId: e.meta!.itemId } })) },
      });
    }
    return doomed.length;
  }
}

/** PKCE S256 challenge for a verifier, via Web Crypto. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface TidalTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  user_id?: number | string;
  user?: { userId?: number | string; countryCode?: string };
}

/** POSTs to TIDAL's token endpoint. Throws TidalError with the OAuth error code on failure. */
export async function tidalToken(
  client: { clientId: string; clientSecret?: string },
  params: Record<string, string>,
): Promise<TidalTokenResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (client.clientSecret) headers.Authorization = "Basic " + btoa(`${client.clientId}:${client.clientSecret}`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers,
    body: new URLSearchParams({ client_id: client.clientId, ...params }),
  });
  const json = (await res.json().catch(() => ({}))) as TidalTokenResponse & {
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    const code = json.error ?? `http_${res.status}`;
    throw new TidalError(res.status, `TIDAL token request failed: ${json.error_description ?? code}`, code);
  }
  return json;
}
