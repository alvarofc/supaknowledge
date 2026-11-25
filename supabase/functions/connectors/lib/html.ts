// A small, forgiving HTML parser (no DOM in the Edge Runtime, and a full parser dependency is overkill
// for "turn this page into markdown"). Handles void elements, raw-text elements, comments, entities and
// the common implicit end tags (p, li, td/th, tr, dt/dd, option).

export interface HElement {
  tag: string;
  attrs: Record<string, string>;
  children: HNode[];
  parent: HElement | null;
}
export type HNode = HElement | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "template"]);
// opening one of these closes an open <p>
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
  middot: "·", bull: "•", times: "×", divide: "÷", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", check: "✓", para: "¶", sect: "§", shy: "",
  zwj: "", zwnj: "", thinsp: " ", ensp: " ", emsp: " ",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = NAMED[e.toLowerCase()];
    return v ?? m;
  });
}

const TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][\w:-]*)[^>]*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?|\s*\/(?!>))*)\s*(\/?)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(s: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!s) return attrs;
  for (const m of s.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

export function parseHtml(html: string): HElement {
  const root: HElement = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  const text = (t: string) => {
    if (t) cur.children.push(decodeEntities(t));
  };
  const closeTo = (tag: string, stopAt: string[] = []) => {
    for (let n: HElement | null = cur; n && n !== root; n = n.parent) {
      if (stopAt.includes(n.tag)) return false;
      if (n.tag === tag) {
        cur = n.parent ?? root;
        return true;
      }
    }
    return false;
  };
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(html); m; m = TOKEN.exec(html)) {
    text(html.slice(last, m.index));
    last = TOKEN.lastIndex;
    const [tok, cdata, closeTag, openTag, attrStr, selfClose] = m;
    if (cdata !== undefined) {
      cur.children.push(cdata);
      continue;
    }
    if (closeTag) {
      const t = closeTag.toLowerCase();
      if (t === "br") cur.children.push({ tag: "br", attrs: {}, children: [], parent: cur });
      else closeTo(t);
      continue;
    }
    if (!openTag) continue; // comment, doctype, processing instruction
    void tok;
    const tag = openTag.toLowerCase();
    // implicit end tags
    if (CLOSES_P.has(tag)) closeTo("p", ["button", "table", "li", "td", "th", "blockquote", "div", "section", "article"]);
    if (tag === "li") closeTo("li", ["ul", "ol", "menu"]);
    if (tag === "dt" || tag === "dd") closeTo("dt", ["dl"]) || closeTo("dd", ["dl"]);
    if (tag === "tr") closeTo("tr", ["table", "thead", "tbody", "tfoot"]);
    if (tag === "td" || tag === "th") closeTo("td", ["tr", "table"]) || closeTo("th", ["tr", "table"]);
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      closeTo("thead", ["table"]) || closeTo("tbody", ["table"]) || closeTo("tfoot", ["table"]);
    }
    if (tag === "option") closeTo("option", ["select"]);

    const el: HElement = { tag, attrs: parseAttrs(attrStr), children: [], parent: cur };
    cur.children.push(el);
    if (RAW_TEXT.has(tag) && !selfClose) {
      const re = new RegExp(`</${tag}\\s*>`, "ig");
      re.lastIndex = last;
      const end = re.exec(html);
      const body = html.slice(last, end ? end.index : html.length);
      if (body) el.children.push(tag === "textarea" || tag === "title" ? decodeEntities(body) : body);
      last = end ? re.lastIndex : html.length;
      TOKEN.lastIndex = last;
      continue;
    }
    if (VOID.has(tag) || selfClose) continue;
    cur = el;
  }
  text(html.slice(last));
  return root;
}

export function isElement(n: HNode): n is HElement {
  return typeof n !== "string";
}

export function textContent(n: HNode): string {
  if (typeof n === "string") return n;
  if (n.tag === "script" || n.tag === "style") return "";
  return n.children.map(textContent).join("");
}

export function* walk(n: HElement): Generator<HElement> {
  for (const c of n.children) {
    if (isElement(c)) {
      yield c;
      yield* walk(c);
    }
  }
}

export function find(n: HElement, pred: (e: HElement) => boolean): HElement | null {
  for (const e of walk(n)) if (pred(e)) return e;
  return null;
}

export function findAll(n: HElement, pred: (e: HElement) => boolean): HElement[] {
  const out: HElement[] = [];
  for (const e of walk(n)) if (pred(e)) out.push(e);
  return out;
}
