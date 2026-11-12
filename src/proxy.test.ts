import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the proxy returns — including redirects.
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { proxy } = await import("./proxy");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  refreshedCookies = [];
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("proxy — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await proxy(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await proxy(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await proxy(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await proxy(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});


describe("proxy — dashboard API mutation protection", () => {
  function mutation(headers: HeadersInit = {}, method = "POST", path = "/api/account/invitations") {
    return new NextRequest("https://crm.example.test" + path, { method, headers });
  }

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];
  });

  it.each([
    ["https://attacker.test", "cross-site"],
    ["https://sibling.example.test", "same-site"],
    ["https://crm.example.test", "cross-site"],
    ["null", "same-origin"],
  ])("blocks origin %s with Fetch Metadata %s before session refresh", async (origin, site) => {
    const result = await proxy(mutation({
      origin,
      "sec-fetch-site": site,
      referer: "https://crm.example.test/dashboard",
      "content-type": "application/json",
      cookie: "sb-test-auth-token=session",
    }));
    expect(result.status).toBe(403);
    expect(result.cookies.get(ROTATED.name)).toBeUndefined();
  });

  it("rejects missing origin evidence and ignores untrusted forwarded headers", async () => {
    expect((await proxy(mutation({ "sec-fetch-site": "same-origin" }))).status).toBe(403);
    expect((await proxy(mutation({
      origin: "https://attacker.test",
      "x-forwarded-host": "attacker.test",
      "x-forwarded-proto": "https",
    }))).status).toBe(403);
  });

  it("accepts the canonical public origin even behind a reverse proxy", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://crm.example.test/");
    const result = await proxy(new NextRequest("http://localhost:3000/api/account/invitations", {
      method: "POST",
      headers: {
        origin: "https://crm.example.test",
        "content-type": "application/json; charset=utf-8",
      },
    }));
    expect(result.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("accepts a same-origin Referer when Origin is absent, including bodyless actions", async () => {
    const result = await proxy(mutation({
      referer: "https://crm.example.test/settings",
      "sec-fetch-site": "same-origin",
      "content-length": "0",
    }, "DELETE"));
    expect(result.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it.each([
    ["content-type", "text/plain;charset=UTF-8"],
    ["content-type", "multipart/form-data; boundary=boundary"],
    ["content-length", "5"],
  ])("rejects unsupported %s: %s", async (header, value) => {
    const result = await proxy(mutation({
      origin: "https://crm.example.test",
      [header]: value,
    }));
    expect(result.status).toBe(415);
    expect(result.cookies.get(ROTATED.name)).toBeUndefined();
  });

  it.each([
    "/api/v1/messages",
    "/api/automations/cron",
    "/api/flows/cron",
    "/api/whatsapp/ingress/cron",
    "/api/whatsapp/webhook",
    "/api/whatsapp/ycloud/webhook",
    "/api/webhooks/zapsign/secret",
  ])("leaves independent authentication to %s", async (path) => {
    const result = await proxy(mutation({ "content-type": "text/plain" }, "POST", path));
    expect(result.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("does not treat unrelated cookie routes as independently authenticated", async () => {
    const result = await proxy(mutation({}, "POST", "/api/whatsapp/config/webhook"));
    expect(result.status).toBe(403);
  });

  it("allows reads without Origin or Referer", async () => {
    const result = await proxy(mutation({}, "GET"));
    expect(result.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});
