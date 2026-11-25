import { assert, assertEquals, assertRejects } from "@std/assert";
import { matchAcl, resolveAudience } from "../lib/acl.ts";
import { driveAcl, type DriveFile, driveKind, gdrive } from "../lib/gdrive.ts";
import { googleAccessToken } from "../lib/google-auth.ts";
import { AuthError, ConfigError } from "../lib/types.ts";
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
      const files = fx.files
        .filter((f: Fx) => f.parents.some((p: string) => parents.includes(p)) && (!since || f.modifiedTime >= since))
        .sort((a: Fx, b: Fx) => a.modifiedTime.localeCompare(b.modifiedTime)); // orderBy=modifiedTime
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
  assert(md.version!.startsWith("2026-11-19T08:00:00.000Z:abc#"), "version = modifiedTime:md5#aclHash");
  assertEquals(doc1.content, "# Pricing FAQ\n\n**Q:** Do we discount nonprofits?\n\n**A:** Yes, 20%.\n");
  assertEquals([doc1.raw?.ext, doc1.metadata?.export, doc1.author], ["md", "text/markdown", "Pat Lee"]);
  assertEquals([doc2.content, doc2.metadata?.export], ["Big export as plain text.", "text/plain"]);
  assertEquals(sheet.content, "# Quotas\n\nrep,quota\nann,100\n");
  // ACL: shared with a group -> restricted, group in refs, folder chain as most-specific-first tiers;
  // domain-wide -> not restricted; the shared drive is the last tier
  assertEquals(doc1.acl, { restricted: true, refs: [{ google_group: "sales@acme.example" }], tiers: [[{ gdrive_folder: "ROOT" }]] });
  assertEquals(doc2.acl, { restricted: false, refs: [], tiers: [[{ gdrive_folder: "SUB1" }], [{ gdrive_folder: "ROOT" }]] });
  assertEquals(sheet.acl, { restricted: true, refs: [], tiers: [[{ gdrive_folder: "ROOT" }], [{ gdrive_drive: "DRIVE9" }]] });
  const snap = changes.find((c) => c.type === "snapshot");
  assertEquals(snap?.type === "snapshot" && snap.externalIds.length, 5);
  // next cycle lists from the cycle start (minus a clock-skew margin), not from the newest file seen
  assertEquals(lastCursor(changes)?.cursor, { since: "2026-11-24T11:55:00.000Z", changes_token: "tok-1" });
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
  assertEquals(lastCursor(changes)?.cursor, { since: "2026-11-24T11:55:00.000Z", changes_token: "tok-2" });
});

Deno.test("gdrive: kinds and ACL helpers", () => {
  assertEquals(driveKind({ mimeType: "application/octet-stream", name: "notes.MD" }), "markdown");
  assertEquals(driveKind({ mimeType: "application/pdf", name: "x.pdf" }, false), null);
  assertEquals(driveAcl({ id: "x", name: "x", mimeType: "text/plain", modifiedTime: "" }, []).restricted, true);
});

Deno.test("gdrive: most specific mapped folder wins (no union with broader ancestors)", () => {
  const groups = [
    { id: "g-all", external_ref: { gdrive_folder: "ROOT" } },
    { id: "g-finance", external_ref: { gdrive_folder: "FINANCE_SUB" } },
    { id: "g-drive", external_ref: { gdrive_drive: "DRIVE9" } },
    { id: "g-sales", external_ref: { google_group: "sales@acme.example" } },
  ];
  const file = (perms: DriveFile["permissions"] = [], driveId?: string): DriveFile => ({ id: "F", name: "x", mimeType: "text/plain", modifiedTime: "", permissions: perms, driveId });
  const inFinance = driveAcl(file(), ["FINANCE_SUB", "ROOT"]);
  assertEquals(resolveAudience([], inFinance, groups), { kind: "ok", audience: ["g-finance"], mode: "mapped", groups: ["g-finance"] });
  // unmapped subfolder -> nearest mapped ancestor
  assertEquals(resolveAudience([], driveAcl(file(), ["OTHER_SUB", "ROOT"]), groups).kind === "ok" && matchAcl(driveAcl(file(), ["OTHER_SUB", "ROOT"]), groups), ["g-all"]);
  // shared drive only when no folder matched
  assertEquals(matchAcl(driveAcl(file([], "DRIVE9"), ["UNMAPPED"]), groups), ["g-drive"]);
  assertEquals(matchAcl(driveAcl(file([], "DRIVE9"), ["FINANCE_SUB", "ROOT"]), groups), ["g-finance"]);
  // file shared directly with a group: narrows, never unions; disjoint -> the direct (narrower) group
  const shared = driveAcl(file([{ type: "group", role: "reader", emailAddress: "sales@acme.example" }]), ["FINANCE_SUB", "ROOT"]);
  assertEquals(matchAcl(shared, groups), ["g-sales"]);
  assertEquals(matchAcl(driveAcl(file([{ type: "group", role: "reader", emailAddress: "sales@acme.example" }]), []), groups), ["g-sales"]);
  const both = [...groups, { id: "g-fin-sales", external_ref: { gdrive_folder: "FINANCE_SUB", google_group: "sales@acme.example" } }];
  assertEquals(matchAcl(shared, both), ["g-fin-sales"]); // intersection
});

