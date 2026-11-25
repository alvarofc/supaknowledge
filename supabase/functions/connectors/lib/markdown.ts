// Conversions to markdown: HTML (web pages, uploads, Drive/GitHub html), Notion blocks, Slack mrkdwn.
// Output is meant for chunking + embedding + the curator reading it, so it favours clean structure over
// perfect fidelity (no inline HTML, images reduced to alt text links, layout containers flattened).
import { type HElement, type HNode, isElement, parseHtml, textContent } from "./html.ts";

// ---------------------------------------------------------------------------------------------------------
// HTML -> markdown
// ---------------------------------------------------------------------------------------------------------
const BLOCK = new Set([
  "#root", "html", "body", "address", "article", "aside", "blockquote", "details", "dialog", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li",
  "main", "nav", "ol", "p", "pre", "section", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "ul", "summary",
  "caption", "center", "menu", "hgroup", "search",
]);
// never content
const DROP_ALWAYS = new Set([
  "head", "title", "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "video", "audio",
  "map", "button", "select", "input", "textarea", "dialog", "link", "meta", "base",
]);
// page chrome, dropped in main-content mode
const DROP_CHROME = new Set(["nav", "header", "footer", "aside", "form", "menu"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "menu", "menubar", "dialog", "alert"]);
const CHROME_HINT =
  /(^|[\s_-])(nav|navbar|navigation|menu|sidebar|side-bar|footer|breadcrumbs?|cookie|cookies|consent|banner|advert|ads|social|share|sharing|related|newsletter|subscribe|skip-link|toc-sidebar|site-header|site-footer|popup|modal)($|[\s_-])/i;

export interface HtmlToMarkdownOptions {
  /** extract the main content (drop nav/header/footer/sidebars, prefer <main>/<article>) */
  mainContent?: boolean;
  /** resolve relative links against this URL */
  baseUrl?: string;
}

export interface HtmlConversion {
  title: string | null;
  markdown: string;
  links: string[];
}

function isChrome(el: HElement, inContainer: boolean): boolean {
  if (el.attrs.hidden !== undefined || el.attrs["aria-hidden"] === "true") return true;
  const style = el.attrs.style ?? "";
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
  // header/footer inside the chosen <main>/<article> usually hold the article title / byline: keep them
  if (DROP_CHROME.has(el.tag) && !(inContainer && (el.tag === "header" || el.tag === "footer"))) return true;
  const role = el.attrs.role?.toLowerCase();
  if (role && CHROME_ROLES.has(role)) return true;
  const hint = `${el.attrs.id ?? ""} ${el.attrs.class ?? ""}`;
  return hint.trim() !== "" && CHROME_HINT.test(hint) && el.tag !== "body" && el.tag !== "main" && el.tag !== "article";
}

function prune(el: HElement, mainContent: boolean, inContainer: boolean): HElement {
  const children: HNode[] = [];
  for (const c of el.children) {
    if (!isElement(c)) {
      children.push(c);
      continue;
    }
    if (DROP_ALWAYS.has(c.tag)) continue;
    if (mainContent && isChrome(c, inContainer)) continue;
    children.push(prune(c, mainContent, inContainer));
  }
  const copy: HElement = { ...el, children };
  for (const c of children) if (isElement(c)) c.parent = copy;
  return copy;
}

function textLen(n: HNode): number {
  return textContent(n).replace(/\s+/g, " ").trim().length;
}

function pickContainer(root: HElement): { el: HElement; isContainer: boolean } {
  const all: HElement[] = [];
  const visit = (n: HElement) => {
    for (const c of n.children) {
      if (!isElement(c)) continue;
      if (DROP_ALWAYS.has(c.tag)) continue;
      all.push(c);
      visit(c);
    }
  };
  visit(root);
  const main = all.find((e) => e.tag === "main" || e.attrs.role === "main");
  if (main && textLen(main) > 0) return { el: main, isContainer: true };
  const articles = all.filter((e) => e.tag === "article");
  if (articles.length) {
    const best = articles.reduce((a, b) => (textLen(b) > textLen(a) ? b : a));
    // a lone small article in a big page is likely a teaser card; use it only when it carries most text
    const body = all.find((e) => e.tag === "body") ?? root;
    if (articles.length === 1 || textLen(best) > textLen(body) * 0.4) return { el: best, isContainer: true };
  }
  return { el: all.find((e) => e.tag === "body") ?? root, isContainer: false };
}

