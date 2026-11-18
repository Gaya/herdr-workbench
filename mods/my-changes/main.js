// Herdr's Changes panel, extended to repositories in subfolders: the focused
// terminal's repository (or, outside one, its folder) and every repository up
// to 3 folders below it, each in its own section. Committing goes to the
// repository of the selected file.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, shared } from "herdr";
import { HIGHLIGHT, SYNTAX, freshState, lexLine } from "./syntax.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// GitHub's diff colours (Primer), dark or light with the app's appearance.
const GITHUB = {
  dark: {
    addLine: "#2ea04326", addNum: "#3fb9504d", delLine: "#f851491a", delNum: "#f851494d",
    hunkLine: "#388bfd1a", hunkText: "#8b949e", num: "#6e7681",
    addText: "#3fb950", delText: "#f85149", modText: "#d29922",
  },
  light: {
    addLine: "#e6ffec", addNum: "#ccffd8", delLine: "#ffebe9", delNum: "#ffd7d5",
    hunkLine: "#ddf4ff", hunkText: "#59636e", num: "#59636e",
    addText: "#1a7f37", delText: "#d1242f", modText: "#9a6700",
  },
};
const gh = () => (settings().dark === false ? GITHUB.light : GITHUB.dark);
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// How deep to look for repositories, how many to show, and how often to look again
// (a refresh otherwise reuses the last search: new clones show up within a minute).
const DEPTH = 4; // .git entries up to 4 levels below: repositories up to 3 folders down
const MAX_REPOS = 20;
const FIND_EVERY = 60000;
const MAX_FILES = 1000;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers and highlights each diff line once, so a frame only draws the rows on screen.
// The old and new sides are lexed separately (a comment may open on one side only);
// unchanged lines belong to both.
function diffRows(lines, path) {
  let old = 0, next = 0;
  const highlight = HIGHLIGHT.test(path ?? "");
  let before = freshState(), after = freshState();
  const lex = (text, kind) => {
    if (!highlight) return null;
    if (kind === "-") return lexLine(text, before);
    const tokens = lexLine(text, after);
    if (kind === " ") before = { ...after };
    return tokens;
  };
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; before = freshState(); after = freshState(); return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind !== "-" && kind !== "+" && kind !== " ") return { kind: "", text: line };
    const text = untab(line.slice(1)) || " ";
    const number = kind === "-" ? old++ : next++;
    if (kind === " ") old++;
    return { kind, number, text, tokens: lex(text, kind) };
  });
}

const basename = (p) => p.replace(/\/+$/, "").split("/").pop() || p;

// Repositories at `base` (when it's in one) and below it. Skips hidden folders,
// node_modules and Library: big, and never where someone's own work lives.
async function findRepos(base, own, on) {
  const r = await exec("find", [base, "-mindepth", "1", "-maxdepth", String(DEPTH),
    "(", "-name", ".git", "-print", "-prune", ")", "-o",
    "(", "-name", "node_modules", "-o", "-name", "Library", "-o", "-name", ".*", ")", "-prune"], { on, timeout: 15000 });
  // Unreadable folders make find exit nonzero; what it did print still counts.
  const found = r.stdout.split("\n").filter(Boolean).map((p) => p.slice(0, -"/.git".length)).sort();
  const roots = [...new Set([...(own ? [own] : []), ...found])];
  return { roots: roots.slice(0, MAX_REPOS), more: Math.max(0, roots.length - MAX_REPOS) };
}

// One repository's uncommitted files.
async function scan(root, on) {
  const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  if (status.code !== 0) throw new Error(status.stderr);
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  const stats = {};
  const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
  for (const result of results) {
    if (result.code !== 0) throw new Error(result.stderr);
    for (const entry of result.stdout.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
      stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
    }
  }
  const files = [];
  const entries = status.stdout.split("\0").filter(Boolean);
  for (const entry of entries.slice(0, MAX_FILES)) {
    const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
    const stat = stats[path] ?? { add: 0, del: 0 };
    files.push({ path, status: s, fresh, ...stat });
  }
  return { hasHead: head.code === 0, files, limited: entries.length > MAX_FILES };
}

