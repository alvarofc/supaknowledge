import { assert, assertEquals, assertRejects } from "@std/assert";
import { driveAcl, driveKind, gdrive } from "../lib/gdrive.ts";
import { googleAccessToken } from "../lib/google-auth.ts";
import { AuthError } from "../lib/types.ts";
import { collect, fakeFetch, fixture, lastCursor, makeCtx, upserts } from "./helpers.ts";

const API = "https://www.googleapis.com/drive/v3";
// deno-lint-ignore no-explicit-any
type Fx = any;

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function serviceAccount() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  const json = JSON.stringify({ type: "service_account", client_email: "kf@proj.iam.gserviceaccount.com", private_key: pem, private_key_id: "k1", token_uri: "https://oauth2.googleapis.com/token" });
  return { json, publicKey: kp.publicKey };
}

async function api(publicKey: CryptoKey, seen: { claims?: Record<string, unknown>; header?: Record<string, unknown> }) {
  const fx: Fx = await fixture("gdrive.json");
  const f = fakeFetch([
    ["POST https://oauth2.googleapis.com/token", async ({ body }) => {
      const p = new URLSearchParams(body!);
      assertEquals(p.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [h, c, s] = p.get("assertion")!.split(".");
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64urlDecode(s!), new TextEncoder().encode(`${h}.${c}`));
      if (!ok) return new Response('{"error":"invalid_grant"}', { status: 400 });
      seen.header = JSON.parse(new TextDecoder().decode(b64urlDecode(h!)));
      seen.claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c!)));
      return { access_token: "ya29.test", expires_in: 3599, token_type: "Bearer" };
    }],
    [`GET ${API}/changes/startPageToken`, () => ({ startPageToken: "tok-1" })],
    [`GET ${API}/changes`, () => fx.changes],
    [`GET ${API}/files/`, ({ url }) => {
      const id = url.pathname.split("/")[4]!;
      if (url.pathname.endsWith("/export")) {
        const body = fx.exports[`${id}:${url.searchParams.get("mimeType")}`];
        return body === undefined ? new Response('{"error":{"code":403,"message":"exportSizeLimitExceeded"}}', { status: 403 }) : new Response(body);
      }
      assertEquals(url.searchParams.get("alt"), "media");
      return new Response(fx.media[id]);
    }],
    [`GET ${API}/files`, ({ url }) => {
      const q = url.searchParams.get("q")!;
      const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]!);
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
        return { files: parents.flatMap((p) => fx.folders[p] ?? []) };
      }
      const since = /modifiedTime >= '([^']+)'/.exec(q)?.[1];
      const files = fx.files.filter((f: Fx) => f.parents.some((p: string) => parents.includes(p)) && (!since || f.modifiedTime >= since));
      // paginate one file per page to exercise nextPageToken
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      return { files: files.slice(start, start + 1), ...(start + 1 < files.length ? { nextPageToken: String(start + 1) } : {}) };
    }],
  ]);
  return { f, fx };
}

