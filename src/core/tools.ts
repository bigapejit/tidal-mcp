import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import type { Playlist, Tidal, Track } from "./tidal.js";
import { WIDGET_HTML } from "./widget.js";

export const VERSION = "0.3.3";

/**
 * MCP Apps UI (https://modelcontextprotocol.io/extensions/apps). The URI carries the version,
 * so hosts that cache templates pick up a new one after an upgrade.
 */
const VIEW_URI = `ui://tidal-mcp/view-${VERSION}.html`;
const VIEW_MIME = "text/html;profile=mcp-app";
/** Both the current nested key and the legacy flat key, so older hosts find the view too. */
const withView = { ui: { resourceUri: VIEW_URI }, "ui/resourceUri": VIEW_URI };

const trackId = z.string().regex(/^\d+$/, "TIDAL track ids are numeric");
const playlistId = z.string().min(1).describe("Playlist id (a UUID from list_my_playlists or create_playlist)");

/** Compact one-line-per-track text keeps token use low on long playlists. */
const line = (t: Track, i?: number) =>
  `${i !== undefined ? `${i + 1}. ` : ""}${t.artists.join(", ") || "Unknown artist"} - ${t.title}` +
  `${t.album ? ` [${t.album}]` : ""}${t.duration ? ` (${t.duration})` : ""}${t.explicit ? " [E]" : ""} id:${t.id}`;

const playlistLine = (p: Playlist) =>
  `${p.name} (${p.trackCount ?? "?"} tracks, ${p.visibility?.toLowerCase() ?? "?"}) id:${p.id}`;

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Without this, models restate the whole list as a markdown table under the card and try to
 * embed the cover as a (blocked) image. Phrased conditionally so text-only clients are unaffected.
 */
const VIEW_HINT =
  "\n\n[If the TIDAL view is shown to the user, it already displays this with album art, durations " +
  "and links. Reply in one or two sentences; don't repeat the list as a table or embed images.]";

/** Text for the model, plus optional structured data for the inline view. */
const result = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: structuredContent ? text + VIEW_HINT : text }],
  ...(structuredContent ? { structuredContent } : {}),
});

/** Every tool reports failures as tool errors so the model can see and recover from them. */
function safe<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return { ...result(err instanceof Error ? err.message : String(err)), isError: true };
    }
  };
}

