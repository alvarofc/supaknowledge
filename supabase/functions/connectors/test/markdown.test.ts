import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { htmlToMarkdown, type NotionBlock, notionBlocksToMarkdown, notionPropertiesToMarkdown, slackToMarkdown } from "../lib/markdown.ts";
import { parseHtml, textContent } from "../lib/html.ts";
import { fixture, fixtureText } from "./helpers.ts";

Deno.test("html: main content extraction strips chrome, scripts and styles", async () => {
  const html = await fixtureText("web-article.html");
  const { title, markdown, links } = htmlToMarkdown(html, { mainContent: true, baseUrl: "https://acme.example/docs/refunds" });
  assertEquals(title, "Refund policy — Acme Docs");
  for (const junk of ["Pricing", "Sidebar link", "cookies", "dataLayer", "font-family", "© 2026", "Accept"]) {
    assert(!markdown.includes(junk), `should not contain ${junk}:\n${markdown}`);
  }
  assert(markdown.startsWith("# Refund policy"));
  assertStringIncludes(markdown, "Customers can request a refund within **30 days** of purchase. See the [billing guide](https://acme.example/docs/billing) for details.");
  assertStringIncludes(markdown, "## Eligibility");
  assertStringIncludes(markdown, "- Annual plans: prorated refund\n- Monthly plans: _no_ refund\n  1. Except outages > 24h\n  2. Or billing errors");
  assertStringIncludes(markdown, "| Plan | Fee |\n| --- | --- |\n| Pro | $0 |\n| Enterprise | Contract \\| custom |");
  assertStringIncludes(markdown, "```sql\nselect * from refunds\nwhere created_at > now() - interval '30 days';\n```");
  assertStringIncludes(markdown, "> Refunds are processed by finance on Fridays.");
  assertStringIncludes(markdown, "Line one\nLine two & three — done!");
  assertStringIncludes(markdown, "[image: Refund volume chart]");
  assert(links.includes("https://acme.example/docs/billing"));
});

Deno.test("html: without mainContent keeps everything but scripts/styles", () => {
  const { markdown } = htmlToMarkdown("<nav>Menu</nav><p>Hello <b>world</b></p><script>x()</script>");
  assertEquals(markdown, "Menu\n\nHello **world**");
});

Deno.test("html: parser tolerates unclosed tags, comments, entities and raw text", () => {
  const root = parseHtml(`<!-- c --><div><p>one<p>two &lt;b&gt; &#x1F600;<script>if (a < b) { "</p>" }</script></div>`);
  assertEquals(textContent(root), "onetwo <b> 😀");
  const { markdown } = htmlToMarkdown("<ul><li>a<li>b<ul><li>c</ul></ul><dl><dt>Term<dd>Def</dl>");
  assertEquals(markdown, "- a\n- b\n  - c\n\n**Term**\n\nDef");
});

Deno.test("html: falls back to the largest article, ignores hidden nodes and javascript: links", () => {
  const html = `<body><div class="teaser"><article>Short teaser</article></div>
    <article><h2>Real</h2><p>${"long text ".repeat(50)}<a href="javascript:alert(1)">bad</a></p><div hidden>secret</div></article></body>`;
  const { markdown } = htmlToMarkdown(html, { mainContent: true });
  assert(markdown.startsWith("## Real"));
  assert(!markdown.includes("Short teaser"));
  assert(!markdown.includes("secret"));
  assert(!markdown.includes("javascript:"));
});

Deno.test("notion: blocks -> markdown covers headings, lists, to-dos, code, quote, callout, toggle, table, child pages", async () => {
  const fx = await fixture<{ page: { properties: Record<string, unknown> }; blocks: NotionBlock[]; children: Record<string, NotionBlock[]> }>("notion-blocks.json");
  const attach = (bs: NotionBlock[]): NotionBlock[] => bs.map((b) => (fx.children[b.id] ? { ...b, children: attach(fx.children[b.id]!) } : b));
  const children: string[] = [];
  const md = notionBlocksToMarkdown(attach(fx.blocks), { onChildPage: (id) => children.push(id) });
  assertEquals(
    md,
    [
      "# Week one",
      "Read the [**support handbook**](https://acme.example/handbook) and run `kf pull`.",
      "- Accounts\n  - Google Workspace\n  - ~~Zendesk~~\n- _Laptop_\n1. Shadow a senior\n2. Take first ticket\n- [x] Sign NDA\n- [ ] Set up 2FA",
      "```bash\nnpm install\nnpm test\n```",
      "> Ask early, ask often.",
      "> ⚠️ Never share customer data in Slack.",
      "- FAQ\n  Payroll runs on the 25th.",
      "| Tier | SLA |\n| --- | --- |\n| Gold | 1h \\| 24/7 |",
      "---",
      "[Escalation matrix](https://www.notion.so/b15)",
      "[image: Org chart]",
    ].join("\n\n"),
  );
  assertEquals(children, ["b15"]);
  assertEquals(
    notionPropertiesToMarkdown(fx.page.properties),
    "- **Team:** Support\n- **Tags:** process, new-hire\n- **Reviewed:** yes",
  );
});

Deno.test("slack: mrkdwn -> markdown", () => {
  const names: Record<string, string> = { U1: "alice" };
  const out = slackToMarkdown(
    "Hey <@U1> and <@U2|bob>, see <#C9|ops> and <https://x.example/a?b=1|the runbook> or <https://y.example>. *Important*: ~old~ `*not bold*` &lt;tag&gt; &amp; <!here>",
    { user: (id) => names[id] },
  );
  assertEquals(
    out,
    "Hey @alice and @bob, see #ops and [the runbook](https://x.example/a?b=1) or https://y.example. **Important**: ~~old~~ `*not bold*` <tag> & @here",
  );
});
