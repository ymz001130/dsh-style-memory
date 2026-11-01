import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakeReact() {
  class Component {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(patch) {
      const next = typeof patch === "function" ? patch(this.state, this.props) : patch;
      this.state = Object.assign({}, this.state, next || {});
    }
  }
  function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2).flat(Infinity);
    return { type, props: props || {}, children };
  }
  return { Component, createElement };
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node.type === "function") {
    const instance = new node.type(node.props || {});
    const rendered = instance.render ? instance.render() : node.type(node.props || {});
    return textOf(rendered);
  }
  return textOf(node.children);
}

test("style-memory panel renders structured rules and a high-contrast palette", async () => {
  const captured = { definition: null };
  const document = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    body: { parentElement: null },
    documentElement: { parentElement: null }
  };
  const windowObject = {
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle() { return { backgroundColor: "rgb(24, 24, 24)", color: "rgb(220,220,220)" }; },
    __ModuleLoader__: { load(definition) { captured.definition = definition; } }
  };
  const data = {
    ok: true,
    pluginVersion: "0.6.2",
    profileVersion: 11,
    updatedAt: "2026-11-01T12:43:16.178Z",
    dataDir: "C:/Users/test/.dsh/style-memory",
    enabled: true,
    gate: { enabled: true, threshold: 60, maxAttempts: 3 },
    inject: { enabled: true, maxChars: 400 },
    stats: { version: 11, activeRules: 10, candidateRules: 8, evidence: { pairs: 4, edits: 147 } },
    cardText: "【你的写作风格 v11·讲稿/讲课】句子长短交替，结尾停在具体事上。",
    rulesText: "fallback",
    historyText: "fallback",
    rules: [
      { id: "r1", type: "banned_phrase", typeLabel: "禁用表达", text: "超声只用于测厚度", status: "active", confidence: 80, evidence: 3, anchor: "原句示例" },
      { id: "r2", type: "rewrite", typeLabel: "改写偏好", text: "这带出", to: "这里有", status: "candidate", confidence: 61, evidence: 1, anchor: "待验证示例" }
    ],
    history: [
      { name: "2026-11-01T12-00-33-647Z-learn.json", kind: "learn", genre: "lecture", at: "2026-11-01T12:00:33.646Z", edits: 35, added: 0, note: "live 学习" }
    ]
  };
  const sandbox = {
    window: windowObject,
    document,
    console,
    fetch: function () {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data); } });
    },
    setTimeout,
    clearTimeout,
    Symbol,
    Object,
    Array,
    Promise,
    String,
    Number,
    Date,
    RegExp,
    JSON,
    Math,
    parseInt,
    parseFloat,
    isNaN
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(root, "client.js"), "utf8"), sandbox, { filename: "client.js" });
  assert.ok(captured.definition, "client bootstrap must register a module");
  const moduleObject = captured.definition.factory(function () { return fakeReact(); });
  const Panel = moduleObject.__test.StyleMemoryPanel;
  assert.equal(typeof Panel, "function");
  const panel = new Panel({});
  panel.componentDidMount();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const tree = panel.render();
  const text = textOf(tree);
  assert.match(text, /风格记忆/);
  assert.match(text, /当前画像卡/);
  assert.match(text, /学到的规则/);
  assert.match(text, /禁用表达/);
  assert.match(text, /超声只用于测厚度/);
  assert.match(text, /最近学习记录/);
  assert.match(text, /0\.6\.2/);
  assert.ok(tree.props.style.color === "#f2f2f2", "dark background should get light text");
});
