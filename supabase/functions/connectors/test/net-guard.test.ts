import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { readBody, request, TooLargeError } from "../lib/http.ts";
import {
  assertPublicDestination,
  assertPublicUrl,
  BlockedUrlError,
  defaultResolver,
  DnsResolutionError,
  egressProxyFromEnv,
  guardedFetch,
  hostnameProblem,
  isPrivateIp,
  proxiedFetch,
} from "../lib/net-guard.ts";
import { ConfigError, UpstreamError } from "../lib/types.ts";
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

Deno.test("net-guard: SIIT, local-use NAT64, Teredo, benchmarking, ORCHID and documentation IPv6 ranges", () => {
  for (const ip of [
    "::ffff:0:127.0.0.1", "::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "::ffff:0:10.0.0.1", // SIIT with a private IPv4
    "64:ff9b:1::1", "64:ff9b:1::808:808", "64:ff9b:1:ffff::1", // local-use NAT64 /48: blocked whatever it embeds
    "64:ff9b::127.0.0.1", "64:ff9b::a00:1", // well-known NAT64 with a private IPv4
    "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "2001:2::1", "2001:2:0:ffff::1", // benchmarking
    "2001:10::1", "2001:1f:ffff::1", "2001:20::1", "2001:2f::1", // ORCHID / ORCHIDv2
    "2001:db8::1", "3fff::1", "3fff:fff::1", // documentation
    "::1:2:3:4", // rest of ::/64
  ]) assert(isPrivateIp(ip), `${ip} must be private`);
  for (const ip of ["::ffff:0:8.8.8.8", "64:ff9b::8.8.8.8", "2001:4860:4860::8888", "2001:3::1", "2001:30::1", "2001:200::1", "3fff:1000::1"]) {
    assert(!isPrivateIp(ip), `${ip} must be public`);
  }
});

Deno.test("net-guard: trailing dots are stripped and empty labels refused", async () => {
  for (const h of ["localhost.", "localhost..", "localhost...", "kong..", "metadata.google.internal..", "a..example.com", ".example.com", "..", "."]) {
    assert(hostnameProblem(h), `${h} must be blocked`);
  }
  assertEquals(hostnameProblem("docs.acme.example."), null);
  for (const u of ["http://localhost../", "http://kong../", "http://foo.internal../x"]) {
    assertThrows(() => assertPublicUrl(u, { allowPrivate: false }), BlockedUrlError, undefined, u);
  }
  // the resolver gets the name without trailing dots
  const asked: string[] = [];
  await assertPublicDestination("https://docs.acme.example../", { allowPrivate: false, resolve: async (h) => (asked.push(h), ["93.184.216.34"]) });
  assertEquals(asked, ["docs.acme.example"]);
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
});

Deno.test("net-guard: DNS failures fail closed (transient, nothing is fetched)", async () => {
  const inner = fakeFetch([["GET https://unknown.example/", () => new Response("secret")]]);
  for (const resolve of [async () => [], async (): Promise<string[]> => { throw new Error("timeout"); }]) {
    const g = guardedFetch({ fetch: inner, resolve, allowPrivate: false });
    const e = await assertRejects(() => g("https://unknown.example/"), DnsResolutionError);
    assert(!(e instanceof ConfigError), "a DNS hiccup is retried, not a permanent config error");
  }
  assertEquals(inner.calls.length, 0);
  // request() retries it and finally reports an upstream (transient) error
  let slept = 0;
  const ctx = { fetch: guardedFetch({ fetch: inner, resolve: async () => [], allowPrivate: false }), sleep: async () => void slept++, log: () => {}, now: () => new Date() };
  await assertRejects(() => request(ctx, "https://unknown.example/", {}, { retries: 1 }), UpstreamError, "resolves to no address");
  assertEquals([slept, inner.calls.length], [1, 0]);
  // the default resolver: NotFound for one record type is fine, any other failure refuses
  const orig = Deno.resolveDns;
  const stub = (impl: (h: string, t: string) => Promise<string[]>) => ((Deno as unknown as { resolveDns: unknown }).resolveDns = impl);
  try {
    stub(async (_h, t) => {
      if (t === "AAAA") throw new Deno.errors.NotFound("no records");
      return ["93.184.216.34"];
    });
    assertEquals(await defaultResolver("v4only.example"), ["93.184.216.34"]);
    stub(async (_h, t) => {
      if (t === "AAAA") throw new Error("timed out");
      return ["93.184.216.34"];
    });
    await assertRejects(() => defaultResolver("flaky.example"), Error, "timed out");
    stub(async () => {
      throw new Deno.errors.NotFound("nxdomain");
    });
    assertEquals(await defaultResolver("nx.example"), []);
    await assertRejects(() => assertPublicDestination("https://nx.example/", { allowPrivate: false }), DnsResolutionError);
  } finally {
    (Deno as unknown as { resolveDns: unknown }).resolveDns = orig;
  }
});

