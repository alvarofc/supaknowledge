// Code in Markdown: fenced code blocks (CommonMark §4.5) and code spans (§6.1).
//
// Fences are found line by line, with the containers that matter for them: block quotes ("> ", nested) and list
// items. A fence opens on 3+ backticks or tildes indented at most 3 columns relative to its container (a backtick
// fence's info string may not contain a backtick); four columns is indented code, not a fence. It closes on a
// line of the SAME character, at least as long as the opener, followed only by whitespace, or when its container
// ends (a line without the quote marker, or a non-blank line indented less than the list item's content). An
// unclosed fence runs to the end of its container (the document, at top level).

const QUOTE_RE = /^ {0,3}> ?/;
const LIST_RE = /^([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const OPEN_RE = /^(`{3,}|~{3,})(.*)$/;
const CLOSE_RE = /^(`{3,}|~{3,})[ \t]*$/;

/** Strip up to `max` block-quote markers; how many were stripped and what is left. */
function stripQuotes(line: string, max = Infinity): { depth: number; text: string } {
  let depth = 0;
  let text = line;
  while (depth < max) {
    const m = QUOTE_RE.exec(text);
    if (!m) break;
    text = text.slice(m[0].length);
    depth++;
  }
  return { depth, text };
}

/** Leading whitespace of `text` starting at column `col` (tabs stop every 4 columns): the column it ends at + the rest. */
function measure(text: string, col = 0): { cols: number; rest: string } {
  let i = 0;
  for (; i < text.length; i++) {
    if (text[i] === " ") col++;
    else if (text[i] === "\t") col += 4 - (col % 4);
    else break;
  }
  return { cols: col, rest: text.slice(i) };
}

/** For each line: is it part of a fenced code block (fence lines included)? */
export function fencedLines(lines: readonly string[]): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false);
  let fence: { ch: string; len: number; depth: number; base: number } | null = null;
  let lists: number[] = []; // content columns of the open list items (innermost last)
  let quoteDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      const q = stripQuotes(line, fence.depth);
      const { cols, rest } = measure(q.text);
      const ended = q.depth < fence.depth || (rest !== "" && cols < fence.base);
      if (!ended) {
        out[i] = true;
        const m = CLOSE_RE.exec(rest);
        if (m && cols - fence.base <= 3 && m[1]![0] === fence.ch && m[1]!.length >= fence.len) fence = null;
        continue;
      }
      fence = null; // its container ended: this line is outside the block
    }
    const q = stripQuotes(line);
    if (q.depth !== quoteDepth) {
      lists = [];
      quoteDepth = q.depth;
    }
    let { cols, rest } = measure(q.text);
    if (rest === "") continue;
    while (lists.length && cols < lists[lists.length - 1]!) lists.pop();
    let base = lists[lists.length - 1] ?? 0;
    // list markers (possibly several on one line, "- 1. ```"); a fence may follow on the same line
    for (let guard = 0; guard < 16 && cols - base <= 3; guard++) {
      const lm = LIST_RE.exec(rest);
      if (!lm) break;
      const markerEnd = cols + lm[1]!.length;
      if (!lm[3]) {
        lists.push(markerEnd + 1); // empty item (or only spaces after the marker)
        rest = "";
        break;
      }
      const after = measure(lm[2]! + lm[3], markerEnd);
      if (after.cols - markerEnd > 4) {
        lists.push(markerEnd + 1); // the item starts with indented code
        rest = "";
        break;
      }
      lists.push(after.cols);
      base = after.cols;
      cols = after.cols;
      rest = after.rest;
    }
    if (!rest || cols - base > 3) continue;
    const m = OPEN_RE.exec(rest);
    if (m && !(m[1]![0] === "`" && m[2]!.includes("`"))) {
      fence = { ch: m[1]![0]!, len: m[1]!.length, depth: q.depth, base };
      out[i] = true;
    }
  }
  return out;
}

/**
 * Remove code spans: a run of N backticks up to the next run of exactly N backticks, within one paragraph (a span
 * may cross single line breaks, not a blank line). An unmatched run is literal text. Each span becomes one space,
 * so text on both sides never joins into new syntax.
 */
export function stripCodeSpans(text: string): string {
  return text
    .split(/(\n[ \t]*\n)/)
    .map((block) => {
      let out = "";
      let i = 0;
      const open = /`+/g;
      const unmatched = new Set<number>(); // run lengths with no later run of that length: never search again
      while (i < block.length) {
        open.lastIndex = i;
        const m = open.exec(block);
        if (!m) {
          out += block.slice(i);
          break;
        }
        const n = m[0].length;
        const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, "g");
        close.lastIndex = m.index + n;
        const c = unmatched.has(n) ? null : close.exec(block);
        if (!c) {
          unmatched.add(n);
          out += block.slice(i, m.index + n);
          i = m.index + n;
          continue;
        }
        out += block.slice(i, m.index) + " ";
        i = c.index + n;
      }
      return out;
    })
    .join("");
}