Deno.test("gdrive: missing token and foreign token_uri are config errors; token errors do not echo bodies", async () => {
  const f = fakeFetch([["POST https://oauth2.googleapis.com/token", () => new Response('{"error":"invalid_grant","error_description":"<secret upstream text>"}', { status: 400 })]]);
  await assertRejects(() => collect(gdrive, makeCtx(gdrive, { folder_ids: ["ROOT"] }, { fetch: f, token: null })), ConfigError, "no token");
  const ctx = makeCtx(gdrive, { folder_ids: ["ROOT"] }, { fetch: f });
  await assertRejects(
    () => googleAccessToken(ctx, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r", token_uri: "http://169.254.169.254/token" })),
    ConfigError,
    "token_uri",
  );
  const err = await assertRejects(() => googleAccessToken(ctx, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" })), AuthError);
  assertEquals(err.message, "google token exchange failed (400 invalid_grant)");
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0]!.url, "https://oauth2.googleapis.com/token");
});

Deno.test("gdrive: permission changes from the changes feed re-sync the file even without a new modifiedTime", async () => {
  const sa = await serviceAccount();
  const { f, fx } = await api(sa.publicKey, {});
  const doc1 = fx.files.find((x: Fx) => x.id === "DOC1");
  // DOC1 (modified 11-20, before `since`) was narrowed: now shared with finance@ only
  fx.changes = { changes: [{ fileId: "DOC1", removed: false, file: { ...doc1, permissions: [{ type: "group", role: "reader", emailAddress: "finance@acme.example" }] } }], newStartPageToken: "tok-3" };
  const ctx = makeCtx(gdrive, { folder_ids: ["ROOT"] }, {
    fetch: f, token: sa.json,
    cursor: { since: "2026-11-23T00:00:00.000Z", changes_token: "tok-2" },
    previous: { DOC1: { version: "2026-11-20T08:00:00.000Z" } }, // legacy version (no ACL hash)
  });
  const changes = await collect(gdrive, ctx);
  const docs = upserts(changes);
  assertEquals(docs.map((d) => d.externalId), ["DOC1"]);
  assertEquals(docs[0]!.acl?.refs, [{ google_group: "finance@acme.example" }]);
  assertEquals((lastCursor(changes)?.cursor as { changes_token: string }).changes_token, "tok-3");
});

Deno.test("gdrive: a capped listing resumes from its page instead of restarting, then commits `since`", async () => {
  const sa = await serviceAccount();
  const { f } = await api(sa.publicKey, {});
  const prev: Record<string, { version: string }> = {};
  let cursor: Record<string, unknown> = {};
  const seen: string[] = [];
  for (let run = 0; run < 6; run++) {
    const changes = await collect(gdrive, makeCtx(gdrive, { folder_ids: ["ROOT"] }, { fetch: f, token: sa.json, cursor, full: run === 0, limit: 1, previous: prev }));
    for (const d of upserts(changes)) {
      seen.push(d.externalId);
      prev[d.externalId] = { version: d.version! };
    }
    const last = lastCursor(changes)!;
    cursor = last.cursor;
    if (!last.more) break;
    assert((cursor as { pending?: unknown }).pending, "capped run keeps its position");
  }
  assertEquals(seen, ["MD1", "DOC1", "DOC2", "SHEET1"]);
  assertEquals(cursor, { since: "2026-11-24T11:55:00.000Z", changes_token: "tok-2" }); // continuations also drain the changes feed
});

Deno.test("gdrive: downloads over max_file_bytes are skipped without buffering them", async () => {
  const sa = await serviceAccount();
  const { f, fx } = await api(sa.publicKey, {});
  delete fx.files.find((x: Fx) => x.id === "MD1").size; // size unknown up front
  fx.media.MD1 = "x".repeat(5000);
  const docs = upserts(await collect(gdrive, makeCtx(gdrive, { folder_ids: ["ROOT"], max_file_bytes: 1000 }, { fetch: f, token: sa.json, full: true })));
  assert(!docs.some((d) => d.externalId === "MD1"));
  assert(docs.some((d) => d.externalId === "DOC1"));
});
