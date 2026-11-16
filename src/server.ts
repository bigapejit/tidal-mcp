import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tidal from "./tidal.js";
import type { Track } from "./tidal.js";

const VERSION = "0.1.0";

const trackId = z.string().regex(/^\d+$/, "TIDAL track ids are numeric");
const playlistId = z.string().min(1).describe("Playlist id (a UUID from list_my_playlists or create_playlist)");

/** Compact one-line-per-track text keeps token use low on long playlists. */
const line = (t: Track, i?: number) =>
  `${i !== undefined ? `${i + 1}. ` : ""}${t.artists.join(", ") || "Unknown artist"} - ${t.title}` +
  `${t.album ? ` [${t.album}]` : ""}${t.duration ? ` (${t.duration})` : ""}${t.explicit ? " [E]" : ""} id:${t.id}`;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** Every tool reports failures as tool errors so the model can see and recover from them. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
    }
  };
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "tidal-mcp", version: VERSION },
    {
      instructions:
        "Manage the user's TIDAL playlists. To build a playlist from song names, call find_tracks with " +
        "'Artist - Title' strings, check the matches, then create_playlist with the track ids. " +
        "Ask before deleting a playlist.",
    },
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
    },
    safe(async ({ query, limit }) => {
      const tracks = await tidal.searchTracks(query, limit);
      return text(tracks.length ? tracks.map((t, i) => line(t, i)).join("\n") : `No tracks found for "${query}".`);
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
    },
    safe(async ({ queries }) => {
      const results: string[] = [];
      const found: string[] = [];
      // Sequential on purpose: TIDAL rate-limits bursts of search calls.
      for (const q of queries) {
        const [hit] = await tidal.searchTracks(q, 1);
        if (hit) found.push(hit.id);
        results.push(hit ? `"${q}" -> ${line(hit)}` : `"${q}" -> NOT FOUND`);
      }
      return text(`${results.join("\n")}\n\nMatched ${found.length}/${queries.length}. Track ids: ${found.join(",")}`);
    }),
  );

  server.registerTool(
    "similar_tracks",
    {
      title: "Similar tracks",
      description: "Tracks TIDAL considers similar to a given track. Useful for extending a playlist.",
      inputSchema: { trackId, limit: z.number().int().min(1).max(50).default(15) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ trackId, limit }) => {
      const tracks = await tidal.similarTracks(trackId, limit);
      return text(tracks.length ? tracks.map((t, i) => line(t, i)).join("\n") : "No similar tracks found.");
    }),
  );

  server.registerTool(
    "list_my_playlists",
    {
      title: "List my playlists",
      description: "Playlists owned by the signed-in user, most recently changed first.",
      inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ limit }) => {
      const lists = await tidal.listMyPlaylists(limit);
      if (!lists.length) return text("You have no playlists yet.");
      return text(
        lists
          .map((p) => `${p.name} (${p.trackCount ?? "?"} tracks, ${p.visibility?.toLowerCase() ?? "?"}) id:${p.id}`)
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "get_playlist",
    {
      title: "Get playlist",
      description: "A playlist's details and its tracks in order.",
      inputSchema: { playlistId, limit: z.number().int().min(1).max(1000).default(200) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ playlistId, limit }) => {
      const [p, tracks] = await Promise.all([tidal.getPlaylist(playlistId), tidal.getPlaylistTracks(playlistId, limit)]);
      const header = `${p.name}${p.description ? ` - ${p.description}` : ""}\n${p.url}\n${p.trackCount ?? tracks.length} tracks, ${p.visibility?.toLowerCase()}`;
      return text(`${header}\n\n${tracks.map((t, i) => line(t, i)).join("\n")}`);
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
    },
    safe(async ({ name, description, isPublic, trackIds }) => {
      const p = await tidal.createPlaylist(name, { description, isPublic });
      if (trackIds?.length) await tidal.addTracks(p.id, trackIds, false);
      return text(`Created "${p.name}" with ${trackIds?.length ?? 0} tracks.\n${p.url}\nid:${p.id}`);
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
      return text(`Sent ${trackIds.length} tracks to the playlist${allowDuplicates ? "" : " (duplicates skipped)"}.`);
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
      return text(n ? `Removed ${n} entr${n === 1 ? "y" : "ies"}.` : "None of those tracks were in the playlist.");
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
      if (Object.values(changes).every((v) => v === undefined)) return text("Nothing to change.");
      await tidal.updatePlaylist(playlistId, changes);
      return text("Playlist updated.");
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
      return text("Playlist deleted.");
    }),
  );

  return server;
}

export async function runServer(): Promise<void> {
  await buildServer().connect(new StdioServerTransport());
}
