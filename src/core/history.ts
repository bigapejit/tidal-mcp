/**
 * Listening history from the owner's Last.fm scrobbles. TIDAL's API has no history endpoint, but
 * TIDAL scrobbles to Last.fm.
 *
 * Scrobbles are copied into SQL (D1 on the Worker, SQLite locally), so play counts, rankings and
 * date ranges take one query instead of hundreds of Last.fm pages. Runtime-neutral: the caller
 * supplies a `Sql` for its database.
 *
 * Importing: a backfill walks from the first sync back to the oldest scrobble, and each later sync
 * walks back from now to where the previous one ended. Both walk Last.fm's newest-first pages by
 * timestamp and save their position with every page, so a run can stop anywhere (subrequest, CPU
 * or daily write budget) and the next run carries on. A play is keyed by (time, track), so pages
 * that overlap never count a play twice.
 *
 * TIDAL matches are looked up when a tool is about to show a track or artist, then cached.
 */
import type { LastFm, Scrobble } from "./lastfm.js";
import { TidalError, type Artist, type Tidal, type Track } from "./tidal.js";

export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

/** The part of a SQL database this module uses. D1 and node:sqlite both provide it. */
export interface Sql {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs the statements in one transaction and one round trip. Resolves to the rows written. */
  batch(statements: SqlStatement[]): Promise<number>;
}

/** Each sync re-reads the last day, because scrobbles from offline listening arrive late. */
const OVERLAP_SECONDS = 24 * 3600;
/** Tools sync before answering when the last sync is older than this. */
const STALE_MS = 10 * 60_000;
/** TIDAL lookups (one search each) before a tool answers, and how many run at once. See History.match. */
const MATCH_PER_CALL = 10;
const MATCH_CONCURRENCY = 2;
/**
 * Lookups after the tool has answered, and the gap between them. Bounded by the Worker's 30 s
 * waitUntil window and 50 subrequests per call.
 */
const MATCH_LATER = 10;
const MATCH_LATER_PACE_MS = 1200;
/** An end time later than any scrobble. */
const FOREVER = 10_000_000_000;
/** Most rows one Last.fm page can write: a track and a play per scrobble, plus two state updates. */
const PAGE_WRITES = 200 * 2 + 2;

/** The UTC day D1's daily limits count against. */
const utcDay = () => new Date().toISOString().slice(0, 10);

const SCHEMA = [
  // id: a hash of the lowercased artist and title, so a play can point at its track without a lookup.
  // tidal: NULL until looked up, '' when TIDAL has no match, otherwise the matched Track as JSON.
  `CREATE TABLE IF NOT EXISTS lastfm_tracks (
    id INTEGER PRIMARY KEY, artist TEXT NOT NULL, title TEXT NOT NULL, album TEXT, tidal TEXT)`,
  `CREATE TABLE IF NOT EXISTS lastfm_plays (
    uts INTEGER NOT NULL, track INTEGER NOT NULL, PRIMARY KEY (uts, track)) WITHOUT ROWID`,
  // name: lowercased Last.fm artist name. tidal: as for tracks, with an Artist.
  `CREATE TABLE IF NOT EXISTS lastfm_artists (name TEXT PRIMARY KEY, tidal TEXT NOT NULL) WITHOUT ROWID`,
  // lastfm_user: whose scrobbles these tables hold. One database holds one user's history.
  `CREATE TABLE IF NOT EXISTS lastfm_sync (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    lastfm_user TEXT NOT NULL,
    head INTEGER NOT NULL,
    fwd_hi INTEGER,
    fwd_cursor INTEGER,
    back_cursor INTEGER NOT NULL,
    back_done INTEGER NOT NULL DEFAULT 0,
    back_total INTEGER,
    back_fetched INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER,
    day TEXT,
    day_writes INTEGER NOT NULL DEFAULT 0)`,
];

/** Import progress, one row. Times are unix seconds except synced_at (epoch ms). */
interface SyncRow {
  lastfm_user: string;
  /** Everything from back_cursor up to head is imported. */
  head: number;
  /** An unfinished walk for new scrobbles, from fwd_cursor down to head minus the overlap. */
  fwd_hi: number | null;
  fwd_cursor: number | null;
  back_cursor: number;
  back_done: number;
  /** Scrobbles the backfill set out to import, and how many it has fetched. */
  back_total: number | null;
  back_fetched: number;
  synced_at: number | null;
  /** The UTC day that day_writes counts rows for. */
  day: string | null;
  day_writes: number;
}