function resolveUrl(href: string, base?: string): string | null {
  const h = href.trim();
  if (!h || /^(javascript|data|vbscript):/i.test(h)) return null;
  if (h.startsWith("#")) return null;
  try {
    return base ? new URL(h, base).toString() : h;
  } catch {
    return h;
  }
}

interface RenderCtx {
  baseUrl?: string;
  links: string[];
}

function collapse(s: string): string {
  return s.replace(/[ \t\r\n\f\v ]+/g, " ");
}

function inline(nodes: HNode[], ctx: RenderCtx): string {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") {
      out += collapse(n);
      continue;
    }
    const inner = () => inline(n.children, ctx);
    switch (n.tag) {
      case "br":
        out += "\n";
        break;
      case "strong":
      case "b": {
        const t = inner().trim();
        if (t) out += `**${t}**`;
        break;
      }
      case "em":
      case "i": {
        const t = inner().trim();
        if (t) out += `_${t}_`;
        break;
      }
      case "del":
      case "s":
      case "strike": {
        const t = inner().trim();
        if (t) out += `~~${t}~~`;
        break;
      }
      case "code":
      case "kbd":
      case "samp": {
        const t = collapse(textContent(n)).trim();
        if (t) out += t.includes("`") ? `\`\` ${t} \`\`` : `\`${t}\``;
        break;
      }
      case "a": {
        const t = inner().trim();
        const href = n.attrs.href ? resolveUrl(n.attrs.href, ctx.baseUrl) : null;
        if (href) ctx.links.push(href);
        if (!t) break;
        out += href && href !== t ? `[${t}](${href})` : t;
        break;
      }
      case "img": {
        const alt = collapse(n.attrs.alt ?? "").trim();
        if (alt) out += `[image: ${alt}]`;
        break;
      }
      case "input":
        if (n.attrs.type === "checkbox") out += n.attrs.checked !== undefined ? "[x] " : "[ ] ";
        break;
      case "sup":
        out += `^${inner().trim()}`;
        break;
      default:
        // block element inside inline context (e.g. <a><div>..</div></a>): flatten to text
        out += BLOCK.has(n.tag) ? ` ${inner()} ` : inner();
    }
  }
  return out;
}

function cleanInline(s: string): string {
  return s.split("\n").map((l) => l.replace(/ +/g, " ").trim()).join("\n").replace(/\n{2,}/g, "\n").trim();
}

function indent(s: string, prefix: string): string {
  return s.split("\n").map((l) => (l ? prefix + l : l)).join("\n");
}

function renderList(el: HElement, ctx: RenderCtx): string {
  const ordered = el.tag === "ol";
  let n = Number(el.attrs.start ?? 1) || 1;
  const items: string[] = [];
  for (const c of el.children) {
    if (!isElement(c)) {
      const t = collapse(c).trim();
      if (t) items.push(`- ${t}`);
      continue;
    }
    if (c.tag !== "li") {
      // stray content directly inside a list
      const inner = blocks(c.children, ctx).join("\n\n");
      if (inner) items.push(inner);
      continue;
    }
    const marker = ordered ? `${n++}. ` : "- ";
    // tight lists: blocks inside an item (text, nested list) are separated by a single newline
    const body = blocks(c.children, ctx).join("\n").trim();
    if (!body) continue;
    const [first, ...rest] = body.split("\n");
    const pad = " ".repeat(marker.length);
    items.push(marker + first + (rest.length ? "\n" + indent(rest.join("\n"), pad) : ""));
  }
  return items.join("\n");
}

function renderTable(el: HElement, ctx: RenderCtx): string {
  const rows: string[][] = [];
  let headerRow = false;
  const visitRows = (n: HElement, inHead: boolean) => {
    for (const c of n.children) {
      if (!isElement(c)) continue;
      if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") visitRows(c, c.tag === "thead");
      else if (c.tag === "tr") {
        const cells = c.children.filter(isElement).filter((x) => x.tag === "td" || x.tag === "th");
        if (rows.length === 0 && (inHead || (cells.length > 0 && cells.every((x) => x.tag === "th")))) headerRow = true;
        rows.push(cells.map((x) => cleanInline(inline(x.children, ctx)).replace(/\n/g, " ").replace(/\|/g, "\\|")));
      }
    }
  };
  visitRows(el, false);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const head = headerRow ? pad(rows.shift()!) : Array(width).fill("");
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const r of rows) lines.push(`| ${pad(r).join(" | ")} |`);
  const caption = el.children.find((c): c is HElement => isElement(c) && c.tag === "caption");
  return (caption ? `_${cleanInline(inline(caption.children, ctx))}_\n\n` : "") + lines.join("\n");
}

