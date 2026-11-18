// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list } from "gpui-base";
import { HIGHLIGHT, SYNTAX, freshState, lexLine } from "./syntax.js";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, setShared } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
// GitHub's syntax colours (Primer "prettylights"), dark or light with the app's appearance.
const GITHUB = {
  dark: {
    syntax: { keyword: "#ff7b72", operator: "#ff7b72", string: "#a5d6ff", "string.escape": "#79c0ff", comment: "#8b949e",
      function: "#d2a8ff", type: "#ffa657", number: "#79c0ff", constant: "#79c0ff", boolean: "#79c0ff",
      variable: "#e6edf3", punctuation: "#e6edf3" },
    add: "#3fb950", del: "#f85149", mod: "#d29922",
  },
  light: {
    syntax: { keyword: "#cf222e", operator: "#cf222e", string: "#0a3069", "string.escape": "#0550ae", comment: "#59636e",
      function: "#8250df", type: "#953800", number: "#0550ae", constant: "#0550ae", boolean: "#0550ae",
      variable: "#1f2328", punctuation: "#1f2328" },
    add: "#1a7f37", del: "#d1242f", mod: "#9a6700",
  },
};
const gh = () => (settings().dark === false ? GITHUB.light : GITHUB.dark);
// WebStorm's VCS file-status colours (Darcula / IntelliJ Light). Keys: M modified, A added, ? untracked,
// I ignored, U conflict, C a folder containing changes (WebStorm's "highlight directories" option).
const VCS = {
  dark: { M: "#6897bb", C: "#6897bb", A: "#629755", "?": "#d1675a", I: "#848504", U: "#e05555", D: "#6c6c6c" },
  light: { M: "#0032a0", C: "#0032a0", A: "#067d17", "?": "#993300", I: "#8c8c00", U: "#d50000", D: "#6c6c6c" },
};
const CHANGED = new Set(["M", "A", "?", "D", "U"]);
const vcs = () => (settings().dark === false ? VCS.light : VCS.dark);
const statusOf = (xy) => xy === "??" ? "?" : xy === "!!" ? "I"
  : xy.includes("U") || xy === "AA" || xy === "DD" ? "U" : xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// A file as highlighted lines, lexed once when it opens (state flows from line to line).
function codeLines(text) {
  const st = freshState();
  const lines = (text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text).replace(/\n$/, "").split("\n").map((raw) => {
    const line = untab(raw.replace(/\r$/, "")) || " ";
    return { text: line, tokens: lexLine(line, st) };
  });
  lines.width = lines.reduce((w, l) => Math.max(w, Math.min(l.text.length, 4000) * 7.3 + 80), 300);
  return lines;
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Git repositories up to 3 levels below a folder that isn't in one (skipping node_modules and hidden folders).
async function findRepos(base, on) {
  const r = await exec("find", [base, "-mindepth", "1", "-maxdepth", "3",
    "(", "-name", ".git", "-print", "-prune", ")", "-o",
    "(", "-name", "node_modules", "-o", "-name", "Library", "-o", "-name", ".*", ")", "-prune"], { on, timeout: 15000 }).catch(() => null);
  return (r?.stdout ?? "").split("\n").filter(Boolean).map((p) => p.slice(0, -"/.git".length)).sort().slice(0, 20);
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {}, changed = new Set();
        let rootStatus = null;
        const own = top?.code === 0 ? top.stdout.trim() : null;
        // Outside a repository (a folder of projects), colour the repositories below it, as the Changes panel finds them.
        if (!own && (this.repos?.cwd !== cwd || Date.now() - this.repos.at > 60000))
          this.repos = { cwd, at: Date.now(), roots: await findRepos(cwd, on) };
        const roots = own ? [own] : this.repos.roots, limit = own ?? cwd;
        for (const base of roots) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          // Untracked/ignored folders come back as one "dir/" entry; their contents inherit it in rows().
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal", "--ignored=matching"], { cwd: base, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const s = statusOf(entry.slice(0, 2)), abs = `${base}/${entry.slice(3).replace(/\/$/, "")}`;
            marks[abs] = s;
            if (s === "I") continue;
            // Folders above a change are tinted, like WebStorm's "highlight directories that contain modified files".
            for (let dir = abs.slice(0, abs.lastIndexOf("/")); dir.length > limit.length; dir = dir.slice(0, dir.lastIndexOf("/"))) {
              if (changed.has(dir)) break;
              changed.add(dir);
            }
          }
        }
        // The shown folder may itself sit inside an untracked or ignored one.
        if (own) for (let dir = cwd; dir.length > own.length && !rootStatus; dir = dir.slice(0, dir.lastIndexOf("/")))
          if (marks[dir] === "?" || marks[dir] === "I") rootStatus = marks[dir];
        if (!this.current(context)) return;
        this.marks = marks; this.changed = changed; this.rootStatus = rootStatus; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.lines = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        // Herdr's viewer has no TypeScript or JSX grammar: these get the panel's own highlighter.
        if (HIGHLIGHT.test(path)) { this.lines = codeLines(text); return; }
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: gh().syntax });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // A changed file opens as its diff in the Changes section rather than as a preview here.
  reveal(abs) {
    setShared("changes.reveal", { path: abs, at: Date.now() });
    run("layout.show", { id: "changes" });
    run("layout.show", { id: "panel" });
  }

  // inherited: "?" or "I" when an enclosing folder is untracked or ignored (git reports only the folder).
  rows(prefix, depth, out, t, inherited = this.rootStatus) {
    if (out.length >= TOTAL || depth > 40) return out;
    // Ignored files are muted (the theme's dim text) rather than WebStorm's olive, so they don't read as a change.
    const colors = { ...vcs(), I: t.dim };
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), abs = `${this.root}/${path}`;
      const status = inherited ?? this.marks[abs] ?? (entry.dir && this.changed?.has(abs) ? "C" : null);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : CHANGED.has(status) ? this.reveal(abs) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/my-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/my-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().when(Boolean(status), el => el.text_color(colors[status])).child(entry.name)));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, status === "?" || status === "I" ? status : null);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.lines ? this.codeView(t)
        : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }

  // A highlighted, read-only listing: line numbers and GitHub-coloured tokens, drawing only the rows on screen.
  codeView(t) {
    const syntax = settings().dark === false ? SYNTAX.light : SYNTAX.dark, lines = this.lines;
    const digits = String(lines.length).length;
    return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .child(div().id("files-code-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(lines.width).h_full().child(v_virtual_list("files-code", lines.length, 19, (i) => String(i),
          (range) => lines.slice(range.start, range.end).map((line, i) => h_flex().w_full().h(19).flex_none().gap(14)
            .child(div().w(digits * 8 + 12).flex_none().text_right().text_color(t.dim).child(String(range.start + i + 1)))
            .child(line.tokens
              ? h_flex().flex_1().min_w(0).overflow_hidden().children(line.tokens.map(([s, k]) => div().flex_none().whitespace_nowrap().text_color(syntax[k]).child(s)))
              : div().flex_1().min_w(0).truncate().text_color(syntax.text).child(line.text)))).size_full())))
      .child(Scrollbar.vertical("files-code").viewport_from_layout().absolute().inset_0());
  }
}
