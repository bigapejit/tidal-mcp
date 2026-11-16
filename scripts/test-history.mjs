// Boundary tests for the listening history: top_artists paging and the D1 write budget.
// Runs against an in-memory node:sqlite database and a fake Last.fm, so it needs no network.
//   npm run build && node scripts/test-history.mjs
// Skipped on Node versions without node:sqlite (before 22.13), which the rest of the server supports.
import assert from "node:assert/strict";
import { History, parseRange } from "../dist/core/history.js";

const sqlite = await import("node:sqlite").catch(() => undefined);
if (!sqlite) {
  console.log(`history tests skipped: node:sqlite needs Node 22.13+ (this is ${process.version})`);
  process.exit(0);
}
const { DatabaseSync } = sqlite;

function memSql() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    async all(sql, params = []) { return db.prepare(sql).all(...params).map((r) => ({ ...r })); },
    async batch(stmts) { db.exec("BEGIN"); try { const n = stmts.map((s) => Number(db.prepare(s.sql).run(...(s.params ?? [])).changes)); db.exec("COMMIT"); return n; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
}
const all = parseRange({});
let ok = 0;
const check = (name, fn) => fn().then(() => { ok++; console.log("PASS", name); }, (e) => { console.log("FAIL", name, e.message); process.exitCode = 1; });

async function artistsDb(rows) {
  const sql = memSql();
  const h = new History(sql, { user: "u" });
  await h.ready();
  let id = 1, uts = 1000;
  for (const [artist, plays] of rows) {
    const t = id++;
    sql.db.prepare("INSERT INTO lastfm_tracks (id, artist, title) VALUES (?, ?, ?)").run(t, artist, "song" + t);
    for (let i = 0; i < plays; i++) sql.db.prepare("INSERT INTO lastfm_plays (uts, track) VALUES (?, ?)").run(uts++, t);
  }
  return h;
}
async function pages(h, limit, n) {
  const out = []; let more = true;
  for (let p = 0; p < n && more; p++) { const r = await h.topArtists(all, limit, p * limit); out.push(...r.artists.map((a) => `${a.name}:${a.plays}`)); more = r.more; }
  return out;
}

await check("more stays true when the filtered list ends at the page (4,001 solo names)", async () => {
  const h = await artistsDb([["Top", 3], ...Array.from({ length: 4000 }, (_, i) => [`Solo ${i}`, 1])]);
  const r = await h.topArtists(all, 1, 0);
  assert.equal(r.artists[0].name, "Top");
  assert.equal(r.more, true);
});

await check("pages don't overlap or skip when a later page falls back to the full ranking", async () => {
  const filler = Array.from({ length: 4000 }, (_, i) => [`Filler ${i}`, 1]);
  const h = await artistsDb([["A & B", 100], ["A", 1], ["B", 1], ["X", 99], ...filler]);
  const paged = await pages(h, 1, 6);
  const whole = (await h.topArtists(all, 6, 0)).artists.map((a) => `${a.name}:${a.plays}`);
  assert.deepEqual(paged, whole);
  assert.deepEqual(paged.slice(0, 3).sort(), ["A:101", "B:101", "X:99"]); assert.equal(paged[2], "X:99");
  assert.equal(new Set(paged).size, paged.length);
});

await check("spellings of one artist pass the cutoff together (Alpha 3 + ALPHA 2 beats X 5)", async () => {
  const filler = Array.from({ length: 4000 }, (_, i) => [`Filler ${i}`, 1]);
  const h = await artistsDb([["Alpha", 3], ["ALPHA", 2], ["Alpha & B", 1], ["X", 5], ...filler]);
  const r = await h.topArtists(all, 1, 0);
  assert.equal(`${r.artists[0].name}:${r.artists[0].plays}`, "Alpha:6");
  const exact = await h.rankArtists(all, 1);
  const top = exact.all.sort((a, b) => b.plays - a.plays)[0];
  assert.equal(`${top.name}:${top.plays}`, "Alpha:6");
});

// --- Budget: a fake Last.fm with endless full pages of new tracks.
function fakeLastFm(onFetch) {
  let next = 10_000_000;
  return { user: "u", async recent({ from }) {
    await onFetch?.();
    if (from) return { scrobbles: [], total: 0, totalPages: 0 }; // forward walk: nothing new
    const scrobbles = Array.from({ length: 200 }, () => { next--; return { uts: next, artist: "Artist " + next, title: "T" + next }; });
    return { scrobbles, total: 1e6, totalPages: 5000 };
  } };
}
const state = async (sql) => (await sql.all("SELECT day_writes, day, back_fetched FROM lastfm_sync"))[0];

// A full page writes 200 tracks, 200 plays and 3 state rows; its claim adds its own row: 404.
await check("a claim covers a full page plus its own row: 403 rows left is not enough", async () => {
  const sql = memSql();
  const h = new History(sql, fakeLastFm(), { dailyWrites: 10_000 });
  await h.sync({ forward: 1, backfill: 0 });
  sql.db.prepare("UPDATE lastfm_sync SET day_writes = ?").run(10_000 - 403);
  await h.sync({ forward: 0, backfill: 3 });
  assert.equal((await state(sql)).back_fetched, 0);
  sql.db.prepare("UPDATE lastfm_sync SET day_writes = ?").run(10_000 - 404);
  await h.sync({ forward: 0, backfill: 3 });
  const s = await state(sql);
  assert.equal(s.back_fetched, 200);
  assert.ok(s.day_writes <= 10_000, `day_writes ${s.day_writes} over budget`);
});

await check("concurrent syncs never exceed the budget", async () => {
  const sql = memSql();
  const lf = fakeLastFm(() => new Promise((r) => setTimeout(r, 5)));
  const a = new History(sql, lf, { dailyWrites: 5_000 });
  const b = new History(sql, lf, { dailyWrites: 5_000 });
  await a.sync({ forward: 1, backfill: 0 });
  await Promise.all([a.sync({ forward: 0, backfill: 20 }), b.sync({ forward: 0, backfill: 20 })]);
  const s = await state(sql);
  assert.ok(s.day_writes <= 5_000, `day_writes ${s.day_writes} over budget`);
  const [n] = await sql.all("SELECT (SELECT COUNT(*) FROM lastfm_plays) + (SELECT COUNT(*) FROM lastfm_tracks) AS rows");
  assert.ok(n.rows <= 5_000, `${n.rows} rows written over budget`);
});

// --- Midnight UTC. These control SQLite's clock (date() is overridden on the test connection)
// and hook in before each statement of a batch, to land midnight at exact points.
function clockedDb() {
  const sql = memSql();
  const clock = { today: "2099-01-01", before: () => {} };
  sql.db.function("date", { varargs: true }, () => clock.today);
  sql.batch = async (stmts) => {
    sql.db.exec("BEGIN");
    try {
      const n = stmts.map((s, i) => { clock.before(i, s.sql); return Number(sql.db.prepare(s.sql).run(...(s.params ?? [])).changes); });
      sql.db.exec("COMMIT");
      return n;
    } catch (e) { sql.db.exec("ROLLBACK"); throw e; }
  };
  return { sql, clock };
}
// Pages follow the cursor, so a skipped page shows up as a gap.
const cursorLastFm = (onFetch) => ({ user: "u", async recent({ from, to }) {
  await onFetch?.();
  if (from) return { scrobbles: [], total: 0, totalPages: 0 };
  const scrobbles = Array.from({ length: 200 }, (_, i) => ({ uts: to - 1 - i, artist: `Artist ${to - 1 - i}`, title: "T" }));
  return { scrobbles, total: 1e6, totalPages: 5000 };
} });
const isCommit = (sql) => sql.includes("SET page_ok");
const snapshot = async (sql) => (await sql.all(`SELECT day, day_writes, back_cursor, back_fetched,
  (SELECT COUNT(*) FROM lastfm_plays) AS plays, (SELECT COUNT(*) FROM lastfm_tracks) AS tracks,
  (SELECT MAX(uts) FROM lastfm_plays) AS newest FROM lastfm_sync`))[0];

await check("midnight between a claim and its commit: the page re-claims on the new day and lands whole", async () => {
  const { sql, clock } = clockedDb();
  const h = new History(sql, cursorLastFm(), { dailyWrites: 100_000 });
  await h.sync({ forward: 1, backfill: 0 });
  const start = (await snapshot(sql)).back_cursor;
  clock.before = (i, s) => { if (i === 0 && isCommit(s)) clock.today = "2099-01-02"; };
  await h.sync({ forward: 0, backfill: 1 });
  const r = await snapshot(sql);
  assert.deepEqual([r.plays, r.tracks, r.back_fetched, r.newest, r.day], [200, 200, 200, start, "2099-01-02"]);
});

await check("midnight between a commit's statements: the page is stored whole", async () => {
  const { sql, clock } = clockedDb();
  const h = new History(sql, cursorLastFm(), { dailyWrites: 100_000 });
  await h.sync({ forward: 1, backfill: 0 });
  let inCommit = false;
  clock.before = (i, s) => { if (i === 0) inCommit = isCommit(s); if (inCommit && i === 1) clock.today = "2099-01-02"; };
  await h.sync({ forward: 0, backfill: 1 });
  const r = await snapshot(sql);
  assert.deepEqual([r.plays, r.tracks, r.back_fetched], [200, 200, 200]);
});

await check("midnight with the new day's budget already spent: nothing is stored and the cursor stays", async () => {
  const { sql, clock } = clockedDb();
  const lf = cursorLastFm(() => {
    if (clock.armed) { clock.today = "2099-01-02"; sql.db.prepare("UPDATE lastfm_sync SET day = '2099-01-02', day_writes = 1999").run(); }
  });
  const h = new History(sql, lf, { dailyWrites: 2_000 });
  await h.sync({ forward: 1, backfill: 0 });
  const before = await snapshot(sql);
  clock.armed = true;
  await h.sync({ forward: 0, backfill: 1 });
  const r = await snapshot(sql);
  assert.deepEqual([r.plays, r.tracks, r.back_fetched, r.back_cursor], [0, 0, before.back_fetched, before.back_cursor]);
  assert.equal(r.day, "2099-01-02");
  assert.ok(r.day_writes <= 2_000, `day_writes ${r.day_writes}`);
});

await check("a claim that lands after midnight counts against the new day, never overwriting it", async () => {
  const { sql, clock } = clockedDb();
  const h = new History(sql, cursorLastFm(), { dailyWrites: 100_000 });
  await h.sync({ forward: 1, backfill: 0 });
  // Another sync already moved the count to the new day; the database clock agrees.
  sql.db.prepare("UPDATE lastfm_sync SET day = '2099-01-02', day_writes = 500").run();
  clock.today = "2099-01-02";
  await h.sync({ forward: 0, backfill: 1 });
  const r = await snapshot(sql);
  assert.equal(r.day, "2099-01-02");
  assert.ok(r.day_writes >= 500 + 400, `new day's count was overwritten: ${r.day_writes}`);
  assert.equal(r.plays, 200);
});

console.log(`${ok} passed`);