export interface Coverage {
  /** Epoch ms of the last sync. */
  syncedAt?: number;
  /** Unix seconds. Every play from here to the last sync is imported. */
  since?: number;
  /** The import has reached the first scrobble. */
  complete: boolean;
  /** Share of the initial import done, 0 to 1. */
  progress?: number;
  /** Why this call's sync failed, if it did; the data is then from syncedAt. */
  error?: string;
}

export interface HistoryTrack {
  /** Internal track id. */
  key: number;
  artist: string;
  title: string;
  album?: string;
  /** The TIDAL match: undefined until looked up, null when TIDAL has none. */
  tidal?: Track | null;
  /** Unix seconds, for a single play. */
  playedAt?: number;
  /** For rankings. */
  plays?: number;
  lastPlayed?: number;
}

export interface HistoryArtist {
  name: string;
  plays: number;
  /** Distinct tracks played. */
  tracks: number;
  lastPlayed: number;
  /** As for HistoryTrack. */
  tidal?: Artist | null;
}

export interface Range {
  /** Unix seconds, inclusive. */
  from: number;
  /** Unix seconds, exclusive. */
  to: number;
  label: string;
}

const PERIOD_DAYS = { "7d": 7, "30d": 30, "90d": 90, "180d": 180, "365d": 365 } as const;
export const PERIODS = ["7d", "30d", "90d", "180d", "365d", "all"] as const;
export type Period = (typeof PERIODS)[number];

/** A tool's period, from and to as a window in unix seconds. Explicit dates win over the period. */
export function parseRange(input: { period?: Period; from?: string; to?: string }, now = Date.now()): Range {
  const nowSeconds = Math.floor(now / 1000);
  if (input.from || input.to) {
    const from = input.from ? instant(input.from, "start") : 0;
    const to = input.to ? instant(input.to, "end") : FOREVER;
    if (from >= to) throw new Error("`from` must be earlier than `to`.");
    const label =
      input.from && input.to
        ? input.from === input.to
          ? input.from
          : `${input.from} to ${input.to}`
        : input.from
          ? `since ${input.from}`
          : `until ${input.to}`;
    return { from, to, label };
  }
  if (!input.period || input.period === "all") return { from: 0, to: FOREVER, label: "all time" };
  const days = PERIOD_DAYS[input.period];
  return { from: nowSeconds - days * 86400, to: FOREVER, label: `last ${days} days` };
}

/** "2024", "2024-06", "2024-06-01" or an ISO datetime (UTC unless it has an offset). A bare year, month or day as `to` includes all of it. */
function instant(value: string, edge: "start" | "end"): number {
  const v = value.trim();
  const m = v.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
  if (m) {
    const y = Number(m[1]);
    const mo = m[2] ? Number(m[2]) - 1 : 0;
    const d = m[3] ? Number(m[3]) : 1;
    const start = Date.UTC(y, mo, d);
    if (mo > 11 || new Date(start).getUTCDate() !== d) throw new Error(`"${value}" isn't a valid date.`);
    const end = m[3] ? Date.UTC(y, mo, d + 1) : m[2] ? Date.UTC(y, mo + 1, 1) : Date.UTC(y + 1, 0, 1);
    return Math.floor((edge === "start" ? start : end) / 1000);
  }
  const ms = Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`);
  if (Number.isNaN(ms)) throw new Error(`Couldn't read the date "${value}". Use 2024, 2024-06, 2024-06-01 or an ISO datetime.`);
  return Math.floor(ms / 1000);
}

/**
 * A stable 53-bit id for an artist and title, compared case-insensitively as Last.fm does. It's
 * cyrb53, a fast non-cryptographic hash: Web Crypto's SHA-256 cost 6 ms of CPU per page of 200
 * scrobbles, most of the Worker's 10 ms. A collision among 100k tracks has odds near 1 in 10^6.
 */
function trackKey(artist: string, title: string): number {
  const text = `${artist}\u001f${title}`.normalize("NFC").toLowerCase();
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (h2 & 0x1fffff) + (h1 >>> 0);
}

/** The next cursor for a walk: the oldest scrobble on this page, re-read next time in case it shares its second. */
function nextCursor(page: Scrobble[], cursor: number): number {
  const oldest = Math.min(...page.map((s) => s.uts));
  // A full page inside one second would never move the cursor; skip past it.
  return oldest < cursor ? oldest : cursor - 1;
}

// ---------------------------------------------------------------- Matching to TIDAL

/** Lowercase letters and digits only, without accents, versions in brackets, or a " - Remastered" style suffix. */
function base(s: string): string {
  return loose(s.replace(/\s*[([][^)\]]*[)\]]/g, " ").replace(/\s+-\s+.*$/, ""));
}

