import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, home, readTextFile, exec, checking, focused, watchFolder } from "herdr";

// Primary source: the usage endpoint claude.ai and Claude Code use, called
// with Claude Code's own login token from the macOS keychain. It is
// undocumented, so it may change. The token is never refreshed here (that
// could sign Claude Code out); when it has expired, or the call fails, the
// bar falls back to the file ~/.claude/statusline-usage.sh writes from
// Claude Code's status line: { rate_limits: { five_hour, seven_day }, captured_at }.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_FILE = "/.claude/usage-cache.json";
const API_EVERY = 2 * 60 * 1000;
const API_BACKOFF = 5 * 60 * 1000;

// Context window per herdr terminal, written by ~/.claude/statusline-usage.sh
// (Claude Code's status line) to ~/.claude/herdr-context/<terminal>.json:
// { context_window: { used_percentage, context_window_size, current_usage }, session_id, captured_at }.
const CTX_DIR = "/.claude/herdr-context";
const isClaude = (a) => a.program?.key === "claude" || a.app === "claude-code";

// Local Claude agents only: a remote agent's file would be on its machine.
async function readContexts(list) {
  const out = {};
  for (const a of list) {
    if (a.address.includes("/") || !isClaude(a)) continue;
    try {
      const text = await readTextFile(`${home()}${CTX_DIR}/${a.address}.json`);
      const cw = text ? JSON.parse(text).context_window : null;
      if (cw && cw.used_percentage != null) out[a.address] = cw;
    } catch {}
  }
  return out;
}

const kTokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
function ctxTip(cw) {
  const u = cw.current_usage ?? {};
  const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return `Context: ${used ? kTokens(used) : `${Math.round(cw.used_percentage)}%`} of ${kTokens(cw.context_window_size ?? 0)} tokens`;
}
// A bar's fill: its own colour, amber from `warn`%, red from `crit`%. The text stays muted.
const fillColor = (t, base, pct, [warn, crit]) => (pct >= crit ? t.blocked : pct >= warn ? t.working : base);
// Context gets worse well before it's full; a limit only bites near 100%.
const CTX_AT = [60, 85];
const LIMIT_AT = [75, 90];

// resets_at may be epoch seconds, epoch ms or an ISO string.
function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function left(ms) {
  if (ms == null) return "?";
  const s = Math.floor((ms - Date.now()) / 1000);
  if (s <= 0) return "reset";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.usage = null;
    this.usageAt = 0; // ms: when this.usage was measured
    this.nextApi = 0;
    this.ctx = {};
    if (checking()) return;
    this.load(cx);
    this.watchCtx(cx);
    // Also redraws the countdowns.
    cx.timer.every(30000, (cx) => this.load(cx));
  }

  load(cx) {
    cx.spawn(async (cx) => {
      if (Date.now() >= this.nextApi) {
        const fresh = await this.fromApi();
        this.nextApi = Date.now() + (fresh ? API_EVERY : API_BACKOFF);
        if (fresh) { this.usage = fresh; this.usageAt = Date.now(); }
      }
      this.ctx = await readContexts(agents());
      const cached = await this.fromFile();
      if (cached && cached.at > this.usageAt) { this.usage = cached.usage; this.usageAt = cached.at; }
      cx.notify();
    });
  }

  // Claude Code rewrites a context file after every message: follow it live.
  watchCtx(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        this.ctx = await readContexts(agents());
        cx.notify();
        // No folder yet (no Claude session since setup): the 30s timer covers it.
        try { await watchFolder(home() + CTX_DIR); } catch { return; }
      }
    });
  }

  ctxBar(t, cw) {
    const pct = Math.round(cw.used_percentage);
    return h_flex().id("usage-ctx").gap(5).items_center().tooltip(ctxTip(cw))
      .child(div().text_color(t.dim).child("ctx"))
      .child(div().w(34).h(5).rounded(3).bg(t.border)
        .child(div().h_full().w(Math.max(0, Math.min(34, (34 * pct) / 100))).rounded(3).bg(fillColor(t, t.accent, pct, CTX_AT))))
      .child(div().child(`${pct}%`));
  }

  async fromApi() {
    try {
      const r = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 10000 });
      if (r.code !== 0) return null;
      const oauth = JSON.parse(r.stdout).claudeAiOauth;
      if (!oauth?.accessToken || (oauth.expiresAt && oauth.expiresAt <= Date.now())) return null;
      const res = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      });
      if (!res.ok) return null;
      const body = await res.json();
      return body?.five_hour || body?.seven_day ? body : null;
    } catch {
      return null;
    }
  }

  async fromFile() {
    try {
      const text = await readTextFile(home() + USAGE_FILE);
      const data = text ? JSON.parse(text) : null;
      return data?.rate_limits ? { usage: data.rate_limits, at: (data.captured_at ?? 0) * 1000 } : null;
    } catch {
      return null;
    }
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  limit(t, id, name, l) {
    const resets = toMs(l?.resets_at);
    const expired = resets != null && resets <= Date.now();
    const pct = expired ? 0 : Math.round(l?.used_percentage ?? l?.utilization ?? 0);
    return h_flex().id(id).gap(5).items_center()
      .child(div().text_color(t.dim).child(name))
      .child(div().w(34).h(5).rounded(3).bg(t.border)
        .child(div().h_full().w(Math.max(0, Math.min(34, (34 * pct) / 100))).rounded(3).bg(fillColor(t, t.accent, pct, LIMIT_AT))))
      .child(div().child(`${pct}%`))
      .child(div().text_color(t.dim).child(expired ? "reset" : left(resets)));
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const u = this.usage;
    const cw = this.ctx[focused()?.terminal ?? ""];
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(Boolean(u?.five_hour), el => el.child(this.limit(t, "usage-5h", "5h", u.five_hour)))
      .when(Boolean(u?.seven_day), el => el.child(this.limit(t, "usage-wk", "w", u.seven_day)))
      .when(!u, el => el.child(div().text_color(t.dim).child("Claude usage: waiting for Claude Code")))
      .when(Boolean(cw), el => el.child(this.ctxBar(t, cw)))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