function renderBlock(el: HElement, ctx: RenderCtx): string[] {
  switch (el.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const t = cleanInline(inline(el.children, ctx)).replace(/\n/g, " ");
      return t ? [`${"#".repeat(Number(el.tag[1]))} ${t}`] : [];
    }
    case "p": {
      const t = cleanInline(inline(el.children, ctx));
      return t ? [t] : [];
    }
    case "pre": {
      const code = el.children.find((c): c is HElement => isElement(c) && c.tag === "code");
      const cls = `${code?.attrs.class ?? ""} ${el.attrs.class ?? ""}`;
      const lang = /(?:language|lang)-([\w+#.-]+)/.exec(cls)?.[1] ?? "";
      const body = textContent(el).replace(/^\n/, "").replace(/\s+$/, "");
      if (!body) return [];
      const fence = body.includes("```") ? "~~~~" : "```";
      return [`${fence}${lang}\n${body}\n${fence}`];
    }
    case "blockquote": {
      const inner = blocks(el.children, ctx).join("\n\n");
      return inner ? [inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")] : [];
    }
    case "ul":
    case "ol":
    case "menu": {
      const l = renderList(el, ctx);
      return l ? [l] : [];
    }
    case "table": {
      const t = renderTable(el, ctx);
      return t ? [t] : [];
    }
    case "hr":
      return ["---"];
    case "dt": {
      const t = cleanInline(inline(el.children, ctx));
      return t ? [`**${t}**`] : [];
    }
    case "summary": {
      const t = cleanInline(inline(el.children, ctx));
      return t ? [`**${t}**`] : [];
    }
    default:
      return blocks(el.children, ctx);
  }
}

function blocks(children: HNode[], ctx: RenderCtx): string[] {
  const out: string[] = [];
  let buf: HNode[] = [];
  const flush = () => {
    if (!buf.length) return;
    const t = cleanInline(inline(buf, ctx));
    if (t) out.push(t);
    buf = [];
  };
  for (const c of children) {
    if (!isElement(c) || !BLOCK.has(c.tag)) {
      buf.push(c);
      continue;
    }
    flush();
    out.push(...renderBlock(c, ctx));
  }
  flush();
  return out;
}

export function htmlToMarkdown(html: string, opts: HtmlToMarkdownOptions = {}): HtmlConversion {
  const doc = parseHtml(html);
  const titleEl = findFirst(doc, (e) => e.tag === "title");
  const ogTitle = findFirst(doc, (e) => e.tag === "meta" && (e.attrs.property === "og:title" || e.attrs.name === "og:title"));
  let { el, isContainer } = opts.mainContent ? pickContainer(doc) : { el: doc, isContainer: false };
  el = prune(el, !!opts.mainContent, isContainer);
  const ctx: RenderCtx = { baseUrl: opts.baseUrl, links: [] };
  const markdown = blocks(el.children, ctx).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  const h1 = findFirst(el, (e) => e.tag === "h1");
  const title = (titleEl ? collapse(textContent(titleEl)).trim() : "") || ogTitle?.attrs.content?.trim() ||
    (h1 ? collapse(textContent(h1)).trim() : "");
  return { title: title || null, markdown, links: [...new Set(ctx.links)] };
}

function findFirst(n: HElement, pred: (e: HElement) => boolean): HElement | null {
  for (const c of n.children) {
    if (!isElement(c)) continue;
    if (pred(c)) return c;
    const f = findFirst(c, pred);
    if (f) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Notion blocks -> markdown
// ---------------------------------------------------------------------------------------------------------
export interface NotionRichText {
  type?: string;
  plain_text: string;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; code?: boolean };
  equation?: { expression: string };
}

// deno-lint-ignore no-explicit-any
export type NotionBlock = { id: string; type: string; has_children?: boolean; children?: NotionBlock[] } & Record<string, any>;

export function notionRichText(rt: NotionRichText[] | undefined): string {
  if (!rt) return "";
  return rt.map((t) => {
    let s = t.type === "equation" && t.equation ? `$${t.equation.expression}$` : t.plain_text ?? "";
    if (!s) return "";
    const a = t.annotations ?? {};
    // keep surrounding whitespace outside of markers so "**bold **text" does not happen
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
    let core = m[2]!;
    if (core) {
      if (a.code) core = `\`${core}\``;
      if (a.bold) core = `**${core}**`;
      if (a.italic) core = `_${core}_`;
      if (a.strikethrough) core = `~~${core}~~`;
      if (t.href) core = `[${core}](${t.href})`;
    }
    s = m[1] + core + m[3];
    return s;
  }).join("");
}

function blockText(b: NotionBlock): string {
  return notionRichText(b[b.type]?.rich_text);
}

function fileUrl(f: { type?: string; external?: { url: string }; file?: { url: string }; name?: string } | undefined): string | null {
  if (!f) return null;
  // Notion-hosted file URLs are signed and expire after an hour: only keep external links
  return f.type === "external" ? f.external?.url ?? null : null;
}

export interface NotionRenderOptions {
  /** called for child_page / child_database blocks (lets the connector discover sub-pages) */
  onChildPage?: (id: string, title: string) => void;
}

export function notionBlocksToMarkdown(blocks: NotionBlock[], opts: NotionRenderOptions = {}, depth = 0): string {
  const out: string[] = [];
  let listRun: string[] = [];
  let num = 0;
  const flushList = () => {
    if (listRun.length) out.push(listRun.join("\n"));
    listRun = [];
  };
  const children = (b: NotionBlock) => (b.children?.length ? notionBlocksToMarkdown(b.children, opts, depth + 1) : "");
  const listItem = (marker: string, b: NotionBlock, text: string) => {
    const kids = children(b);
    listRun.push(marker + text + (kids ? "\n" + indent(kids, " ".repeat(marker.length)) : ""));
  };

  for (const b of blocks) {
    const isList = b.type === "bulleted_list_item" || b.type === "numbered_list_item" || b.type === "to_do" || b.type === "toggle";
    if (!isList) flushList();
    if (b.type !== "numbered_list_item") num = 0;
    const text = blockText(b);
    switch (b.type) {
      case "paragraph": {
        const kids = children(b);
        if (text) out.push(text);
        if (kids) out.push(indent(kids, "  "));
        break;
      }
      case "heading_1":
      case "heading_2":
      case "heading_3": {
        const level = Number(b.type.slice(-1));
        if (text) out.push(`${"#".repeat(level)} ${text}`);
        const kids = children(b); // toggleable headings
        if (kids) out.push(kids);
        break;
      }
      case "bulleted_list_item":
        listItem("- ", b, text);
        break;
      case "numbered_list_item":
        listItem(`${++num}. `, b, text);
        break;
      case "to_do":
        listItem(b.to_do?.checked ? "- [x] " : "- [ ] ", b, text);
        break;
      case "toggle":
        listItem("- ", b, text);
        break;
      case "code": {
        const lang = (b.code?.language ?? "").replace(/^plain text$/, "");
        const body = notionRichText(b.code?.rich_text);
        out.push("```" + lang + "\n" + body + "\n```");
        const cap = notionRichText(b.code?.caption);
        if (cap) out.push(`_${cap}_`);
        break;
      }
      case "quote": {
        const kids = children(b);
        const inner = [text, kids].filter(Boolean).join("\n\n");
        if (inner) out.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        break;
      }
      case "callout": {
        const icon = b.callout?.icon?.type === "emoji" ? `${b.callout.icon.emoji} ` : "";
        const kids = children(b);
        const inner = [icon + text, kids].filter((x) => x.trim()).join("\n\n");
        if (inner) out.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        break;
      }
      case "divider":
        out.push("---");
        break;
      case "equation":
        out.push(`$$\n${b.equation?.expression ?? ""}\n$$`);
        break;
      case "table": {
        const rows = (b.children ?? []).filter((r) => r.type === "table_row").map((r) =>
          (r.table_row?.cells ?? []).map((cell: NotionRichText[]) => notionRichText(cell).replace(/\n/g, " ").replace(/\|/g, "\\|"))
        );
        if (!rows.length) break;
        const width = Math.max(b.table?.table_width ?? 0, ...rows.map((r: string[]) => r.length));
        const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill("")];
        const head = b.table?.has_column_header ? pad(rows.shift()!) : Array(width).fill("");
        const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
        for (const r of rows) lines.push(`| ${pad(r).join(" | ")} |`);
        out.push(lines.join("\n"));
        break;
      }
      case "child_page": {
        const title = b.child_page?.title ?? "Untitled";
        opts.onChildPage?.(b.id, title);
        out.push(`[${title}](https://www.notion.so/${b.id.replace(/-/g, "")})`);
        break;
      }
      case "child_database":
        out.push(`[Database: ${b.child_database?.title ?? "Untitled"}](https://www.notion.so/${b.id.replace(/-/g, "")})`);
        break;
      case "bookmark":
      case "embed":
      case "link_preview": {
        const url = b[b.type]?.url;
        const cap = notionRichText(b[b.type]?.caption);
        if (url) out.push(`[${cap || url}](${url})`);
        break;
      }
      case "image":
      case "file":
      case "pdf":
      case "video":
      case "audio": {
        const cap = notionRichText(b[b.type]?.caption);
        const url = fileUrl(b[b.type]);
        const name = b[b.type]?.name ?? b.type;
        if (url) out.push(`[${cap || name}](${url})`);
        else if (cap) out.push(`[${b.type}: ${cap}]`);
        break;
      }
      case "link_to_page": {
        const id = b.link_to_page?.page_id ?? b.link_to_page?.database_id;
        if (id) out.push(`[Linked page](https://www.notion.so/${String(id).replace(/-/g, "")})`);
        break;
      }
      case "synced_block":
      case "column_list":
      case "column": {
        const kids = children(b);
        if (kids) out.push(kids);
        break;
      }
      case "table_of_contents":
      case "breadcrumb":
      case "unsupported":
        break;
      default: {
        // unknown block types: keep their text if any
        const kids = children(b);
        if (text) out.push(text);
        if (kids) out.push(kids);
      }
    }
  }
  flushList();
  return out.join("\n\n");
}

/** Render database page properties as a short key/value list (skipping the title). */
// deno-lint-ignore no-explicit-any
export function notionPropertiesToMarkdown(props: Record<string, any> | undefined): string {
  if (!props) return "";
  const lines: string[] = [];
  for (const [name, p] of Object.entries(props)) {
    if (!p || p.type === "title") continue;
    let v = "";
    switch (p.type) {
      case "rich_text":
        v = notionRichText(p.rich_text);
        break;
      case "select":
      case "status":
        v = p[p.type]?.name ?? "";
        break;
      case "multi_select":
        v = (p.multi_select ?? []).map((o: { name: string }) => o.name).join(", ");
        break;
      case "date":
        v = p.date ? [p.date.start, p.date.end].filter(Boolean).join(" → ") : "";
        break;
      case "people":
        v = (p.people ?? []).map((u: { name?: string; id: string }) => u.name ?? u.id).join(", ");
        break;
      case "number":
        v = p.number === null || p.number === undefined ? "" : String(p.number);
        break;
      case "checkbox":
        v = p.checkbox ? "yes" : "no";
        break;
      case "url":
      case "email":
      case "phone_number":
        v = p[p.type] ?? "";
        break;
      case "formula":
        v = p.formula ? String(p.formula[p.formula.type] ?? "") : "";
        break;
      default:
        v = "";
    }
    if (v) lines.push(`- **${name}:** ${v}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// Slack mrkdwn -> markdown
// ---------------------------------------------------------------------------------------------------------
export function slackToMarkdown(text: string, resolve: { user?: (id: string) => string | undefined } = {}): string {
  let s = text ?? "";
  // <@U123> / <@U123|name>
  s = s.replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, name?: string) => `@${name ?? resolve.user?.(id) ?? id}`);
  // <#C123|general>
  s = s.replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => `#${name || id}`);
  // <!here>, <!channel>, <!subteam^S123|@team>
  s = s.replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, name?: string) => name ?? "@team");
  s = s.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1");
  s = s.replace(/<!date\^\d+\^[^|>]*\|([^>]+)>/g, "$1");
  // links <url|text> and <url>
  s = s.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => `[${label}](${url})`);
  s = s.replace(/<((?:https?|mailto):[^>]+)>/g, "$1");
  // formatting: *bold* -> **bold**, ~strike~ -> ~~strike~~ (not inside code)
  s = s.split(/(```[\s\S]*?```|`[^`\n]+`)/g).map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      .replace(/(^|[\s(>])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1**$2**")
      .replace(/(^|[\s(>])~([^~\n]+)~(?=$|[\s).,!?:;])/g, "$1~~$2~~");
  }).join("");
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
