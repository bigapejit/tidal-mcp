import { randomUUID } from "node:crypto";
import { getTokens } from "./auth.js";
import { API_BASE, saveTokens } from "./config.js";

/** JSON:API shapes, trimmed to what this server reads. */
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
  ) {
    super(message);
  }
}

const MAX_BATCH = 50;
const chunk = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function request(
  method: string,
  path: string,
  opts: { query?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<Document | undefined> {
  const tokens = await getTokens();
  const url = new URL(path.startsWith("http") ? path : API_BASE + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.accessToken}`,
    Accept: "application/vnd.api+json",
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/vnd.api+json";
    // Same key across our retries, so a retried write never applies twice.
    headers["Idempotency-Key"] = randomUUID();
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
async function collect(
  path: string,
  query: Record<string, string | undefined>,
  limit: number,
): Promise<{ data: Resource[]; included: Resource[] }> {
  const data: Resource[] = [];
  const included: Resource[] = [];
  let next: string | undefined = path;
  let q: typeof query | undefined = query;
  while (next && data.length < limit) {
    const doc = await request("GET", next.startsWith("/v2/") ? next.slice(3) : next, { query: q });
    if (!doc) break;
    data.push(...(Array.isArray(doc.data) ? doc.data : [doc.data]));
    included.push(...(doc.included ?? []));
    next = doc.links?.next;
    q = undefined; // the next link already carries the query string
  }
  return { data: data.slice(0, limit), included };
}

let cachedCountry: string | undefined;

/** Country of the signed-in account; catalog availability depends on it. */
async function country(): Promise<string> {
  if (cachedCountry) return cachedCountry;
  const tokens = await getTokens();
  if (tokens.countryCode) return (cachedCountry = tokens.countryCode);
  const doc = await request("GET", "/users/me");
  const me = doc?.data as Resource | undefined;
  cachedCountry = me?.attributes?.country ?? "US";
  await saveTokens({ ...tokens, countryCode: cachedCountry, userId: tokens.userId ?? me?.id });
  return cachedCountry!;
}

function ids(rel: { data?: Identifier | Identifier[] } | undefined): string[] {
  const d = rel?.data;
  return d ? (Array.isArray(d) ? d : [d]).map((x) => x.id) : [];
}

function toTrack(r: Resource, included: Map<string, Resource>): Track {
  const a = r.attributes ?? {};
  const artists = ids(r.relationships?.artists)
    .map((id) => included.get(`artists:${id}`)?.attributes?.name)
    .filter(Boolean);
  const album = ids(r.relationships?.albums)
    .map((id) => included.get(`albums:${id}`)?.attributes?.title)
    .find(Boolean);
  return {
    id: r.id,
    title: a.version ? `${a.title} (${a.version})` : a.title,
    artists,
    album,
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

function formatDuration(iso?: string): string | undefined {
  const m = iso?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.\d+)?S)?$/);
  if (!m) return iso;
  const [h, min, s] = [m[1], m[2], m[3]].map((x) => Number(x ?? 0));
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(min).padStart(2, "0")}:${ss}` : `${min}:${ss}`;
}

const index = (rs: Resource[]) => new Map(rs.map((r) => [`${r.type}:${r.id}`, r]));

/** Fetches full track details (with artist and album names) for ids, preserving order. */
export async function getTracks(trackIds: string[]): Promise<Track[]> {
  if (trackIds.length === 0) return [];
  const countryCode = await country();
  const byId = new Map<string, Track>();
  for (const batch of chunk([...new Set(trackIds)], 20)) {
    const { data, included } = await collect(
      "/tracks",
      { "filter[id]": batch.join(","), include: "artists,albums", countryCode },
      batch.length,
    );
    const inc = index(included);
    for (const r of data) byId.set(r.id, toTrack(r, inc));
  }
  return trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t);
}

export async function searchTracks(query: string, limit: number): Promise<Track[]> {
  const doc = await request("GET", `/searchResults/${encodeURIComponent(query)}/relationships/tracks`, {
    query: { countryCode: await country(), explicitFilter: "INCLUDE" },
  });
  const hits = ((doc?.data as Identifier[]) ?? []).slice(0, limit).map((d) => d.id);
  return getTracks(hits);
}

export async function listMyPlaylists(limit: number): Promise<Playlist[]> {
  const { data } = await collect(
    "/playlists",
    { "filter[owners.id]": "me", countryCode: await country(), sort: "-lastModifiedAt" },
    limit,
  );
  return data.map(toPlaylist);
}

export async function getPlaylist(id: string): Promise<Playlist> {
  const doc = await request("GET", `/playlists/${encodeURIComponent(id)}`, {
    query: { countryCode: await country() },
  });
  return toPlaylist(doc!.data as Resource);
}

/** Playlist entries in order, with the per-entry itemId TIDAL needs for removal. */
async function playlistEntries(id: string, limit = 10_000): Promise<Identifier[]> {
  const { data } = await collect(
    `/playlists/${encodeURIComponent(id)}/relationships/items`,
    { countryCode: await country() },
    limit,
  );
  return data;
}

export async function getPlaylistTracks(id: string, limit: number): Promise<Track[]> {
  const entries = (await playlistEntries(id, limit)).filter((e) => e.type === "tracks");
  return getTracks(entries.map((e) => e.id));
}

export async function createPlaylist(
  name: string,
  opts: { description?: string; isPublic?: boolean },
): Promise<Playlist> {
  const doc = await request("POST", "/playlists", {
    query: { countryCode: await country() },
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

export async function updatePlaylist(
  id: string,
  changes: { name?: string; description?: string; isPublic?: boolean },
): Promise<void> {
  const attributes: Record<string, string> = {};
  if (changes.name !== undefined) attributes.name = changes.name;
  if (changes.description !== undefined) attributes.description = changes.description;
  if (changes.isPublic !== undefined) attributes.accessType = changes.isPublic ? "PUBLIC" : "UNLISTED";
  await request("PATCH", `/playlists/${encodeURIComponent(id)}`, {
    body: { data: { id, type: "playlists", attributes } },
  });
}

export async function deletePlaylist(id: string): Promise<void> {
  await request("DELETE", `/playlists/${encodeURIComponent(id)}`);
}

export async function addTracks(id: string, trackIds: string[], allowDuplicates: boolean): Promise<number> {
  for (const batch of chunk(trackIds, MAX_BATCH)) {
    await request("POST", `/playlists/${encodeURIComponent(id)}/relationships/items`, {
      body: {
        data: batch.map((t) => ({ id: t, type: "tracks" })),
        meta: { onDuplicates: allowDuplicates ? "ADD" : "SKIP" },
      },
    });
  }
  return trackIds.length;
}

/** Removes every occurrence of each given track. Returns how many entries were removed. */
export async function removeTracks(id: string, trackIds: string[]): Promise<number> {
  const wanted = new Set(trackIds);
  const doomed = (await playlistEntries(id)).filter(
    (e) => e.type === "tracks" && wanted.has(e.id) && e.meta?.itemId,
  );
  for (const batch of chunk(doomed, MAX_BATCH)) {
    await request("DELETE", `/playlists/${encodeURIComponent(id)}/relationships/items`, {
      body: { data: batch.map((e) => ({ id: e.id, type: "tracks", meta: { itemId: e.meta!.itemId } })) },
    });
  }
  return doomed.length;
}

export async function similarTracks(trackId: string, limit: number): Promise<Track[]> {
  const { data } = await collect(
    `/tracks/${encodeURIComponent(trackId)}/relationships/similarTracks`,
    { countryCode: await country() },
    limit,
  );
  return getTracks(data.map((d) => d.id));
}