Deno.test("net-guard: DNS rebinding after the check discards the response", async () => {
  let cancelled = false;
  const inner = fakeFetch([["GET https://rebind.example/", () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))]]);
  let lookups = 0;
  // first answer public (pre-check), then the name flips to the metadata address (what fetch connected to)
  const resolve = async () => (++lookups === 1 ? ["93.184.216.34"] : ["169.254.169.254"]);
  const f = guardedFetch({ fetch: inner, resolve, allowPrivate: false });
  await assertRejects(() => f("https://rebind.example/"), BlockedUrlError, "169.254.169.254");
  assertEquals(inner.calls.length, 1);
  assert(cancelled, "the response body is cancelled, never handed to the caller");
  // a name that stops resolving after the fetch is refused too
  let n = 0;
  const g = guardedFetch({ fetch: inner, resolve: async () => (++n === 1 ? ["93.184.216.34"] : []), allowPrivate: false });
  await assertRejects(() => g("https://rebind.example/"), DnsResolutionError);
  // stable public answers pass (checked before and after)
  let m = 0;
  const h = guardedFetch({ fetch: fakeFetch([["GET https://ok.example/", () => new Response("ok")]]), resolve: async () => (m++, ["93.184.216.34"]), allowPrivate: false });
  assertEquals(await (await h("https://ok.example/")).text(), "ok");
  assertEquals(m, 2);
});

Deno.test("net-guard: KF_CONNECTORS_EGRESS_PROXY routes every request through Deno.createHttpClient({ proxy })", async () => {
  const created: unknown[] = [];
  const seen: unknown[] = [];
  const pf = proxiedFetch("http://user:p%40ss@egress.internal:4750", {
    createHttpClient: (o) => (created.push(o), { client: 1 }),
    fetch: async (_i, init) => (seen.push((init as { client?: unknown }).client), new Response("ok")),
  });
  await pf("https://a.example/");
  await pf("https://b.example/");
  assertEquals(created, [{ proxy: { url: "http://egress.internal:4750/", basicAuth: { username: "user", password: "p@ss" } } }]);
  assertEquals(seen, [{ client: 1 }, { client: 1 }]);
  // without createHttpClient the proxy is never bypassed silently
  const none = proxiedFetch("http://egress.internal:4750", { createHttpClient: undefined as never, fetch: async () => new Response("direct") });
  const orig = (Deno as unknown as { createHttpClient?: unknown }).createHttpClient;
  try {
    (Deno as unknown as { createHttpClient?: unknown }).createHttpClient = undefined;
    await assertRejects(() => none("https://a.example/"), ConfigError, "createHttpClient");
  } finally {
    (Deno as unknown as { createHttpClient?: unknown }).createHttpClient = orig;
  }
  // the env var is read by guardedFetch() when no fetch is injected
  Deno.env.set("KF_CONNECTORS_EGRESS_PROXY", " http://egress.internal:4750 ");
  try {
    assertEquals(egressProxyFromEnv(), "http://egress.internal:4750");
  } finally {
    Deno.env.delete("KF_CONNECTORS_EGRESS_PROXY");
  }
  assertEquals(egressProxyFromEnv(), null);
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
