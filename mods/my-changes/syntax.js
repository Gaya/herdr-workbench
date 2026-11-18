// A small TypeScript / JavaScript / JSX highlighter for diff lines, coloured like
// GitHub (Primer "prettylights"). Line by line, with state carried between lines
// for block comments, template strings and open JSX tags. A heuristic, not a
// parser: regex literals and `${}` inside template strings aren't recognised.

export const HIGHLIGHT = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i;

// Longer lines (minified code) stay plain: lexing them costs more than they show.
const MAX_LINE = 1000;

export const SYNTAX = {
  dark: {
    keyword: "#ff7b72", string: "#a5d6ff", comment: "#8b949e", constant: "#79c0ff", func: "#d2a8ff",
    tag: "#7ee787", type: "#ffa657", attr: "#79c0ff", text: "#e6edf3",
  },
  light: {
    keyword: "#cf222e", string: "#0a3069", comment: "#59636e", constant: "#0550ae", func: "#8250df",
    tag: "#116329", type: "#953800", attr: "#0550ae", text: "#1f2328",
  },
};

const KEYWORDS = new Set(`abstract as asserts async await break case catch class const continue debugger
  declare default delete do else enum export extends finally for from function get if implements import in
  infer instanceof interface is keyof let namespace new of override private protected public readonly return
  satisfies set static super switch this throw try type typeof unique var void while with yield`.split(/\s+/));
const CONSTANTS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity",
  // Primitive types: GitHub colours them like constants.
  "string", "number", "boolean", "bigint", "symbol", "object", "any", "unknown", "never"]);
// What may stand before a `<` that opens a JSX tag (a generic follows a name instead).
const JSX_BEFORE = /(?:^|[(=?:,{}[&|>;!]|\breturn|\byield|=>)\s*$/;
const NUMBER = /^(?:0[xXbBoO][\da-fA-F_]+n?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?|\.\d[\d_]*)/;
const OPERATOR = /^(?:=>|===|!==|==|!=|<=|>=|&&=?|\|\|=?|\?\?=?|\.\.\.|\*\*|[-+*/%]=?|[=<>!?:&|^~])/;

export const freshState = () => ({ block: false, tpl: false, tag: false, depth: 0 });

// One line as [text, kind] runs; `st` comes from the line before and is updated.
export function lexLine(line, st) {
  if (line.length > MAX_LINE) return null;
  const out = [];
  const push = (text, kind) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last[1] === kind) last[0] += text;
    else out.push([text, kind]);
  };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i), c = line[i];
    let m;
    if (st.block) {
      const end = rest.indexOf("*/");
      if (end < 0) { push(rest, "comment"); break; }
      push(rest.slice(0, end + 2), "comment"); i += end + 2; st.block = false; continue;
    }
    if (st.tpl) {
      m = /^((?:[^`\\]|\\.)*)(`?)/.exec(rest);
      if (!m[0]) { push(rest, "string"); break; }
      push(m[0], "string"); i += m[0].length; if (m[2]) st.tpl = false; continue;
    }
    if (rest.startsWith("//")) { push(rest, "comment"); break; }
    if (rest.startsWith("/*")) { push("/*", "comment"); i += 2; st.block = true; continue; }
    if (c === "`") { push("`", "string"); i++; st.tpl = true; continue; }
    if (c === '"' || c === "'") {
      m = new RegExp(`^${c}(?:[^${c}\\\\]|\\\\.)*${c}?`).exec(rest);
      push(m[0], "string"); i += m[0].length; continue;
    }
    // Inside a JSX tag: braces hold an expression, `>` / `/>` outside them end the tag.
    if (st.tag && st.depth === 0 && (rest.startsWith("/>") || c === ">")) {
      const end = c === ">" ? ">" : "/>";
      push(end, "text"); i += end.length; st.tag = false; continue;
    }
    if (c === "<") {
      m = /^<(\/?)([A-Za-z][\w.:-]*)?/.exec(rest);
      const closing = m[1] === "/", name = m[2];
      if (closing || (JSX_BEFORE.test(line.slice(0, i)) && (name || rest[1] === ">"))) {
        push(closing ? "</" : "<", "text"); i += closing ? 2 : 1;
        if (name) { push(name, "tag"); i += name.length; st.tag = true; st.depth = 0; }
        continue;
      }
    }
    if (/[\d.]/.test(c) && !/[\w$]/.test(line[i - 1] ?? "") && (m = NUMBER.exec(rest))) {
      push(m[0], "constant"); i += m[0].length; continue;
    }
    if ((m = (st.tag && st.depth === 0 ? /^[A-Za-z_$][\w$-]*/ : /^[A-Za-z_$][\w$]*/).exec(rest))) {
      const w = m[0], after = rest.slice(w.length);
      const member = line[i - 1] === "." && line[i - 2] !== ".", call = /^\s*(?:<[\w$.,\s[\]|&<>]*>)?\s*\(/.test(after);
      let kind = "text";
      if (st.tag && st.depth === 0) kind = "attr";
      // obj.type, obj.Name: a property, whatever its name; obj.run(): a method.
      else if (member) kind = call ? "func" : "text";
      // An object key ("Vehicle: …"); "a ? B : c" has a space before its colon.
      else if (/^:(?!:)/.test(after)) kind = "text";
      else if (/^[A-Z][A-Z\d_]+$/.test(w)) kind = "constant";
      else if (CONSTANTS.has(w)) kind = "constant";
      else if (KEYWORDS.has(w)) kind = "keyword";
      else if (call || /^\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/.test(after)) kind = "func";
      else if (/^[A-Z]/.test(w)) kind = "type";
      push(w, kind); i += w.length; continue;
    }
    if (st.tag && c === "{") { st.depth++; push(c, "text"); i++; continue; }
    if (st.tag && c === "}") { st.depth = Math.max(0, st.depth - 1); push(c, "text"); i++; continue; }
    if ((m = OPERATOR.exec(rest))) { push(m[0], "keyword"); i += m[0].length; continue; }
    push(c, "text"); i++;
  }
  return out;
}
