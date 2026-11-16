# tidal-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) build and manage your TIDAL playlists.

> "Make me a 25-song playlist of late-90s neo-soul, skip anything over 6 minutes."

It talks to the [official TIDAL API](https://tidal-music.github.io/tidal-api-reference/) with your own developer credentials. It does not use reverse-engineered endpoints or a shared client id, so a TIDAL app update won't break it.

## Tools

| Tool | What it does |
| --- | --- |
| `search_tracks` | Search the catalog for tracks |
| `find_tracks` | Turn a list of "Artist - Title" strings into track ids in one call |
| `similar_tracks` | Tracks TIDAL considers similar to a given track |
| `list_my_playlists` | Your playlists, most recently changed first |
| `get_playlist` | A playlist's details and tracks |
| `create_playlist` | Create a playlist, optionally filled with tracks |
| `add_tracks` | Append tracks (skips duplicates by default) |
| `remove_tracks` | Remove tracks from a playlist |
| `update_playlist` | Rename, re-describe, or change visibility |
| `delete_playlist` | Delete a playlist (annotated as destructive, so clients ask first) |

## Setup

You need Node 20+ and a TIDAL account.

### 1. Create a TIDAL developer app

1. Go to the [TIDAL Developer Dashboard](https://developer.tidal.com/dashboard) and sign in.
2. Create an app.
3. Add this redirect URI: `http://127.0.0.1:8765/callback`
4. Enable these scopes: `user.read`, `search.read`, `playlists.read`, `playlists.write`, `collection.read`
5. Copy the **Client ID**.

### 2. Install and sign in

```sh
git clone https://github.com/bigapejit/tidal-mcp.git
cd tidal-mcp
npm install          # also builds
node dist/index.js login --client-id YOUR_CLIENT_ID
```

A browser window opens to TIDAL's sign-in page. After you approve, the session is saved to `~/.tidal-mcp/`, readable only by your user. Tokens refresh automatically.

Use `--no-browser` to print the URL instead, and `--port` if 8765 is taken (then register that redirect URI instead). If your app was issued a client secret, pass `--client-secret` too.

### 3. Add it to your MCP client

Use the absolute path to `dist/index.js`.

**Claude Code**

```sh
claude mcp add tidal -- node /absolute/path/to/tidal-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": ["/absolute/path/to/tidal-mcp/dist/index.js"]
    }
  }
}
```

## Commands

```
tidal-mcp                Run the MCP server over stdio
tidal-mcp login          Sign in to TIDAL
tidal-mcp status         Check whether you're signed in
tidal-mcp logout         Delete the saved session and settings
```

`TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET`, and `TIDAL_MCP_HOME` (the session folder) can also be set as environment variables.

## Notes

- New playlists are **unlisted** unless you ask for a public one.
- Search and availability follow your account's country.
- Writes send an `Idempotency-Key`, so a retried request never adds tracks twice.

## License

MIT
