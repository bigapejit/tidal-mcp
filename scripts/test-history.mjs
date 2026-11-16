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
    async batch(stmts) { db.exec("BEGIN"); try { let n = 0; for (const s of stmts) n += Number(db.prepare(s.sql).run(...(s.params ?? [])).changes); db.exec("COMMIT"); return n; } catch (e) { db.exec("ROLLBACK"); throw e; } },
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

await check("a claim includes its own row: 402 rows left is not enough for a page", async () => {
  const sql = memSql();
  const h = new History(sql, fakeLastFm(), { dailyWrites: 10_000 });
  await h.sync({ forward: 1, backfill: 0 });
  sql.db.prepare("UPDATE lastfm_sync SET day_writes = ?").run(10_000 - 402);
  await h.sync({ forward: 0, backfill: 3 });
  assert.equal((await state(sql)).back_fetched, 0);
  sql.db.prepare("UPDATE lastfm_sync SET day_writes = ?").run(10_000 - 403);
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

await check("a page fetched across midnight claims against the new day, or waits", async () => {
  const RealDate = Date;
  let now = RealDate.parse("2026-11-16T23:59:59.900Z");
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
  try {
    const sql = memSql();
    // The fetch crosses midnight.
    const h = new History(sql, fakeLastFm(async () => { now += 200; }), { dailyWrites: 2_000 });
    await h.sync({ forward: 1, backfill: 0 }); // now 2026-11-17 00:00:00.100
    now = RealDate.parse("2026-11-17T23:59:59.900Z");
    sql.db.prepare("UPDATE lastfm_sync SET day = '2026-11-17', day_writes = 0").run();
    // Pretend the new day's budget is already spent by another sync once midnight passes.
    const lf2 = fakeLastFm(async () => { now += 200; sql.db.prepare("UPDATE lastfm_sync SET day = '2026-11-18', day_writes = 1999").run(); });
    const h2 = new History(sql, lf2, { dailyWrites: 2_000 });
    const before = (await state(sql)).back_fetched;
    await h2.sync({ forward: 0, backfill: 1 });
    const s = await state(sql);
    assert.equal(s.back_fetched, before, "page committed without new-day budget");
    assert.equal(s.day, "2026-11-18");
    assert.ok(s.day_writes <= 2_000, `day_writes ${s.day_writes}`);
  } finally { globalThis.Date = RealDate; }
});
await check("a page that would commit after midnight by the database's clock writes nothing, then is retried", async () => {
  const sql = memSql();
  // Pages follow the cursor, so a skipped page would show up as a gap.
  const lf = { user: "u", async recent({ from, to }) {
    if (from) return { scrobbles: [], total: 0, totalPages: 0 };
    const scrobbles = Array.from({ length: 200 }, (_, i) => ({ uts: to - 1 - i, artist: `Artist ${to - 1 - i}`, title: "T" }));
    return { scrobbles, total: 1e6, totalPages: 5000 };
  } };
  const h = new History(sql, lf, { dailyWrites: 100_000 });
  await h.sync({ forward: 1, backfill: 0 });
  const [{ back_cursor: start }] = await sql.all("SELECT back_cursor FROM lastfm_sync");
  // The JS clock (which made the reservation) is on another day than SQLite's date('now').
  const RealDate = Date;
  const other = RealDate.parse("2030-01-01T12:00:00Z");
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [other])); } static now() { return other; } };
  try {
    await h.sync({ forward: 0, backfill: 2 });
  } finally { globalThis.Date = RealDate; }
  const [skipped] = await sql.all("SELECT back_cursor, back_fetched, (SELECT COUNT(*) FROM lastfm_plays) AS plays FROM lastfm_sync");
  assert.deepEqual([skipped.back_cursor, skipped.back_fetched, skipped.plays], [start, 0, 0]);
  await h.sync({ forward: 0, backfill: 1 });
  const [after] = await sql.all("SELECT back_fetched, (SELECT COUNT(*) FROM lastfm_plays) AS plays, (SELECT MAX(uts) FROM lastfm_plays) AS newest FROM lastfm_sync");
  assert.deepEqual([after.back_fetched, after.plays, after.newest], [200, 200, start]);
});

console.log(`${ok} passed`);