Deno.test("gdrive: service-account JWT (RS256 via WebCrypto) is signed and exchanged", async () => {
  const sa = await serviceAccount();
  const seen: { claims?: Record<string, unknown>; header?: Record<string, unknown> } = {};
  const { f } = await api(sa.publicKey, seen);
  const ctx = makeCtx(gdrive, { folder_ids: ["ROOT"] }, { fetch: f, token: sa.json });
  const token = await googleAccessToken(ctx, sa.json, { subject: "admin@acme.example" });
  assertEquals(token, "ya29.test");
  assertEquals(seen.header, { alg: "RS256", typ: "JWT", kid: "k1" });
  const now = Math.floor(new Date("2026-11-24T12:00:00Z").getTime() / 1000);
  assertEquals(seen.claims, {
    iss: "kf@proj.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600, sub: "admin@acme.example",
  });
  // refresh-token JSON and bare tokens
  const f2 = fakeFetch([["POST https://oauth2.googleapis.com/token", ({ body }) => {
    assertEquals(new URLSearchParams(body!).get("grant_type"), "refresh_token");
    return new Response('{"error":"invalid_grant"}', { status: 400 });
  }]]);
  await assertRejects(() => googleAccessToken({ ...ctx, fetch: f2 }, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" })), AuthError);
  assertEquals(await googleAccessToken(ctx, "ya29.raw"), "ya29.raw");
});

Deno.test("gdrive: full sync walks folders, exports Docs as markdown (text/plain fallback), downloads md, skips images", async () => {
  const sa = await serviceAccount();
  const { f } = await api(sa.publicKey, {});
  const changes = await collect(gdrive, makeCtx(gdrive, { folder_ids: ["ROOT"] }, { fetch: f, token: sa.json, full: true }));
  const docs = upserts(changes);
  // ascending modifiedTime
  assertEquals(docs.map((d) => d.externalId), ["MD1", "DOC1", "DOC2", "SHEET1"]);
  const [md, doc1, doc2, sheet] = docs as [typeof docs[0], typeof docs[0], typeof docs[0], typeof docs[0]];
  assertEquals(md.content, "# Runbook\n\nRestart the worker.\n");
  assertEquals(md.version, "2026-11-19T08:00:00.000Z:abc");
  assertEquals(doc1.content, "# Pricing FAQ\n\n**Q:** Do we discount nonprofits?\n\n**A:** Yes, 20%.\n");
  assertEquals([doc1.raw?.ext, doc1.metadata?.export, doc1.author], ["md", "text/markdown", "Pat Lee"]);
  assertEquals([doc2.content, doc2.metadata?.export], ["Big export as plain text.", "text/plain"]);
  assertEquals(sheet.content, "# Quotas\n\nrep,quota\nann,100\n");
  // ACL: shared with a group -> restricted, refs carry folder chain + group; domain-wide -> not restricted
  assertEquals(doc1.acl, { restricted: true, refs: [{ gdrive_folder: "ROOT" }, { google_group: "sales@acme.example" }] });
  assertEquals(doc2.acl, { restricted: false, refs: [{ gdrive_folder: "SUB1" }, { gdrive_folder: "ROOT" }] });
  assertEquals(sheet.acl, { restricted: true, refs: [{ gdrive_folder: "ROOT" }, { gdrive_drive: "DRIVE9" }] });
  const snap = changes.find((c) => c.type === "snapshot");
  assertEquals(snap?.type === "snapshot" && snap.externalIds.length, 5);
  assertEquals(lastCursor(changes)?.cursor, { since: "2026-11-22T08:00:00.000Z", changes_token: "tok-1" });
  assert(f.calls.every((c) => c.url.includes("oauth2") || c.headers.get("authorization") === "Bearer ya29.test"));
});

Deno.test("gdrive: incremental sync filters by modifiedTime and applies the changes feed", async () => {
  const sa = await serviceAccount();
  const { f } = await api(sa.publicKey, {});
  const ctx = makeCtx(gdrive, { folder_ids: ["ROOT"] }, {
    fetch: f, token: sa.json,
    cursor: { since: "2026-11-21T00:00:00.000Z", changes_token: "tok-1" },
    previous: { GONE1: {}, TRASH1: {}, MOVED1: {}, MD1: {}, "DOC2": { version: "2026-11-21T08:00:00.000Z" } },
  });
  const changes = await collect(gdrive, ctx);
  const deletes = changes.flatMap((c) => (c.type === "delete" ? [c.externalId] : []));
  assertEquals(deletes, ["GONE1", "TRASH1", "MOVED1"]);
  assertEquals(upserts(changes).map((d) => d.externalId), ["SHEET1"]); // DOC2 unchanged (same version)
  assertEquals(lastCursor(changes)?.cursor, { since: "2026-11-22T08:00:00.000Z", changes_token: "tok-2" });
});

Deno.test("gdrive: kinds and ACL helpers", () => {
  assertEquals(driveKind({ mimeType: "application/octet-stream", name: "notes.MD" }), "markdown");
  assertEquals(driveKind({ mimeType: "application/pdf", name: "x.pdf" }, false), null);
  assertEquals(driveAcl({ id: "x", name: "x", mimeType: "text/plain", modifiedTime: "" }, []).restricted, true);
});
