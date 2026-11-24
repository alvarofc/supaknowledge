import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { readBody, request, TooLargeError } from "../lib/http.ts";
import { assertPublicUrl, BlockedUrlError, guardedFetch, hostnameProblem, isPrivateIp } from "../lib/net-guard.ts";
import { ConfigError } from "../lib/types.ts";
import { fakeFetch } from "./helpers.ts";

const publicDns = async () => ["93.184.216.34"];

Deno.test("net-guard: IP classification (v4, v6, mapped, NAT64, 6to4)", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "[::1]", "::127.0.0.1",
  ]) assert(isPrivateIp(ip), `${ip} must be private`);
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "100.128.0.1"]) {
    assert(!isPrivateIp(ip), `${ip} must be public`);
  }
});

Deno.test("net-guard: internal hostnames and URL forms are refused without DNS", () => {
  for (const h of ["kong", "inbucket", "db", "localhost", "foo.localhost", "metadata.google.internal", "printer.local", "svc.default.svc", "nas.home.arpa"]) {
    assert(hostnameProblem(h), `${h} must be blocked`);
  }
  assertEquals(hostnameProblem("docs.acme.example"), null);
  for (const u of ["http://169.254.169.254/latest/meta-data/", "http://2130706433/", "http://0x7f.1/", "http://[::ffff:127.0.0.1]/", "http://kong:8000/rest/v1/", "file:///etc/passwd", "https://user:pw@example.com/"]) {
    assertThrows(() => assertPublicUrl(u, { allowPrivate: false }), BlockedUrlError, undefined, u);
  }
  assertThrows(() => assertPublicUrl("http://api.example.com", { requireHttps: true, allowPrivate: false }), BlockedUrlError, "https is required");
  assertEquals(assertPublicUrl("https://docs.acme.example/x", { allowPrivate: false }).hostname, "docs.acme.example");
  // dev escape hatch
  assertEquals(assertPublicUrl("http://kong:8000/", { allowPrivate: true }).hostname, "kong");
});

Deno.test("net-guard: DNS answers pointing at private space are refused", async () => {
  const inner = fakeFetch([["GET https://rebind.example/", () => new Response("secret")]]);
  const f = guardedFetch({ fetch: inner, resolve: async () => ["10.0.0.5"], allowPrivate: false });
  await assertRejects(() => f("https://rebind.example/"), BlockedUrlError, "10.0.0.5");
  assertEquals(inner.calls.length, 0);
  // unresolvable / unsupported DNS falls back to the hostname checks
  const g = guardedFetch({ fetch: inner, resolve: async () => [], allowPrivate: false });
  assertEquals(await (await g("https://rebind.example/")).text(), "secret");
});

Deno.test("net-guard: redirects are followed manually and every hop is re-validated", async () => {
  const inner = fakeFetch([
    ["GET https://public.example/a", () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })],
    ["GET https://public.example/b", () => new Response(null, { status: 301, headers: { location: "https://other.example/c" } })],
    ["GET https://other.example/c", () => new Response("ok")],
    ["GET https://public.example/loop", () => new Response(null, { status: 302, headers: { location: "/loop" } })],
  ]);
  const f = guardedFetch({ fetch: inner, resolve: publicDns, allowPrivate: false });
  await assertRejects(() => f("https://public.example/a"), BlockedUrlError, "169.254.169.254");
  assert(!inner.calls.some((c) => c.url.includes("169.254")), "metadata endpoint never contacted");

  const res = await f("https://public.example/b", { headers: { authorization: "Bearer t", "user-agent": "x" } });
  assertEquals(await res.text(), "ok");
  const hop = inner.calls.find((c) => c.url === "https://other.example/c")!;
  assertEquals(hop.headers.get("authorization"), null, "credentials dropped on cross-origin hop");
  assertEquals(hop.headers.get("user-agent"), "x");

  await assertRejects(() => f("https://public.example/loop"), TypeError, "too many redirects");
  // redirect: manual hands the 3xx back to the caller
  assertEquals((await f("https://public.example/b", { redirect: "manual" })).status, 301);
});

Deno.test("net-guard: credentials only over https", async () => {
  const inner = fakeFetch([["GET http://plain.example/", () => new Response("ok")]]);
  const f = guardedFetch({ fetch: inner, resolve: publicDns, allowPrivate: false });
  await assertRejects(() => f("http://plain.example/", { headers: { Authorization: "Bearer t" } }), BlockedUrlError, "https is required");
  assertEquals(await (await f("http://plain.example/")).text(), "ok");
});

Deno.test("http: blocked requests are not retried; bodies are read with a byte cap", async () => {
  const inner = fakeFetch([]);
  const f = guardedFetch({ fetch: inner, resolve: publicDns, allowPrivate: false });
  let slept = 0;
  const ctx = { fetch: f, sleep: async () => void slept++, log: () => {}, now: () => new Date() };
  await assertRejects(() => request(ctx, "http://127.0.0.1:54321/rest/v1/"), ConfigError);
  assertEquals(slept, 0);

  await assertRejects(() => readBody(new Response("x".repeat(100)), 10), TooLargeError);
  await assertRejects(() => readBody(new Response("x", { headers: { "content-length": "999999" } }), 10), TooLargeError);
  assertEquals((await readBody(new Response("abc"), 10)).length, 3);
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(1024)); // endless body
    },
  });
  await assertRejects(() => readBody(new Response(stream), 4096), TooLargeError);
});
