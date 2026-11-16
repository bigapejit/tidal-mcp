import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type { Sql } from "../core/history.js";
import { homeDir } from "./config.js";

/** The local listening-history database, in the session folder. Uses node:sqlite (Node 22.13+). */
export async function openHistoryDb(): Promise<Sql> {
  const sqlite = await import("node:sqlite").catch(() => {
    throw new Error(`Listening history needs Node 22.13 or newer (this is ${process.version}).`);
  });
  await mkdir(homeDir(), { recursive: true, mode: 0o700 });
  const db = new sqlite.DatabaseSync(join(homeDir(), "history.sqlite"));
  // The MCP server and `sync-history` may share the file.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const args = (params: unknown[] = []) => params as SQLInputValue[];
  return {
    async all<T>(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...args(params)) as T[];
    },
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const written = statements.map((s) => Number(db.prepare(s.sql).run(...args(s.params)).changes));
        db.exec("COMMIT");
        return written;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