/** Lowercase letters and digits only, without accents. */
function loose(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** How Last.fm (and TIDAL's scrobbler) join several artists into one name. */
const ARTIST_SEPARATORS = /( & |, and |, | feat\.? | ft\.? | featuring | x | vs\.? | with )/i;

const NON_ASCII = /[^\x00-\x7f]/;

function artistParts(name: string): string[] {
  return name.split(ARTIST_SEPARATORS).filter((_, i) => i % 2 === 0);
}

/** The best TIDAL hit for a scrobbled track: same artist, then the closest title. */
function pickTrack(row: HistoryTrack, candidates: Track[]): Track | null {
  const wanted = new Set([loose(row.artist), ...artistParts(row.artist).map(loose)]);
  const sameArtist = candidates.filter(
    (t) => t.artists.some((a) => wanted.has(loose(a))) || wanted.has(loose(t.artists.join(" & "))),
  );
  const full = loose(row.title);
  const short = base(row.title);
  return (
    sameArtist.find((t) => loose(t.title) === full) ??
    sameArtist.find((t) => base(t.title) === short) ??
    sameArtist.find((t) => {
      const b = base(t.title);
      return Math.min(b.length, short.length) >= 3 && (b.startsWith(short) || short.startsWith(b));
    }) ??
    null
  );
}

/** Runs `fn` over items with at most `limit` in flight, keeping order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const decode = <T>(json: string | null | undefined): T | null | undefined =>
  json === null || json === undefined ? undefined : json === "" ? null : (JSON.parse(json) as T);

// ---------------------------------------------------------------- Crediting collaborations

/**
 * The artists a scrobbled artist name should count toward. TIDAL scrobbles a collaboration as one
 * name ("Lil Baby & Nardo Wick"), so it is split, but only around names that also appear on their
 * own in `known` (keyed by lowercased name). Bands like "Earth, Wind & Fire" stay whole, and
 * leftover parts stay together: "Tyler, The Creator & Kali Uchis" credits "Tyler, The Creator"
 * even if only Kali Uchis is known.
 *
 * Returns lowercased names. A leftover part's display name goes into `extra`.
 */
function credits(name: string, known: Map<string, string>, extra: Map<string, string>): string[] {
  const tokens = name.split(ARTIST_SEPARATORS); // parts at even indexes, separators between
  const lower = name.toLowerCase();
  if (tokens.length === 1) return [lower];
  const low = tokens.map((t) => t.toLowerCase());
  if (tokens.length === 3) {
    // Two parts, the usual case: split if either is known.
    if (!known.has(low[0]) && !known.has(low[2])) return [lower];
    if (!known.has(low[0]) && !extra.has(low[0])) extra.set(low[0], tokens[0]);
    if (!known.has(low[2]) && !extra.has(low[2])) extra.set(low[2], tokens[2]);
    return low[0] === low[2] ? [low[0]] : [low[0], low[2]];
  }
  /** Parts a..b-1 with their separators, from `list`. */
  const join = (list: string[], a: number, b: number) => {
    let s = list[a * 2];
    for (let k = a * 2 + 1; k < b * 2 - 1; k++) s += list[k];
    return s;
  };
  // best[i]: most parts covered by known names when splitting parts 0..i-1. A segment is either a
  // known name spanning one or more parts, or one unknown part on its own.
  const n = (tokens.length + 1) / 2;
  const best: number[] = [0];
  const from: number[] = [0];
  for (let i = 1; i <= n; i++) {
    best[i] = best[i - 1];
    from[i] = i - 1;
    for (let j = 0; j < i; j++) {
      if (j === 0 && i === n) continue; // the whole name is what's being split
      if (best[j] + (i - j) > best[i] && known.has(join(low, j, i))) {
        best[i] = best[j] + (i - j);
        from[i] = j;
      }
    }
  }
  if (best[n] === 0) return [lower];
  // The chosen segments in order, each [first part, end part, known]. A known segment gained parts.
  const segments: [number, number, boolean][] = [];
  for (let i = n; i > 0; i = from[i]) segments.unshift([from[i], i, best[i] > best[from[i]]]);
  const out = new Set<string>();
  for (let k = 0; k < segments.length; k++) {
    const [a, b, isKnown] = segments[k];
    if (isKnown) {
      out.add(join(low, a, b));
      continue;
    }
    // Glue a run of unknown parts back together, separators included.
    let end = b;
    while (k + 1 < segments.length && !segments[k + 1][2]) end = segments[++k][1];
    const key = join(low, a, end);
    if (!known.has(key) && !extra.has(key)) extra.set(key, join(tokens, a, end));
    out.add(key);
  }
  return [...out];
}

// ---------------------------------------------------------------- Store

/** Schema setup runs once per database per process. */
const schemaReady = new WeakMap<Sql, Promise<unknown>>();

interface TrackRow {
  id: number;
  artist: string;
  title: string;
  album: string | null;
  tidal: string | null;
}

const toHistoryTrack = (r: TrackRow): HistoryTrack => ({
  key: r.id,
  artist: r.artist,
  title: r.title,
  album: r.album ?? undefined,
  tidal: decode<Track>(r.tidal),
});

export interface HistoryOptions {
  /** Rows the backfill may write per UTC day. The Worker sets this to stay inside D1's free plan. */
  dailyWrites?: number;
  /**
   * Keeps work running after the tool has answered (the Worker's waitUntil). Used to finish TIDAL
   * matches at TIDAL's pace without making the user wait.
   */
  defer?: (work: Promise<unknown>) => void;
}

export class History {
  private readonly dailyWrites: number;
  private readonly defer?: (work: Promise<unknown>) => void;

  constructor(
    private readonly sql: Sql,
    private readonly lastfm: LastFm,
    options: HistoryOptions = {},
  ) {
    this.dailyWrites = options.dailyWrites ?? Infinity;
    this.defer = options.defer;
  }

  private ready(): Promise<unknown> {
    let ready = schemaReady.get(this.sql);
    if (!ready) {
      ready = this.sql.batch(SCHEMA.map((sql) => ({ sql })));
      ready.catch(() => schemaReady.delete(this.sql));
      schemaReady.set(this.sql, ready);
    }
    return ready;
  }

  /** The import state, after checking it is the configured Last.fm user's. */
  private async row(): Promise<SyncRow | undefined> {
    const [row] = await this.sql.all<SyncRow>("SELECT * FROM lastfm_sync WHERE id = 1");
    if (row && row.lastfm_user.toLowerCase() !== this.lastfm.user.toLowerCase()) {
      // Mixing two people's plays would corrupt every count, and the old user's finished backfill
      // would hide that the new user's older history was never imported.
      throw new Error(
        `The stored listening history is Last.fm user "${row.lastfm_user}"'s, not "${this.lastfm.user}"'s. ` +
          "Clear the history database (the HISTORY_DB tables, or ~/.tidal-mcp/history.sqlite) to import another user.",
      );
    }
    return row;
  }

  /**
   * Imports new scrobbles, then older ones, fetching at most `pages.forward` and `pages.backfill`
   * Last.fm pages. The budgets are separate so a busy day's re-read can't starve the backfill.
   * Every page is saved with the walk's new position, so stopping between pages loses nothing.
   */
  async sync(pages: { forward: number; backfill: number }): Promise<Coverage> {
    await this.ready();
    const now = Math.floor(Date.now() / 1000);
    let s = await this.row();
    if (!s) {
      // The backfill covers everything before this moment; syncs cover everything after.
      await this.sql.batch([
        {
          sql: "INSERT OR IGNORE INTO lastfm_sync (id, lastfm_user, head, back_cursor) VALUES (1, ?, ?, ?)",
          params: [this.lastfm.user, now, now],
        },
      ]);
      s = (await this.row())!;
    }
    // New scrobbles first, so recent history stays current while the backfill runs. They aren't
    // budgeted (a day's worth is a few hundred rows) but are counted.
    if (s.fwd_hi === null) [s.fwd_hi, s.fwd_cursor] = [now, now];
    for (let left = pages.forward; left > 0 && s.fwd_hi !== null; left--) {
      const page = await this.lastfm.recent({ from: Math.max(0, s.head - OVERLAP_SECONDS), to: s.fwd_cursor! + 1 });
      if (page.totalPages <= 1) [s.head, s.fwd_hi, s.fwd_cursor] = [Math.max(s.head, s.fwd_hi), null, null];
      else s.fwd_cursor = nextCursor(page.scrobbles, s.fwd_cursor!);
      await this.save(page.scrobbles, {
        set: "head = MAX(head, ?), fwd_hi = ?, fwd_cursor = ?, synced_at = ?",
        params: [s.head, s.fwd_hi, s.fwd_cursor, Date.now()],
      });
    }

    for (let left = pages.backfill; left > 0 && !s.back_done; left--) {
      let reservation = await this.reserve();
      if (reservation === false) break; // today's write budget is spent
      const page = await this.lastfm.recent({ to: s.back_cursor + 1 });
      // Midnight UTC passed while fetching: the page must fit the new day's budget, or wait for it.
      if (reservation && reservation.day !== utcDay()) {
        reservation = await this.reserve();
        if (reservation === false) break;
      }
      s.back_total ??= page.total;
      s.back_fetched += page.scrobbles.length;
      if (page.totalPages <= 1) {
        s.back_done = 1;
        if (page.scrobbles.length) s.back_cursor = Math.min(s.back_cursor, ...page.scrobbles.map((x) => x.uts));
      } else {
        s.back_cursor = nextCursor(page.scrobbles, s.back_cursor);
      }
      await this.save(
        page.scrobbles,
        {
          set: `back_cursor = MIN(back_cursor, ?), back_done = MAX(back_done, ?), back_total = ?, back_fetched = ?,
                synced_at = ?`,
          params: [s.back_cursor, s.back_done, s.back_total, s.back_fetched, Date.now()],
        },
        reservation,
      );
    }

    s.synced_at = Date.now();
    return coverage(s);
  }

  /**
   * Claims a page's worth of today's write budget before a backfill page is fetched. The check and
   * the claim are one conditional UPDATE, so concurrent syncs can't both spend the last of it.
   * Resolves to the claim (to settle when the page is saved), undefined without a budget, or false
   * when the budget is spent. The claim covers the page's most writes plus the claim's own row. A
   * claim that is never settled (a crash mid-page) only overcounts.
   */
  private async reserve(): Promise<{ day: string; rows: number } | undefined | false> {
    if (this.dailyWrites === Infinity) return undefined;
    const day = utcDay();
    const rows = PAGE_WRITES + 1;
    const today = "(CASE WHEN day = ? THEN day_writes ELSE 0 END)";
    const claimed = await this.sql.batch([
      {
        sql: `UPDATE lastfm_sync SET day_writes = ${today} + ?, day = ? WHERE id = 1 AND ${today} + ? <= ?`,
        params: [day, rows, day, day, rows, this.dailyWrites],
      },
    ]);
    return claimed > 0 && { day, rows };
  }

  /**
   * Stores a page of scrobbles, the walk's new position, and the rows the page wrote, in one
   * transaction: SQLite's changes() counts each insert as the next statement runs. A backfill page
   * swaps its reservation for that count; the reservation's own UPDATE stays counted.
   */
  private async save(
    scrobbles: Scrobble[],
    position: { set: string; params: unknown[] },
    reservation?: { day: string; rows: number },
  ): Promise<void> {
    const tracks = new Map<number, { id: number; artist: string; title: string; album: string | null }>();
    const plays: { uts: number; id: number }[] = [];
    for (const s of scrobbles) {
      const id = trackKey(s.artist, s.title);
      if (!tracks.has(id)) tracks.set(id, { id, artist: s.artist, title: s.title, album: s.album ?? null });
      plays.push({ uts: s.uts, id });
    }
    const day = utcDay();
    // The page's real count replaces its claim; the claim's own UPDATE row stays counted. A claim
    // from before midnight UTC belongs to yesterday's count, which this page doesn't touch.
    const release = reservation?.day === day ? reservation.rows - 1 : 0;
    // json_each keeps a whole page to one statement each, well under D1's 100 bound parameters.
    await this.sql.batch([
      {
        sql: `INSERT INTO lastfm_tracks (id, artist, title, album)
              SELECT json_extract(value, '$.id'), json_extract(value, '$.artist'), json_extract(value, '$.title'),
                     json_extract(value, '$.album')
              FROM json_each(?) WHERE true
              ON CONFLICT (id) DO UPDATE SET album = excluded.album
              WHERE lastfm_tracks.album IS NULL AND excluded.album IS NOT NULL`,
        params: [JSON.stringify([...tracks.values()])],
      },
      {
        // changes(): the tracks just written. +1 for this UPDATE.
        sql: `UPDATE lastfm_sync SET day_writes = (CASE WHEN day = ? THEN day_writes ELSE 0 END) + changes() + 1,
                day = ? WHERE id = 1`,
        params: [day, day],
      },
      {
        sql: `INSERT OR IGNORE INTO lastfm_plays (uts, track)
              SELECT json_extract(value, '$.uts'), json_extract(value, '$.id') FROM json_each(?)`,
        params: [JSON.stringify(plays)],
      },
      {
        // changes(): the plays just written. +1 for this UPDATE, minus the settled reservation.
        sql: `UPDATE lastfm_sync SET day_writes = MAX(0, day_writes + changes() + 1 - ?), ${position.set} WHERE id = 1`,
        params: [release, ...position.params],
      },
    ]);
  }

  /**
   * Syncs first when the data is stale (the Worker's cron normally keeps it fresh), then reports
   * coverage. A Last.fm failure doesn't fail the tool: it answers from what's stored and says so.
   */
  async refresh(): Promise<Coverage> {
    await this.ready();
    const s = await this.row();
    if (s?.synced_at && Date.now() - s.synced_at < STALE_MS) return coverage(s);
    try {
      return await this.sync({ forward: 1, backfill: 1 });
    } catch (err) {
      const latest = await this.row();
      return { ...coverage(latest), error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Plays in the range, newest first. */
  async plays(range: Range, limit: number, offset: number) {
    const rows = await this.sql.all<TrackRow & { uts: number }>(
      `SELECT p.uts, t.id, t.artist, t.title, t.album, t.tidal
       FROM lastfm_plays p JOIN lastfm_tracks t ON t.id = p.track
       WHERE p.uts >= ? AND p.uts < ?
       ORDER BY p.uts DESC LIMIT ? OFFSET ?`,
      [range.from, range.to, limit + 1, offset],
    );
    return {
      tracks: rows.slice(0, limit).map((r): HistoryTrack => ({ ...toHistoryTrack(r), playedAt: r.uts })),
      more: rows.length > limit,
    };
  }

  /**
   * Most-played tracks in the range, with totals for the whole range. Ranked by Last.fm track
   * (artist and title), never by TIDAL match: matches fill in between calls, and grouping by them
   * would reorder pages mid-pagination.
   */
  async topTracks(range: Range, limit: number, offset: number, artist?: string) {
    const counts = `SELECT track, COUNT(*) AS plays, MAX(uts) AS last FROM lastfm_plays
                    WHERE uts >= ? AND uts < ? GROUP BY track`;
    const columns = "t.id, t.artist, t.title, t.album, t.tidal, c.plays, c.last";
    const rows = await this.sql.all<TrackRow & { plays: number; last: number; total: number; track_count: number }>(
      artist
        ? // Filtering by artist needs every counted track's name.
          `SELECT ${columns}, SUM(c.plays) OVER () AS total, COUNT(*) OVER () AS track_count
           FROM (${counts}) c JOIN lastfm_tracks t ON t.id = c.track
           WHERE t.artist LIKE ? ESCAPE '!'
           ORDER BY c.plays DESC, c.last DESC, c.track LIMIT ? OFFSET ?`
        : // Otherwise only the page's tracks are looked up, which keeps D1 rows read down.
          `SELECT ${columns}, c.total, c.track_count
           FROM (SELECT *, SUM(plays) OVER () AS total, COUNT(*) OVER () AS track_count FROM (${counts})
                 ORDER BY plays DESC, last DESC, track LIMIT ? OFFSET ?) c
           JOIN lastfm_tracks t ON t.id = c.track
           ORDER BY c.plays DESC, c.last DESC, c.track`,
      artist
        ? [range.from, range.to, `%${artist.replace(/[!%_]/g, "!$&")}%`, limit + 1, offset]
        : [range.from, range.to, limit + 1, offset],
    );
    return {
      tracks: rows
        .slice(0, limit)
        .map((r): HistoryTrack => ({ ...toHistoryTrack(r), plays: r.plays, lastPlayed: r.last })),
      more: rows.length > limit,
      plays: rows[0]?.total ?? 0,
      distinct: rows[0]?.track_count ?? 0,
    };
  }

  /**
   * Most-played artists in the range, with collaborations credited to each artist.
   *
   * All time is ~10k names, which costs more than the Worker's 10 ms of CPU to receive and credit
   * in JS. So when a range has over 4,000 names, the first pass leaves out solo names with fewer
   * than 3 plays that never appear inside a collaboration: they can't change any other artist's
   * count or reach the top on their own. (Those that do appear in one are fetched, since they
   * decide how it splits.) A page that reaches artists with fewer than 3 plays is computed again
   * from every name.
   */
  async topArtists(range: Range, limit: number, offset: number) {
    const end = offset + limit;
    // The lowest play count on the page; only artists at or above it need sorting.
    const floorOf = (all: HistoryArtist[]) =>
      Float64Array.from(all, (a) => a.plays).sort().reverse()[Math.min(end, all.length) - 1] ?? 0;
    let { all, plays, names } = await this.rankArtists(range, 3);
    let floor = floorOf(all);
    // Recount from every name when the page reaches the left-out tail, or when the list ends at the
    // page (left-out names may follow).
    if (names > 4000 && (all.length <= end || floor < 3)) {
      ({ all, plays, names } = await this.rankArtists(range, 1));
      floor = floorOf(all);
    }
    const artists = all
      .filter((a) => a.plays >= floor)
      // Name breaks ties, so both passes order equal counts the same and pages never overlap.
      .sort((a, b) => b.plays - a.plays || b.lastPlayed - a.lastPlayed || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(offset, end);
    if (artists.length) {
      const cached = await this.sql.all<{ name: string; tidal: string }>(
        "SELECT name, tidal FROM lastfm_artists WHERE name IN (SELECT value FROM json_each(?))",
        [JSON.stringify(artists.map((a) => a.name.toLowerCase()))],
      );
      const matches = new Map(cached.map((c) => [c.name, c.tidal]));
      for (const a of artists) a.tidal = decode<Artist>(matches.get(a.name.toLowerCase()));
    }
    return { artists, more: all.length > end, plays };
  }

  /**
   * Every artist in the range ranked by credited plays. Past 4,000 names, solo names with fewer
   * than `minPlays` plays are included only when they appear inside a collaboration. `plays` and
   * `names` always cover the whole range.
   */
  private async rankArtists(range: Range, minPlays: number) {
    type Row = { artist: string | null; plays: number; tracks: number; last: number; multi: number };
    const counts = `SELECT track, COUNT(*) AS plays, MAX(uts) AS last FROM lastfm_plays
                    WHERE uts >= ? AND uts < ? GROUP BY track`;
    const rows = await this.sql.all<Row>(
      `WITH a AS (
         SELECT t.artist, SUM(c.plays) AS plays, COUNT(*) AS tracks, MAX(c.last) AS last,
                (t.artist LIKE '% & %' OR t.artist LIKE '%, %' OR t.artist LIKE '% feat%' OR t.artist LIKE '% ft%'
                 OR t.artist LIKE '% featuring %' OR t.artist LIKE '% x %' OR t.artist LIKE '% vs%'
                 OR t.artist LIKE '% with %') AS multi
         FROM (${counts}) c JOIN lastfm_tracks t ON t.id = c.track
         GROUP BY t.artist)
       -- The totals ride along as one row with no artist.
       SELECT NULL AS artist, COALESCE(SUM(plays), 0) AS plays, COUNT(*) AS tracks, 0 AS last, 0 AS multi FROM a
       UNION ALL
       SELECT artist, plays, tracks, last, multi FROM a
       WHERE multi OR plays >= CASE WHEN (SELECT COUNT(*) FROM a) > 4000 THEN ? ELSE 1 END`,
      [range.from, range.to, minPlays],
    );
    const totals = rows.find((r) => r.artist === null)!;
    const named = rows.filter((r): r is Row & { artist: string } => r.artist !== null);
    if (totals.tracks > 4000 && minPlays > 1) {
      // Solo names left out above still decide how a collaboration splits ("A & B" credits A only
      // if A appears on its own), so fetch the ones that appear inside a collaboration. Keys use
      // SQLite's lower(), which only folds ASCII.
      const fold = (s: string) => (NON_ASCII.test(s) ? s.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : s.toLowerCase());
      const have = new Set(named.map((r) => fold(r.artist)));
      const parts = new Set<string>();
      for (const r of named) {
        if (r.multi) for (const p of artistParts(r.artist)) if (!have.has(fold(p))) parts.add(fold(p));
      }
      if (parts.size) {
        const extra = await this.sql.all<Row & { artist: string }>(
          `SELECT t.artist, SUM(c.plays) AS plays, COUNT(*) AS tracks, MAX(c.last) AS last, 0 AS multi
           FROM (${counts}) c JOIN lastfm_tracks t ON t.id = c.track
           WHERE lower(t.artist) IN (SELECT value FROM json_each(?))
           GROUP BY t.artist HAVING SUM(c.plays) < ?`,
          [range.from, range.to, JSON.stringify([...parts]), minPlays],
        );
        named.push(...extra);
      }
    }
    return { ...this.credit(named), plays: totals.plays, names: totals.tracks };
  }

  /** Credits each artist name's plays to the artists in it, ranked. */
  private credit(rows: { artist: string; plays: number; tracks: number; last: number; multi: number }[]) {
    const known = new Map<string, string>();
    const keys = rows.map((r) => {
      const key = r.artist.toLowerCase();
      if (!known.has(key)) known.set(key, r.artist);
      return key;
    });
    const byKey = new Map<string, HistoryArtist>();
    // Display names for split-off parts that never appear on their own.
    const extra = new Map<string, string>();
    rows.forEach((r, i) => {
      const names = r.multi ? credits(r.artist, known, extra) : [keys[i]];
      for (const key of names) {
        const a = byKey.get(key);
        if (a) {
          a.plays += r.plays;
          a.tracks += r.tracks;
          if (r.last > a.lastPlayed) a.lastPlayed = r.last;
        } else {
          byKey.set(key, { name: known.get(key) ?? extra.get(key) ?? key, plays: r.plays, tracks: r.tracks, lastPlayed: r.last });
        }
      }
    });
    return { all: [...byKey.values()] };
  }

  /**
   * Looks up TIDAL matches for tracks that haven't been looked up, up to the per-call budget, and
   * caches the answers. Returns how many tracks are still unmatched for lack of budget.
   */
  async matchTracks(tidal: Tidal, tracks: HistoryTrack[]): Promise<number> {
    const todo = [...new Map(tracks.filter((t) => t.tidal === undefined).map((t) => [t.key, t])).values()];
    return this.match(todo, {
      find: (t) =>
        tidal.searchTracks(`${t.artist} ${t.title}`, 10, { failFast: true }).then((hits) => pickTrack(t, hits)),
      apply: (t, hit) => tracks.forEach((x) => x.key === t.key && (x.tidal = hit)),
      save: (t, hit) => ({
        sql: "UPDATE lastfm_tracks SET tidal = ? WHERE id = ?",
        params: [hit ? JSON.stringify(hit) : "", t.key],
      }),
    });
  }

  /** As matchTracks, for artists. */
  async matchArtists(tidal: Tidal, artists: HistoryArtist[]): Promise<number> {
    return this.match(
      artists.filter((a) => a.tidal === undefined),
      {
        find: (a) =>
          tidal
            .searchArtists(a.name, 5, { failFast: true })
            .then((hits) => hits.find((h) => loose(h.name) === loose(a.name)) ?? null),
        apply: (a, hit) => (a.tidal = hit),
        save: (a, hit) => ({
          sql: "INSERT OR REPLACE INTO lastfm_artists (name, tidal) VALUES (?, ?)",
          params: [a.name.toLowerCase(), hit ? JSON.stringify(hit) : ""],
        }),
      },
    );
  }

  /**
   * TIDAL answers about ten searches in a burst, then 429s for a few seconds and refills at about
   * one a second. So a call looks up MATCH_PER_CALL items at once, stopping at the first 429, and
   * hands the rest to `defer` to look up at TIDAL's pace after the tool has answered. Each answer
   * is cached; items not looked up stay undefined and are tried again later.
   */
  private async match<T, R>(
    items: T[],
    how: {
      find: (item: T) => Promise<R | null>;
      apply: (item: T, hit: R | null) => void;
      save: (item: T, hit: R | null) => SqlStatement;
    },
  ): Promise<number> {
    let limited = false;
    const found = await mapLimit(items.slice(0, MATCH_PER_CALL), MATCH_CONCURRENCY, async (item) => {
      if (limited) return undefined;
      try {
        return await how.find(item);
      } catch (err) {
        if (err instanceof TidalError && err.status === 429) limited = true;
        return undefined;
      }
    });
    const updates: SqlStatement[] = [];
    found.forEach((hit, i) => {
      if (hit === undefined) return;
      how.apply(items[i], hit);
      updates.push(how.save(items[i], hit));
    });
    if (updates.length) await this.sql.batch(updates);
    const rest = items.filter((_, i) => found[i] === undefined);
    if (rest.length && this.defer) this.defer(this.matchLater(rest, how).catch(() => {}));
    return rest.length;
  }

  /** Looks up items one at a time at TIDAL's sustained rate, saving every few answers. */
  private async matchLater<T, R>(
    items: T[],
    how: { find: (item: T) => Promise<R | null>; save: (item: T, hit: R | null) => SqlStatement },
  ): Promise<void> {
    const updates: SqlStatement[] = [];
    for (const item of items.slice(0, MATCH_LATER)) {
      await new Promise((r) => setTimeout(r, MATCH_LATER_PACE_MS));
      try {
        updates.push(how.save(item, await how.find(item)));
      } catch (err) {
        if (err instanceof TidalError && err.status === 429) break;
      }
      if (updates.length >= 5) await this.sql.batch(updates.splice(0));
    }
    if (updates.length) await this.sql.batch(updates);
  }
}

function coverage(s: SyncRow | undefined): Coverage {
  if (!s) return { complete: false };
  return {
    syncedAt: s.synced_at ?? undefined,
    since: s.back_cursor,
    complete: !!s.back_done,
    progress: s.back_done ? 1 : s.back_total ? Math.min(0.99, s.back_fetched / s.back_total) : 0,
  };
}
