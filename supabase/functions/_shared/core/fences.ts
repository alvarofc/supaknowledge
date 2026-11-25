// Fenced code blocks (CommonMark §4.5), line by line. A fence opens on a line starting with 3+ backticks or tildes
// (a backtick fence's info string may not contain a backtick) and closes on a line of the SAME character, at least
// as long as the opener, followed only by whitespace; an unclosed fence runs to the end of the document. Leading
// indentation is not limited to 3 spaces, so fences inside list items are recognised too.

const OPEN_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;

/** For each line: is it part of a fenced code block (fence lines included)? */
export function fencedLines(lines: readonly string[]): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false);
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      out[i] = true;
      const m = CLOSE_RE.exec(line);
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len) fence = null;
      continue;
    }
    const m = OPEN_RE.exec(line);
    if (m && !(m[1]![0] === "`" && m[2]!.includes("`"))) {
      fence = { ch: m[1]![0]!, len: m[1]!.length };
      out[i] = true;
    }
  }
  return out;
}