export default class Changes extends View {
  init(_props, cx) {
    this.repos = []; this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.watches = new Map(); this.listScroll = ScrollHandle.new();
    this.revealed = shared("changes.reveal")?.at ?? null;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // One folder watch per repository shown; watches of repositories gone are cancelled.
  watchAll(roots, cx) {
    for (const [root, w] of this.watches) if (this.on || !roots.includes(root)) { this.watches.delete(root); w.handle?.cancel(); }
    if (this.on) return;
    for (const root of roots) {
      if (this.watches.has(root)) continue;
      const w = { handle: null };
      this.watches.set(root, w);
      cx.spawn(async (cx) => {
        try {
          while (this.watches.get(root) === w) {
            w.handle = watchFolder(root);
            await w.handle;
            if (this.watches.get(root) === w) this.refresh(cx);
          }
        } catch { if (this.watches.get(root) === w) this.watches.delete(root); }
      });
    }
  }

  stopWatches() {
    for (const w of this.watches.values()) w.handle?.cancel();
    this.watches.clear();
  }

  async close() { this.stopWatches(); }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.repos = []; this.files = []; this.open = null; this.found = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.closed = false;
      this.stopWatches();
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        const own = top.code === 0 ? top.stdout.trim() : null, base = own ?? cwd;
        if (!this.found || this.found.base !== base || Date.now() - this.found.at > FIND_EVERY) {
          this.found = { base, at: Date.now(), ...(await findRepos(base, own, on)) };
          if (key() !== context) return;
        }
        const repos = [];
        for (const root of this.found.roots) {
          try {
            const r = await scan(root, on);
            const name = root === base ? basename(root) : root.slice(base.length).replace(/^\/+/, "");
            repos.push({ root, name, ...r, files: r.files.map((f) => ({ ...f, repo: root, id: `${name}::${f.path}` })) });
          } catch { /* one broken repository doesn't hide the others */ }
        }
        if (key() !== context) return;
        this.base = base; this.on = on; this.repos = repos; this.files = repos.flatMap((r) => r.files);
        this.error = repos.length ? null : `No git repository in ${basename(base)} or its subfolders`;
        this.watchAll(repos.map((r) => r.root), cx);
        if (this.open && !this.files.some((f) => f.id === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && this.files.length) this.open = this.files[0].id;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(id, context) {
    const file = this.files.find((f) => f.id === id), on = this.on;
    const repo = this.repos.find((r) => r.root === file?.repo);
    if (!file || !repo) return;
    const { root, hasHead } = repo, path = file.path;
    let lines;
    if (file.fresh || (!hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === id) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line), path);
  }

  setLines(lines, path) {
    this.rows = diffRows(lines, path);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(id, cx) {
    this.open = this.open === id ? null : id; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(id, context); }
      catch (e) { if (key() === context && this.open === id) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // The Files panel asks for a file's diff through shared("changes.reveal"). A file missing from the
  // list (changed since the last scan) triggers one rescan, and is picked when that lands.
  reveal(cx) {
    const ask = shared("changes.reveal");
    if (!ask?.path || ask.at === this.revealed || Date.now() - ask.at > 5000) return;
    const file = this.files.find((f) => `${f.repo}/${f.path}` === ask.path);
    if (!file) { if (this.rescanned !== ask.at) { this.rescanned = ask.at; this.found = null; this.refresh(cx); } return; }
    this.revealed = ask.at;
    if (this.open !== file.id) this.pick(file.id, cx);
    const sections = this.repos.length > 1;
    const order = sections ? this.repos.filter((r) => r.files.length).flatMap((r) => [null, ...r.files]) : this.files;
    const index = order.indexOf(file);
    if (index >= 0) this.listScroll.scroll_to_item(index);
  }

  // Where a commit goes: the selected file's repository, else the only one with changes.
  target() {
    const file = this.files.find((f) => f.id === this.open);
    if (file) return this.repos.find((r) => r.root === file.repo) ?? null;
    const changed = this.repos.filter((r) => r.files.length);
    return changed.length === 1 ? changed[0] : null;
  }

  commit(cx) {
    const repo = this.target();
    if (!this.message.trim() || !repo || this.busy || this.loading || this.context !== key()) return;
    const root = repo.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text, tokens }, t) {
    const g = gh(), syntax = settings().dark === false ? SYNTAX.light : SYNTAX.dark;
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(g.hunkLine).text_color(g.hunkText).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(g.addLine)).when(kind === "-", (e) => e.bg(g.delLine))
      .child(div().w(40).h_full().pr(6).flex_none().flex().items_center().justify_end().text_color(g.num)
        .when(kind === "+", (e) => e.bg(g.addNum)).when(kind === "-", (e) => e.bg(g.delNum))
        .child(number === undefined ? "" : String(number)))
      .child(tokens
        ? h_flex().flex_1().min_w(0).overflow_hidden().children(tokens.map(([s, k]) => div().flex_none().whitespace_nowrap().text_color(syntax[k]).child(s)))
        : div().flex_1().min_w(0).truncate().child(text));
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().id(`change-${f.id}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.id, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.id, cx))
      .child(div().w(14).text_size(11).text_color(f.status === "A" ? gh().addText : f.status === "D" || f.status === "U" ? gh().delText : gh().modText).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(gh().addText).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(gh().delText).child(`−${f.del}`)));
  }

  // A repository's section header, when there's more than one.
  repoRow(r, t) {
    const add = r.files.reduce((n, f) => n + f.add, 0), del = r.files.reduce((n, f) => n + f.del, 0);
    return h_flex().id(`repo-${r.root}`).h(26).flex_none().px(8).pt(4).gap(6).items_center().text_size(11.5)
      .child(div().font_semibold().text_color(t.muted).truncate().child(r.name))
      .child(div().text_color(t.dim).child(String(r.files.length)))
      .child(div().flex_1())
      .when(add > 0, (e) => e.child(div().text_size(11).text_color(gh().addText).child(`+${add}`)))
      .when(del > 0, (e) => e.child(div().text_size(11).text_color(gh().delText).child(`−${del}`)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    this.reveal(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const changed = this.repos.filter((r) => r.files.length);
    const sections = this.repos.length > 1;
    const target = this.target();
    const enabled = Boolean(this.message.trim() && target && !this.busy && !this.loading);
    const clean = this.repos.length - changed.length;
    const rows = sections ? changed.flatMap((r) => [this.repoRow(r, t), ...r.files.map((f) => this.fileRow(f, t))]) : this.files.map((f) => this.fileRow(f, t));
    const limited = this.repos.some((r) => r.limited);
    const empty = this.error || (this.loading && !this.repos.length ? "Loading changes…" : this.repos.length ? (sections ? `No uncommitted changes in ${this.repos.length} repositories` : "No uncommitted changes") : "No folder");
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .when(sections, (e) => e.child(div().text_size(10).text_color(t.dim).child(`${changed.length}/${this.repos.length} repos`)))
        .child(div().flex_1()).child(div().text_size(11).text_color(gh().addText).child(`+${add}`)).child(div().text_size(11).text_color(gh().delText).child(`−${del}`)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(this.files.length * 28 + (sections ? changed.length * 26 : 0) + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().track_scroll(this.listScroll).p(6).children(rows)
          .when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(limited || this.found?.more > 0 || (sections && clean > 0 && this.files.length > 0), el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child([
        sections && clean > 0 && this.files.length > 0 ? `${clean} more ${clean === 1 ? "repository" : "repositories"} without changes` : null,
        limited ? `the first ${MAX_FILES.toLocaleString()} changed files per repository` : null,
        this.found?.more > 0 ? `${this.found.more} more repositories not shown` : null,
      ].filter(Boolean).join(" · "))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      // With several repositories, say where a commit goes (or that a file must be picked first).
      .when(sections && changed.length > 0, (e) => e.child(div().px(12).pt(8).text_size(11).text_color(t.dim).truncate()
        .child(target ? `Commits all changes in ${target.name}` : "Select a file to choose which repository to commit")))
      .child(h_flex().flex_none().p(10).gap(8).when(!(sections && changed.length > 0), (e) => e.border_t(1).border_color(t.border))
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
