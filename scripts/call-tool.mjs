// Calls tools on the local stdio server, against the TIDAL account saved by `node dist/cli.js login`.
//   node scripts/call-tool.mjs search_tracks '{"query":"Frank Ocean","limit":3}' [tool2 'json2' ...]
// Prints each result's text, plus structuredContent with --json.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const json = args.includes("--json");
const pairs = args.filter((a) => a !== "--json");
if (!pairs.length) {
  console.error("usage: node scripts/call-tool.mjs <tool> '<json args>' [...] [--json]");
  process.exit(1);
}

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const child = spawn(process.execPath, [cli], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let nextId = 1;
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    pending.get(message.id)?.(message);
  }
});
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "call-tool", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
for (let i = 0; i < pairs.length; i += 2) {
  const started = Date.now();
  const { result, error } = await call("tools/call", { name: pairs[i], arguments: JSON.parse(pairs[i + 1] ?? "{}") });
  console.log(`### ${pairs[i]}${result?.isError ? " (ERROR)" : ""} ${Date.now() - started}ms`);
  console.log(result?.content?.[0]?.text ?? JSON.stringify(error));
  if (json && result?.structuredContent) console.log(JSON.stringify(result.structuredContent, null, 2));
  console.log();
}
child.kill();