/** An MCP server exposing the playlist tools, bound to one signed-in TIDAL user. */
export function createServer(tidal: Tidal, options: Omit<ServerOptions, "instructions"> = {}): McpServer {
  const server = new McpServer(
    { name: "tidal-mcp", version: VERSION },
    {
      ...options,
      instructions:
        "Manage the user's TIDAL playlists. To build a playlist from song names, call find_tracks with " +
        "'Artist - Title' strings, check the matches, then create_playlist with the track ids. " +
        "Ask before deleting a playlist. Tools with a visual view already show covers and track lists " +
        "to the user, so summarize briefly instead of repeating every track.",
    },
  );

  server.registerResource(
    "tidal-view",
    VIEW_URI,
    { title: "TIDAL", description: "Track lists, playlists and album art", mimeType: VIEW_MIME },
    async () => ({
      contents: [
        {
          uri: VIEW_URI,
          mimeType: VIEW_MIME,
          text: WIDGET_HTML,
          _meta: {
            ui: {
              // Album and playlist art is served from TIDAL's image CDN.
              csp: { resourceDomains: ["https://resources.tidal.com"] },
              prefersBorder: true,
            },
          },
        },
      ],
    }),
  );

  server.registerTool(
    "search_tracks",
    {
      title: "Search tracks",
      description: "Search the TIDAL catalog for tracks. Returns track ids to use with the playlist tools.",
      inputSchema: {
        query: z.string().min(1).describe("Free text, e.g. 'Frank Ocean Pink + White'"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: withView,
    },
    safe(async ({ query, limit }) => {
      const tracks = await tidal.searchTracks(query, limit);
      return result(
        tracks.length ? tracks.map((t, i) => line(t, i)).join("\n") : `No tracks found for "${query}".`,
        { kind: "tracks", title: `Results for "${query}"`, tracks },
      );
    }),
  );

  server.registerTool(
    "find_tracks",
    {
      title: "Find many tracks",
      description:
        "Resolve a list of songs to TIDAL tracks in one call, taking the top search hit for each. " +
        "Best for turning a list of song names into a playlist. Check the matches before adding them.",
      inputSchema: {
        queries: z.array(z.string().min(1)).min(1).max(100).describe("One song per entry, ideally 'Artist - Title'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: withView,
    },
    safe(async ({ queries }) => {
      const lines: string[] = [];
      const found: Track[] = [];
      const missing: string[] = [];
      // Sequential on purpose: TIDAL rate-limits bursts of search calls.
      for (const q of queries) {
        const [hit] = await tidal.searchTracks(q, 1);
        if (hit) found.push(hit);
        else missing.push(q);
        lines.push(hit ? `"${q}" -> ${line(hit)}` : `"${q}" -> NOT FOUND`);
      }
      return result(
        `${lines.join("\n")}\n\nMatched ${found.length}/${queries.length}. Track ids: ${found.map((t) => t.id).join(",")}`,
        { kind: "tracks", title: `Matched ${found.length} of ${queries.length}`, tracks: found, missing },
      );
    }),
  );

  server.registerTool(
    "similar_tracks",
    {
      title: "Similar tracks",
      description: "Tracks TIDAL considers similar to a given track. Useful for extending a playlist.",
      inputSchema: { trackId, limit: z.number().int().min(1).max(50).default(15) },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: withView,
    },
    safe(async ({ trackId, limit }) => {
      const tracks = await tidal.similarTracks(trackId, limit);
      return result(tracks.length ? tracks.map((t, i) => line(t, i)).join("\n") : "No similar tracks found.", {
        kind: "tracks",
        title: "Similar tracks",
        tracks,
      });
    }),
  );

  server.registerTool(
    "list_my_playlists",
    {
      title: "List my playlists",
      description: "Playlists owned by the signed-in user, most recently changed first.",
      inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: withView,
    },
    safe(async ({ limit }) => {
      const playlists = await tidal.listMyPlaylists(limit);
      return result(playlists.length ? playlists.map(playlistLine).join("\n") : "You have no playlists yet.", {
        kind: "playlists",
        playlists,
      });
    }),
  );

  server.registerTool(
    "get_playlist",
    {
      title: "Get playlist",
      description: "A playlist's details and its tracks in order.",
      inputSchema: { playlistId, limit: z.number().int().min(1).max(1000).default(200) },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: withView,
    },
    safe(async ({ playlistId, limit }) => {
      const [p, tracks] = await Promise.all([tidal.getPlaylist(playlistId), tidal.getPlaylistTracks(playlistId, limit)]);
      const header = `${p.name}${p.description ? ` - ${p.description}` : ""}\n${p.url}\n${p.trackCount ?? tracks.length} tracks, ${p.visibility?.toLowerCase()}`;
      return result(`${header}\n\n${tracks.map((t, i) => line(t, i)).join("\n")}`, {
        kind: "playlist",
        playlist: p,
        tracks,
      });
    }),
  );

  server.registerTool(
    "create_playlist",
    {
      title: "Create playlist",
      description: "Create a new playlist in the user's TIDAL account, optionally filled with tracks.",
      inputSchema: {
        name: z.string().min(1).max(250),
        description: z.string().max(500).optional(),
        isPublic: z.boolean().default(false).describe("Public playlists appear on the user's profile; otherwise unlisted"),
        trackIds: z.array(trackId).max(1000).optional().describe("Tracks to add, in order"),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: withView,
    },
    safe(async ({ name, description, isPublic, trackIds }) => {
      const created = await tidal.createPlaylist(name, { description, isPublic });
      if (trackIds?.length) await tidal.addTracks(created.id, trackIds, false);
      // Re-read so the view gets TIDAL's generated cover and the real totals.
      const [playlist, tracks] = trackIds?.length
        ? await Promise.all([tidal.getPlaylist(created.id), tidal.getTracks(trackIds)])
        : [created, []];
      return result(`Created "${playlist.name}" with ${tracks.length} tracks.\n${playlist.url}\nid:${playlist.id}`, {
        kind: "playlist",
        created: true,
        playlist,
        tracks,
      });
    }),
  );

  server.registerTool(
    "add_tracks",
    {
      title: "Add tracks",
      description: "Append tracks to the end of a playlist. Tracks already in it are skipped unless allowDuplicates.",
      inputSchema: {
        playlistId,
        trackIds: z.array(trackId).min(1).max(1000),
        allowDuplicates: z.boolean().default(false),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ playlistId, trackIds, allowDuplicates }) => {
      await tidal.addTracks(playlistId, trackIds, allowDuplicates);
      return result(`Sent ${trackIds.length} tracks to the playlist${allowDuplicates ? "" : " (duplicates skipped)"}.`);
    }),
  );

  server.registerTool(
    "remove_tracks",
    {
      title: "Remove tracks",
      description: "Remove every occurrence of the given tracks from a playlist.",
      inputSchema: { playlistId, trackIds: z.array(trackId).min(1).max(500) },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ playlistId, trackIds }) => {
      const n = await tidal.removeTracks(playlistId, trackIds);
      return result(n ? `Removed ${n} entr${n === 1 ? "y" : "ies"}.` : "None of those tracks were in the playlist.");
    }),
  );

  server.registerTool(
    "update_playlist",
    {
      title: "Update playlist",
      description: "Rename a playlist, change its description, or change its visibility.",
      inputSchema: {
        playlistId,
        name: z.string().min(1).max(250).optional(),
        description: z.string().max(500).optional(),
        isPublic: z.boolean().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ playlistId, ...changes }) => {
      if (Object.values(changes).every((v) => v === undefined)) return result("Nothing to change.");
      await tidal.updatePlaylist(playlistId, changes);
      return result("Playlist updated.");
    }),
  );

  server.registerTool(
    "delete_playlist",
    {
      title: "Delete playlist",
      description: "Permanently delete one of the user's playlists. Confirm with the user first.",
      inputSchema: { playlistId },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ playlistId }) => {
      await tidal.deletePlaylist(playlistId);
      return result("Playlist deleted.");
    }),
  );

  return server;
}
