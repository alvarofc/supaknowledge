import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { runSync } from "../lib/engine.ts";
import { prepareUpload, UploadError, uploadExt } from "../lib/upload.ts";
import { MemoryStore, scripted } from "./helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("upload: markdown / text / html conversions and default ids", async () => {
  const md = await prepareUpload({ filename: "Refund Policy.md", bytes: enc("# Refunds\n\n30 days.") });
  assertEquals([md.externalId, md.title, md.content, md.raw?.ext, md.mimeType], ["refund-policy.md", "Refunds", "# Refunds\n\n30 days.", "md", "text/markdown"]);

  const txt = await prepareUpload({ filename: "notes.txt", bytes: enc("plain") });
  assertEquals([txt.title, txt.content, txt.raw?.contentType], ["notes", "plain", "text/plain"]);

  const html = await prepareUpload({ filename: "page.html", bytes: enc("<title>T</title><nav>x</nav><main><h2>Hi</h2><p>there</p></main>") });
  assertEquals([html.title, html.content], ["T", "## Hi\n\nthere"]);

  const json = await prepareUpload({ text: "# Pricing\n\nPro is $20.", title: "Pricing page" });
  assertEquals([json.externalId, json.title, json.raw?.ext], ["pricing-page", "Pricing page", "md"]);
  const explicit = await prepareUpload({ text: "<p>x</p>", format: "html", externalId: "kb/42" });
  assertEquals([explicit.externalId, explicit.content], ["kb/42", "x"]);
});

Deno.test("upload: pdf text is extracted; broken pdfs are stored with empty content + a note", async () => {
  const bytes = await Deno.readFile(new URL("./fixtures/expense-policy.pdf", import.meta.url));
  const pdf = await prepareUpload({ filename: "expense-policy.pdf", contentType: "application/pdf", bytes });
  assertStringIncludes(pdf.content, "Expense policy: meals up to 50 EUR per day.");
  assertEquals([pdf.raw?.ext, pdf.metadata?.pdf_pages, pdf.metadata?.extraction_error], ["pdf", 1, undefined]);

  const broken = await prepareUpload({ filename: "scan.pdf", bytes: enc("%PDF-1.7 garbage") });
  assertEquals(broken.content, "");
  assert(typeof broken.metadata?.extraction_error === "string");
  assertEquals(broken.raw?.ext, "pdf");
});

Deno.test("upload: unsupported, binary, empty and oversized inputs are rejected", async () => {
  await assertRejects(() => prepareUpload({ filename: "x.docx", bytes: enc("PK") }), UploadError, "unsupported");
  await assertRejects(() => prepareUpload({ filename: "x.md", bytes: new Uint8Array([0, 1, 2]) }), UploadError, "does not look like");
  await assertRejects(() => prepareUpload({ filename: "x.md", bytes: new Uint8Array() }), UploadError, "empty");
  await assertRejects(() => prepareUpload({ filename: "x.txt", bytes: new Uint8Array(21 * 1024 * 1024).fill(65) }), UploadError, "too large");
  assertEquals(uploadExt({ contentType: "text/html; charset=utf-8" }), "html");
});

Deno.test("upload: documents inherit the source audience and re-uploads only write on change", async () => {
  const store = new MemoryStore();
  const src = { id: "src", space_id: "sp", connector: "upload" as const, config: {}, audience: ["g-fin"], cursor: {}, status: "active" as const };
  const doc = await prepareUpload({ filename: "a.md", bytes: enc("# A") });
  const base = { source: src, store, groups: [], token: null, full: false, fetch, log: () => {} };
  let r = await runSync({ ...base, connector: scripted([{ type: "upsert", doc }]) });
  assertEquals(r.upserted, 1);
  assertEquals(store.docs.get("a.md")!.audience, ["g-fin"]);
  assert(store.docs.get("a.md")!.storage_path!.startsWith("sp/src/a.md-"));
  r = await runSync({ ...base, connector: scripted([{ type: "upsert", doc }]) });
  assertEquals([r.upserted, r.unchanged], [0, 1]);
});
