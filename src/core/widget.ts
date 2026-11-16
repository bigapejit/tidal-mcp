/**
 * Inline UI for MCP Apps hosts (ChatGPT, Claude, VS Code, ...).
 *
 * One self-contained page renders every tool result shape: a track list, a playlist with its
 * tracks, or a grid of playlists. It speaks the MCP Apps postMessage protocol directly
 * (ui/initialize, tool-result notifications, size-changed, open-link), so it needs no bundle.
 * Text is inserted with textContent only; tool data never becomes markup.
 *
 * Kept as a String.raw literal so both the Node build and the Worker bundle can serve it.
 * Don't use backticks or "${" inside.
 */
export const WIDGET_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: var(--color-background-primary, #ffffff);
    --bg-hover: var(--color-background-secondary, #f4f4f2);
    --ink: var(--color-text-primary, #121212);
    --muted: var(--color-text-secondary, #6b6b66);
    --faint: var(--color-text-tertiary, #9a9a94);
    --line: var(--color-border-tertiary, #e8e8e4);
    --chip: var(--color-background-tertiary, #efefeb);
    --accent: #00a3a3;
    --radius: var(--border-radius-md, 10px);
    --font: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
    color-scheme: light;
  }
  :root[data-theme="dark"] {
    --bg: var(--color-background-primary, #171717);
    --bg-hover: var(--color-background-secondary, #222222);
    --ink: var(--color-text-primary, #f2f2f2);
    --muted: var(--color-text-secondary, #a5a5a5);
    --faint: var(--color-text-tertiary, #777777);
    --line: var(--color-border-tertiary, #2c2c2c);
    --chip: var(--color-background-tertiary, #262626);
    --accent: #33d6d6;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme]) {
      --bg: #171717; --bg-hover: #222222; --ink: #f2f2f2; --muted: #a5a5a5;
      --faint: #777777; --line: #2c2c2c; --chip: #262626; --accent: #33d6d6;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; }
  body { font: 14px/1.4 var(--font); color: var(--ink); -webkit-font-smoothing: antialiased; }
  #app { padding: 4px 0 8px; }
  button { font: inherit; color: inherit; }

  .hero { display: flex; gap: 16px; align-items: flex-end; padding: 8px 8px 16px; }
  .hero .art { width: 104px; height: 104px; border-radius: var(--radius); flex: none; box-shadow: 0 6px 24px rgba(0,0,0,.18); }
  .hero .meta { min-width: 0; flex: 1; }
  .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .hero h1 { font-size: 22px; line-height: 1.2; margin: 4px 0 4px; font-weight: 700; overflow-wrap: anywhere; }
  .hero p { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
  .stats { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .dot::before { content: "\00b7"; margin-right: 6px; color: var(--faint); }
  .open { margin-top: 10px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px;
          border: 1px solid var(--line); background: transparent; cursor: pointer; font-size: 13px; font-weight: 600; }
  .open:hover { background: var(--bg-hover); }
  .head { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 8px 8px; gap: 12px; }
  .head h1 { font-size: 15px; margin: 0; font-weight: 650; overflow-wrap: anywhere; }
  .head span { color: var(--muted); font-size: 12px; white-space: nowrap; }

  .rows { list-style: none; margin: 0; padding: 0; }
  .row { width: 100%; display: grid; grid-template-columns: 22px 44px minmax(0,1fr) auto; gap: 12px; align-items: center;
         padding: 6px 8px; border: 0; background: transparent; border-radius: 8px; text-align: left; cursor: pointer; }
  .row:hover, .row:focus-visible { background: var(--bg-hover); outline: none; }
  .row:focus-visible { box-shadow: 0 0 0 2px var(--accent) inset; }
  .num { color: var(--faint); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .row .art { width: 44px; height: 44px; border-radius: 6px; }
  .text { min-width: 0; }
  .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
  .title > span { overflow: hidden; text-overflow: ellipsis; }
  .sub { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .e { flex: none; font-size: 9px; font-weight: 700; line-height: 1; padding: 2px 3px; border-radius: 3px; background: var(--chip); color: var(--muted); }
  .dur { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }

  .art { display: block; object-fit: cover; background: var(--chip); }
  .ph { display: grid; place-items: center; background: linear-gradient(135deg, var(--chip), var(--bg-hover)); color: var(--faint); }
  .ph svg { width: 40%; height: 40%; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 12px; padding: 4px 8px; }
  .card { border: 0; background: transparent; padding: 8px; border-radius: var(--radius); text-align: left; cursor: pointer; min-width: 0; }
  .card:hover, .card:focus-visible { background: var(--bg-hover); outline: none; }
  .card .art { width: 100%; aspect-ratio: 1; height: auto; border-radius: 8px; margin-bottom: 8px; }
  .card .title { font-size: 13px; }

  .more { margin: 6px 8px 0; padding: 6px 10px; border: 0; border-radius: 8px; background: var(--chip); color: var(--muted); cursor: pointer; font-size: 12.5px; font-weight: 600; }
  .missing { margin: 12px 8px 0; padding: 10px 12px; border-radius: 8px; background: var(--chip); color: var(--muted); font-size: 12.5px; }
  .missing strong { color: var(--ink); font-weight: 600; }
  .empty { padding: 16px 8px; color: var(--muted); }
</style>
</head>
<body>
<div id="app" aria-live="polite"></div>
<script>
(function () {
  var PAGE = 12;
  var GRID_PAGE = 10;
  var app = document.getElementById("app");
  var nextId = 1;
  var pending = {};

  // ---- MCP Apps bridge: JSON-RPC 2.0 over postMessage to the host frame.
  function post(msg) { msg.jsonrpc = "2.0"; window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    post({ id: id, method: method, params: params || {} });
    return new Promise(function (resolve) { pending[id] = resolve; });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method && pending[m.id]) {
      pending[m.id](m.result || {}); delete pending[m.id]; return;
    }
    if (m.method === "ui/notifications/tool-result") render(m.params && m.params.structuredContent);
    else if (m.method === "ui/notifications/host-context-changed") applyContext(m.params);
    else if (m.method && m.id !== undefined) post({ id: m.id, result: {} }); // e.g. resource-teardown
  });

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme) document.documentElement.setAttribute("data-theme", ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) Object.keys(vars).forEach(function (k) {
      if (vars[k]) document.documentElement.style.setProperty(k, vars[k]);
    });
  }

  function openLink(url) {
    request("ui/open-link", { url: url }).then(function (res) {
      if (res && res.isError) window.open(url, "_blank", "noopener");
    });
  }

  new ResizeObserver(function () {
    post({ method: "ui/notifications/size-changed", params: { height: Math.ceil(document.documentElement.scrollHeight) } });
  }).observe(document.body);

  // ---- Rendering helpers. Text goes in via textContent only.
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  var NOTE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 18.5a2.5 2.5 0 1 1-2-2.45V5.8l11-2.3v11.95a2.5 2.5 0 1 1-2-2.45V7.3l-7 1.46z"/></svg>';
  function art(src, cls) {
    if (src) {
      var img = el("img", "art " + cls);
      img.src = src; img.alt = ""; img.loading = "lazy"; img.decoding = "async";
      img.onerror = function () { img.replaceWith(placeholder(cls)); };
      return img;
    }
    return placeholder(cls);
  }
  function placeholder(cls) {
    var d = el("div", "art ph " + cls);
    d.innerHTML = NOTE; // static markup, no data
    return d;
  }
  function totalTime(sec) {
    if (!sec) return "";
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? h + " hr " + m + " min" : m + " min";
  }
  function sumSeconds(tracks) {
    return tracks.reduce(function (s, t) { return s + (t.durationSeconds || 0); }, 0);
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  function trackRow(t, i) {
    var b = el("button", "row");
    b.type = "button";
    b.title = "Open in TIDAL";
    b.appendChild(el("span", "num", i + 1));
    b.appendChild(art(t.cover, ""));
    var text = el("span", "text");
    var title = el("span", "title");
    title.appendChild(el("span", "", t.title));
    if (t.explicit) { var e = el("span", "e", "E"); e.title = "Explicit"; title.appendChild(e); }
    text.appendChild(title);
    var sub = (t.artists && t.artists.length ? t.artists.join(", ") : "Unknown artist") + (t.album ? " — " + t.album : "");
    text.appendChild(el("span", "sub", sub));
    b.appendChild(text);
    b.appendChild(el("span", "dur", t.duration || ""));
    b.onclick = function () { openLink(t.url); };
    var li = el("li"); li.appendChild(b);
    return li;
  }

  function trackList(tracks) {
    var wrap = el("div");
    var ul = el("ul", "rows");
    var shown = 0;
    function more() {
      tracks.slice(shown, shown + PAGE).forEach(function (t, i) { ul.appendChild(trackRow(t, shown + i)); });
      shown = Math.min(tracks.length, shown + PAGE);
      btn.hidden = shown >= tracks.length;
      btn.textContent = "Show " + Math.min(PAGE, tracks.length - shown) + " more";
    }
    var btn = el("button", "more"); btn.type = "button"; btn.onclick = more;
    wrap.appendChild(ul); wrap.appendChild(btn);
    more();
    return wrap;
  }

  function renderPlaylist(data) {
    var p = data.playlist || {};
    var tracks = data.tracks || [];
    var hero = el("div", "hero");
    hero.appendChild(art(p.cover || (tracks[0] && tracks[0].cover), ""));
    var meta = el("div", "meta");
    meta.appendChild(el("div", "eyebrow", data.created ? "New playlist" : "Playlist"));
    meta.appendChild(el("h1", "", p.name));
    if (p.description) meta.appendChild(el("p", "", p.description));
    var stats = el("div", "stats");
    var count = p.trackCount !== undefined ? p.trackCount : tracks.length;
    stats.appendChild(el("span", "", plural(count, "track")));
    var secs = p.durationSeconds || sumSeconds(tracks);
    if (secs) stats.appendChild(el("span", "dot", totalTime(secs)));
    if (p.visibility) stats.appendChild(el("span", "dot", p.visibility.charAt(0) + p.visibility.slice(1).toLowerCase()));
    meta.appendChild(stats);
    var open = el("button", "open", "Open in TIDAL"); open.type = "button";
    open.onclick = function () { openLink(p.url); };
    meta.appendChild(open);
    hero.appendChild(meta);
    app.appendChild(hero);
    if (tracks.length) app.appendChild(trackList(tracks));
  }

  function renderTracks(data) {
    var tracks = data.tracks || [];
    var head = el("div", "head");
    head.appendChild(el("h1", "", data.title || "Tracks"));
    var secs = sumSeconds(tracks);
    head.appendChild(el("span", "", plural(tracks.length, "track") + (secs ? " · " + totalTime(secs) : "")));
    app.appendChild(head);
    if (tracks.length) app.appendChild(trackList(tracks));
    else app.appendChild(el("div", "empty", "No tracks found."));
    if (data.missing && data.missing.length) {
      var box = el("div", "missing");
      box.appendChild(el("strong", "", "Not found: "));
      box.appendChild(document.createTextNode(data.missing.join(", ")));
      app.appendChild(box);
    }
  }

  function renderPlaylists(data) {
    var lists = data.playlists || [];
    var head = el("div", "head");
    head.appendChild(el("h1", "", data.title || "Your playlists"));
    head.appendChild(el("span", "", plural(lists.length, "playlist")));
    app.appendChild(head);
    if (!lists.length) { app.appendChild(el("div", "empty", "No playlists yet.")); return; }
    var grid = el("div", "grid");
    function card(p) {
      var c = el("button", "card"); c.type = "button"; c.title = "Open in TIDAL";
      c.appendChild(art(p.cover, ""));
      var t = el("div", "title"); t.appendChild(el("span", "", p.name)); c.appendChild(t);
      c.appendChild(el("div", "sub", p.trackCount !== undefined ? plural(p.trackCount, "track") : ""));
      c.onclick = function () { openLink(p.url); };
      return c;
    }
    // Two rows inline; the rest on request, so a big library doesn't take over the chat.
    var first = lists.slice(0, GRID_PAGE);
    first.forEach(function (p) { grid.appendChild(card(p)); });
    app.appendChild(grid);
    if (lists.length > GRID_PAGE) {
      var all = el("button", "more", "Show all " + lists.length); all.type = "button";
      all.onclick = function () {
        lists.slice(GRID_PAGE).forEach(function (p) { grid.appendChild(card(p)); });
        all.remove();
      };
      app.appendChild(all);
    }
  }

  function render(data) {
    if (!data || !data.kind) return;
    app.textContent = "";
    if (data.kind === "playlist") renderPlaylist(data);
    else if (data.kind === "playlists") renderPlaylists(data);
    else renderTracks(data);
  }

  request("ui/initialize", {
    appInfo: { name: "tidal-mcp", version: "1" },
    appCapabilities: {},
    protocolVersion: "2026-01-26"
  }).then(function (res) {
    applyContext(res && res.hostContext);
    post({ method: "ui/notifications/initialized", params: {} });
  });

  // Hosts that also expose the result directly (ChatGPT's window.openai).
  if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
})();
</script>
</body>
</html>`;
