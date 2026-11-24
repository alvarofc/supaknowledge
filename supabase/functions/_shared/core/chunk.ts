// Heading-aware markdown chunking for retrieval. gte-small has a 512-token window, so chunks are kept
// around ~1,200 characters with a small overlap, and every chunk carries its heading trail for context.

export interface Chunk {
  ord: number;
  heading: string | null;
  content: string;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
  /** prepended to every chunk (e.g. concept title + description) */
  preamble?: string;
}

interface Section {
  trail: string[];
  text: string;
}

function splitSections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  const trail: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ trail: [...trail], text });
    buf = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence ? /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      flush();
      const level = h[1]!.length;
      trail.length = Math.min(trail.length, level - 1);
      while (trail.length < level - 1) trail.push("");
      trail[level - 1] = h[2]!;
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

function splitLong(text: string, max: number, overlap: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  const paras = text.split(/\n{2,}/);
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
  };
  for (const p of paras) {
    if (p.length > max) {
      push();
      cur = "";
      // hard-split very long paragraphs on sentence boundaries
      const sentences = p.split(/(?<=[.!?])\s+/);
      let s = "";
      for (const sent of sentences) {
        if ((s + " " + sent).length > max && s) {
          out.push(s.trim());
          s = s.slice(Math.max(0, s.length - overlap));
        }
        s += (s ? " " : "") + sent;
        while (s.length > max) {
          out.push(s.slice(0, max));
          s = s.slice(max - overlap);
        }
      }
      if (s.trim()) out.push(s.trim());
      continue;
    }
    if ((cur + "\n\n" + p).length > max && cur) {
      push();
      cur = cur.slice(Math.max(0, cur.length - overlap));
    }
    cur += (cur ? "\n\n" : "") + p;
  }
  push();
  return out;
}

export function chunkMarkdown(markdown: string, opts: ChunkOptions = {}): Chunk[] {
  const max = opts.maxChars ?? 1200;
  const overlap = opts.overlapChars ?? 150;
  const chunks: Chunk[] = [];
  const sections = splitSections(markdown);
  if (sections.length === 0 && opts.preamble) {
    return [{ ord: 0, heading: null, content: opts.preamble.trim() }];
  }
  for (const s of sections) {
    const heading = s.trail.filter(Boolean).join(" > ") || null;
    for (const piece of splitLong(s.text, max, overlap)) {
      const prefix = [opts.preamble?.trim(), heading ? `## ${heading}` : null].filter(Boolean).join("\n");
      chunks.push({ ord: chunks.length, heading, content: prefix ? `${prefix}\n\n${piece}` : piece });
    }
  }
  return chunks;
}

/** Stable content hash (hex sha-256) using Web Crypto, available in Deno and Node. */
export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
