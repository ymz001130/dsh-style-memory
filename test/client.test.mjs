import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = readFileSync(join(root, "client.js"), "utf8");

test("style-memory panel refreshes on open/focus/foreground without polling", () => {
  assert.match(client, /window\.addEventListener\("focus"/);
  assert.match(client, /document\.addEventListener\("visibilitychange"/);
  assert.match(client, /componentWillUnmount/);
  assert.match(client, /刷新/);
  assert.match(client, /不做后台轮询/);
  assert.match(client, /detectPalette/);
  assert.match(client, /RuleItem/);
  assert.match(client, /overflowX: "hidden"/);
  assert.equal(/setInterval\s*\(/.test(client), false, "client must not poll with setInterval");
  assert.equal(/EventSource\s*\(/.test(client), false, "client must not open an SSE stream");
});
