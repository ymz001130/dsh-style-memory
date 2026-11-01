(() => {
  try {
    window.__ModuleLoader__.load({
      id: "dsh-style-memory",
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var react = require("react");
        var el = react.createElement;
        var inject = ["slots"];
        var PLUGIN_ID = "dsh-style-memory";
        var PANEL_ID = "style-memory-panel";
        var PANEL_LABEL = "风格记忆";

        var TYPE_LABELS = {
          banned_phrase: "禁用表达",
          rewrite: "改写偏好",
          preferred_phrase: "偏好表达",
          structural: "结构习惯",
          opening: "开场习惯",
          closing: "结尾习惯",
          term: "术语偏好",
          chat_phrase: "口头表达",
          human_feature: "人味特征"
        };

        function parseColor(value) {
          var text = String(value || "");
          var match = text.match(/rgba?\(([^)]+)\)/);
          if (match === null) return null;
          var parts = match[1].split(",");
          var r = parseFloat(parts[0]);
          var g = parseFloat(parts[1]);
          var b = parseFloat(parts[2]);
          var a = parts.length > 3 ? parseFloat(parts[3]) : 1;
          if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
          return { r: r, g: g, b: b, a: isNaN(a) ? 1 : a };
        }

        function luminance(color) {
          return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
        }

        function findBackdrop(element) {
          var node = element;
          while (node && node !== document.documentElement) {
            var style = window.getComputedStyle(node);
            var color = parseColor(style.backgroundColor);
            if (color !== null && color.a >= 0.5) return color;
            node = node.parentElement;
          }
          var html = parseColor(window.getComputedStyle(document.documentElement).backgroundColor);
          if (html !== null && html.a >= 0.5) return html;
          var body = parseColor(window.getComputedStyle(document.body).backgroundColor);
          if (body !== null && body.a >= 0.5) return body;
          try {
            if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
              return { r: 255, g: 255, b: 255, a: 1 };
            }
          } catch (error) { /* ignore */ }
          return { r: 0, g: 0, b: 0, a: 1 };
        }

        function paletteFor(dark) {
          if (dark) {
            return {
              text: "#f2f2f2",
              secondary: "#c9c9c9",
              faint: "#9aa0a6",
              border: "rgba(255,255,255,0.24)",
              chipBg: "rgba(255,255,255,0.07)",
              sectionBg: "rgba(255,255,255,0.045)",
              buttonBg: "rgba(255,255,255,0.12)",
              accent: "#8ab4ff",
              danger: "#ff7b72"
            };
          }
          return {
            text: "#1f2328",
            secondary: "#57606a",
            faint: "#6e7781",
            border: "rgba(0,0,0,0.16)",
            chipBg: "rgba(0,0,0,0.03)",
            sectionBg: "rgba(0,0,0,0.02)",
            buttonBg: "rgba(0,0,0,0.05)",
            accent: "#0969da",
            danger: "#cf222e"
          };
        }

        function detectPalette(element) {
          try {
            var backdrop = element ? findBackdrop(element) : null;
            var dark = backdrop === null ? true : luminance(backdrop) < 0.55;
            return paletteFor(dark);
          } catch (error) {
            return paletteFor(true);
          }
        }

        function makeStyles(p) {
          return {
            root: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px", height: "100%", minHeight: 0, width: "100%", minWidth: 0, boxSizing: "border-box", overflowY: "auto", overflowX: "hidden", color: p.text, fontSize: "14px", lineHeight: "1.7" },
            toolbar: { display: "flex", alignItems: "center", gap: "10px", width: "100%", minWidth: 0 },
            title: { fontSize: "16px", fontWeight: 700, margin: 0, color: p.text, flex: "1 1 auto", minWidth: 0 },
            button: { flex: "0 0 auto", padding: "5px 14px", borderRadius: "8px", border: "1px solid " + p.border, background: p.buttonBg, color: p.text, fontSize: "12.5px", fontWeight: 600, cursor: "pointer" },
            row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", width: "100%", minWidth: 0 },
            chip: { display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: "999px", fontSize: "12px", border: "1px solid " + p.border, color: p.secondary, background: p.chipBg, whiteSpace: "nowrap", maxWidth: "100%" },
            note: { color: p.secondary, fontSize: "12.5px", lineHeight: "1.6" },
            error: { color: p.danger, fontSize: "12.5px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
            section: { display: "flex", flexDirection: "column", gap: "8px", padding: "12px", borderRadius: "10px", border: "1px solid " + p.border, background: p.sectionBg, minWidth: 0, width: "100%", boxSizing: "border-box" },
            label: { fontSize: "12.5px", fontWeight: 700, color: p.secondary, letterSpacing: "0.02em" },
            pre: { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", fontFamily: "inherit", fontSize: "13.5px", lineHeight: "1.75", color: p.text, minWidth: 0, width: "100%" },
            dim: { color: p.faint, fontSize: "11.5px", overflowWrap: "anywhere" },
            rule: { display: "flex", flexDirection: "column", gap: "5px", padding: "9px 10px", borderRadius: "8px", border: "1px solid " + p.border, background: p.chipBg, minWidth: 0 },
            ruleHead: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", minWidth: 0 },
            badge: { display: "inline-flex", alignItems: "center", padding: "1px 7px", borderRadius: "6px", fontSize: "11.5px", fontWeight: 600, color: p.text, background: p.buttonBg, border: "1px solid " + p.border },
            small: { fontSize: "11.5px", color: p.faint },
            ruleText: { fontSize: "13.5px", color: p.text, lineHeight: "1.65", overflowWrap: "anywhere", wordBreak: "break-word" },
            example: { marginTop: "4px", padding: "7px 8px", borderRadius: "6px", background: p.sectionBg, fontSize: "12px", color: p.secondary, lineHeight: "1.6", overflowWrap: "anywhere", wordBreak: "break-word", whiteSpace: "pre-wrap" },
            linkButton: { padding: 0, border: "none", background: "transparent", color: p.accent, cursor: "pointer", fontSize: "12px", textAlign: "left" },
            historyRow: { display: "flex", flexDirection: "column", gap: "2px", padding: "6px 0", borderTop: "1px solid " + p.border, minWidth: 0 },
            historyTitle: { fontSize: "13px", color: p.text, fontWeight: 600, overflowWrap: "anywhere" },
            historyMeta: { fontSize: "11.5px", color: p.faint, overflowWrap: "anywhere" }
          };
        }

        function chip(label, value, styles) {
          return el("span", { style: styles.chip }, label + " " + String(value));
        }

        function section(title, styles, content) {
          if (content === null || content === undefined) return null;
          return el("div", { style: styles.section },
            el("div", { style: styles.label }, title),
            content
          );
        }

        function formatClock(value) {
          if (!value) return "—";
          var date = new Date(value);
          if (isNaN(date.getTime())) return "—";
          return [date.getHours(), date.getMinutes(), date.getSeconds()].map(function (part) {
            return String(part).padStart(2, "0");
          }).join(":");
        }

        function ruleBody(rule) {
          if (rule.type === "rewrite") return "把「" + rule.text + "」改成「" + (rule.to || "") + "」";
          if (rule.type === "term") return "统一「" + rule.text + "」→「" + (rule.to || "") + "」";
          return rule.text;
        }

        class RuleItem extends react.Component {
          constructor(props) {
            super(props);
            this.state = { open: false };
            this.toggle = this.toggle.bind(this);
          }

          toggle() {
            this.setState({ open: !this.state.open });
          }

          render() {
            var rule = this.props.rule;
            var styles = this.props.styles;
            var meta = "证据 " + (rule.evidence || 0) + " 次 · 置信 " + (rule.confidence || 0) + "%";
            return el("div", { style: styles.rule },
              el("div", { style: styles.ruleHead },
                el("span", { style: styles.badge }, rule.typeLabel || TYPE_LABELS[rule.type] || rule.type),
                el("span", { style: styles.small }, meta),
                rule.status !== "active" ? el("span", { style: styles.small }, "待验证") : null
              ),
              el("div", { style: styles.ruleText }, ruleBody(rule)),
              rule.anchor ? el("div", null,
                el("button", { style: styles.linkButton, onClick: this.toggle }, this.state.open ? "收起示例" : "示例"),
                this.state.open ? el("div", { style: styles.example }, rule.anchor) : null
              ) : null
            );
          }
        }

        class StyleMemoryPanel extends react.Component {
          constructor(props) {
            super(props);
            this.state = {
              loading: true,
              error: "",
              data: null,
              httpStatus: 0,
              refreshing: false,
              lastRefreshedAt: 0,
              versionChangedAt: 0,
              palette: paletteFor(true),
              showCandidates: false
            };
            this.refresh = this.refresh.bind(this);
            this.handleFocus = this.handleFocus.bind(this);
            this.handleVisibility = this.handleVisibility.bind(this);
            this.toggleCandidates = this.toggleCandidates.bind(this);
            this._mounted = false;
          }

          componentDidMount() {
            this._mounted = true;
            window.addEventListener("focus", this.handleFocus);
            document.addEventListener("visibilitychange", this.handleVisibility);
            this.refresh({ initial: true });
          }

          componentWillUnmount() {
            this._mounted = false;
            window.removeEventListener("focus", this.handleFocus);
            document.removeEventListener("visibilitychange", this.handleVisibility);
          }

          componentDidUpdate() {
            this.syncPalette();
          }

          syncPalette() {
            var next = detectPalette(this.rootElement);
            if (!this.state.palette || next.text !== this.state.palette.text) {
              this.setState({ palette: next });
            }
          }

          handleFocus() {
            if (!document.hidden) this.refresh({ silent: true, reason: "focus" });
          }

          handleVisibility() {
            if (!document.hidden) this.refresh({ silent: true, reason: "visible" });
          }

          toggleCandidates() {
            this.setState({ showCandidates: !this.state.showCandidates });
          }

          refresh(options) {
            var self = this;
            var silent = !!(options && options.silent);
            var previousVersion = this.state.data ? this.state.data.profileVersion : null;
            if (silent) this.setState({ refreshing: true });
            else this.setState({ loading: true, refreshing: true, error: "" });
            fetch("/style-memory/data?limit=60", { cache: "no-store" })
              .then(function (response) {
                if (!self._mounted) return null;
                self.setState({ httpStatus: response.status });
                if (!response.ok) throw new Error("HTTP " + response.status);
                return response.json();
              })
              .then(function (data) {
                if (!self._mounted || !data) return;
                var changed = previousVersion !== null && data.profileVersion !== previousVersion;
                self.setState({
                  loading: false,
                  refreshing: false,
                  error: "",
                  data: data,
                  lastRefreshedAt: Date.now(),
                  versionChangedAt: changed ? Date.now() : self.state.versionChangedAt
                });
              })
              .catch(function (error) {
                if (!self._mounted) return;
                self.setState({ loading: false, refreshing: false, error: String((error && error.message) || error) });
              });
          }

          render() {
            var self = this;
            var view = this.state;
            var styles = makeStyles(view.palette);
            var data = view.data;
            var stats = data && data.stats ? data.stats : {};
            var evidence = stats.evidence || {};
            var active = stats.activeRules || 0;
            var candidates = stats.candidateRules || 0;
            var statusText = view.loading ? "读取中…" : (view.error ? "读取失败" : (view.refreshing ? "刷新中…" : "已加载"));
            var refreshedText = view.lastRefreshedAt ? formatClock(view.lastRefreshedAt) : "—";
            var rules = data && Array.isArray(data.rules) ? data.rules : null;
            var history = data && Array.isArray(data.history) ? data.history : null;
            var activeRules = rules ? rules.filter(function (rule) { return rule.status === "active"; }) : [];
            var candidateRules = rules ? rules.filter(function (rule) { return rule.status !== "active"; }) : [];

            return el("div", {
              style: styles.root,
              "data-style-memory-panel": "1",
              ref: function (node) { self.rootElement = node; }
            },
              el("div", { style: styles.toolbar },
                el("h2", { style: styles.title }, PANEL_LABEL),
                el("button", {
                  style: styles.button,
                  onClick: function () { self.refresh(); },
                  disabled: view.refreshing
                }, view.refreshing ? "刷新中…" : "刷新")
              ),
              data ? el("div", { style: styles.row },
                chip("插件", data.pluginVersion, styles),
                chip("档案", "v" + data.profileVersion, styles),
                chip("状态", statusText, styles),
                chip("上次刷新", refreshedText, styles),
                view.versionChangedAt ? chip("已更新", formatClock(view.versionChangedAt), styles) : null
              ) : el("div", { style: styles.row }, chip("状态", statusText, styles)),
              data ? el("div", { style: styles.row },
                chip("规则", active + " 生效 / " + candidates + " 候选", styles),
                chip("证据", String(evidence.pairs || 0) + " 对 / " + String(evidence.edits || 0) + " 处改动", styles),
                chip("门禁", String((data.gate && data.gate.threshold) || 60) + " 分 · 最多 " + String((data.gate && data.gate.maxAttempts) || 3) + " 次", styles),
                chip("注入", data.enabled === false ? "已停用" : ((data.inject && data.inject.enabled === false) ? "卡已停用" : "开启"), styles)
              ) : null,
              view.error ? el("div", { style: styles.error }, "读取失败：" + view.error + "\n数据源：/style-memory/data" + (view.httpStatus ? "（HTTP " + view.httpStatus + "）" : "")) : null,
              !data && !view.error ? el("div", { style: styles.note }, view.loading ? "正在读取档案数据…" : "没有拿到档案数据，点「刷新」重试。") : null,
              el("div", { style: styles.note }, "打开面板、切回前台或点「刷新」时更新；不做后台轮询。"),
              data ? section("当前画像卡（注入新会话）", styles, data.cardText ? el("div", { style: styles.pre }, data.cardText) : null) : null,
              data ? section("学到的规则（生效）", styles,
                activeRules.length > 0
                  ? el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 } },
                      activeRules.map(function (rule) { return el(RuleItem, { key: rule.id || rule.text, rule: rule, styles: styles }); })
                    )
                  : el("div", { style: styles.note }, "还没有生效规则。")
              ) : null,
              data && candidateRules.length > 0 ? el("div", { style: styles.section },
                el("div", { style: styles.ruleHead },
                  el("div", { style: styles.label }, "待验证规则（" + candidateRules.length + " 条）"),
                  el("button", { style: styles.linkButton, onClick: this.toggleCandidates }, view.showCandidates ? "收起" : "展开")
                ),
                view.showCandidates
                  ? el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0, marginTop: "6px" } },
                      candidateRules.map(function (rule) { return el(RuleItem, { key: rule.id || rule.text, rule: rule, styles: styles }); })
                    )
                  : null
              ) : null,
              data ? section("最近学习记录", styles,
                history && history.length > 0
                  ? el("div", { style: { display: "flex", flexDirection: "column", minWidth: 0 } },
                      history.map(function (item) {
                        var meta = [];
                        if (item.genre) meta.push(item.genre);
                        if (item.edits) meta.push("改动 " + item.edits + " 处");
                        if (item.added) meta.push("新增 " + item.added + " 条");
                        if (item.note) meta.push(item.note);
                        return el("div", { style: styles.historyRow, key: item.name || item.at },
                          el("div", { style: styles.historyTitle }, (item.at || item.name || "").replace("T", " ").replace(/\..*$/, "")),
                          el("div", { style: styles.historyMeta }, (item.kind || "记录") + (meta.length > 0 ? " · " + meta.join(" · ") : ""))
                        );
                      })
                    )
                  : el("div", { style: styles.note }, "还没有学习记录。")
              ) : null,
              data ? el("div", { style: styles.dim }, "数据目录：" + (data.dataDir || "") + (data.updatedAt ? " · 档案更新于 " + data.updatedAt : "")) : null
            );
          }
        }

        class PanelBoundary extends react.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }
          componentDidCatch(error) {
            this.setState({ error: String((error && error.message) || error) });
          }
          render() {
            if (this.state.error) {
              return el("div", { style: { padding: "16px", color: "#ff7b72", fontSize: "12px", whiteSpace: "pre-wrap" } }, "风格记忆面板渲染失败：" + this.state.error);
            }
            return this.props.children;
          }
        }

        function apply(ctx) {
          try {
            ctx.slots.inject("conversation.view", function () {
              return ctx.slots.register(
                { name: "conversation.view", id: PANEL_ID, order: 27, label: function () { return PANEL_LABEL; } },
                function (props) { return el(PanelBoundary, null, el(StyleMemoryPanel, props)); }
              );
            });
          } catch (error) {
            try { console.warn("[dsh-style-memory] view slot unavailable:", error && error.message); } catch (inner) {}
          }
        }

        exports.name = PLUGIN_ID;
        exports.inject = inject;
        exports.apply = apply;
        exports.__test = { StyleMemoryPanel: StyleMemoryPanel };
        return module.exports;
      }
    });
  } catch (error) {
    try { console.warn("[dsh-style-memory] client bootstrap error:", error); } catch (inner) {}
  }
})();
