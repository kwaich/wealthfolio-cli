import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Client } from "../../src/client";
import { AuthError } from "../../src/errors";
import { BASE, json, mockFetch, run, text, useTempConfig } from "../helpers";

const cfg = useTempConfig();
const sessionFile = () => join(cfg.dir(), "session.json");
const readSession = () =>
  JSON.parse(readFileSync(sessionFile(), "utf8")) as Record<string, unknown>;
const writeSession = (s: Record<string, unknown>) =>
  writeFileSync(sessionFile(), JSON.stringify({ url: BASE, ...s }));

const PROFILE = { id: "p1", name: "Personal", lockEnabled: false };

function server(overrides: Partial<Record<string, () => Response>> = {}) {
  return mockFetch((req) => {
    const key = `${req.method} ${req.path}`;
    if (overrides[key]) return overrides[key]!();
    switch (key) {
      case "GET /api/v1/auth/status":
        return json({ requiresPassword: true, oidcEnabled: false });
      case "POST /api/v1/auth/login":
        return (req.body as { password: string }).password === "secret"
          ? json(
              { authenticated: true, expiresIn: 3600 },
              { cookies: ["wf_session=jwt-1; HttpOnly; SameSite=Lax; Path=/api; Max-Age=3600"] },
            )
          : json({ error: "Invalid password" }, { status: 401 });
      case "POST /api/v1/profiles/get_profile_state":
        return json({
          profiles: [PROFILE],
          session: { profileId: "p1", scopeId: "scope-1" },
          starting: false,
        });
      case "GET /api/v1/auth/me":
        return req.headers.authorization
          ? json({ authenticated: true })
          : json({}, { status: 401 });
      default:
        return json([]);
    }
  });
}

describe("wf login", () => {
  it("takes the JWT from Set-Cookie, not the body, and caches it with mode 0600", async () => {
    vi.stubEnv("WF_PASSWORD", "secret");
    const seen = server();
    const res = await run("login");
    expect(res.code).toBe(0);
    expect(res.json()).toMatchObject({ authenticated: true, profile: { id: "p1" } });
    const login = seen.find((r) => r.path === "/api/v1/auth/login")!;
    expect(login.body).toEqual({ password: "secret" });
    const session = readSession();
    expect(session).toMatchObject({
      url: BASE,
      token: "jwt-1",
      scopeId: "scope-1",
      profileId: "p1",
    });
    expect(statSync(sessionFile()).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(session)).not.toContain("secret");
  });

  it("sends the cached token as Bearer on profile requests after login", async () => {
    vi.stubEnv("WF_PASSWORD", "secret");
    const seen = server();
    await run("login");
    const state = seen.find((r) => r.path === "/api/v1/profiles/get_profile_state")!;
    expect(state.headers.authorization).toBe("Bearer jwt-1");
  });

  it("exits 3 on a wrong password", async () => {
    vi.stubEnv("WF_PASSWORD", "nope");
    server();
    const res = await run("login");
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("Wrong password");
  });

  it("exits 3 when the login response has no wf_session cookie", async () => {
    vi.stubEnv("WF_PASSWORD", "secret");
    server({ "POST /api/v1/auth/login": () => json({ authenticated: true, expiresIn: 60 }) });
    const res = await run("login");
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("no wf_session cookie");
  });

  it("accepts --token and checks it with /auth/me", async () => {
    const seen = server();
    const res = await run("login", "--token", "pasted-jwt");
    expect(res.code).toBe(0);
    expect(seen.find((r) => r.path === "/api/v1/auth/me")!.headers.authorization).toBe(
      "Bearer pasted-jwt",
    );
    expect(readSession().token).toBe("pasted-jwt");
  });

  it("saves --url to the config file", async () => {
    vi.stubEnv("WF_URL", "");
    vi.stubEnv("WF_PASSWORD", "secret");
    server();
    await run("--url", `${BASE}/api/v1/`, "login");
    expect(JSON.parse(readFileSync(join(cfg.dir(), "config.json"), "utf8"))).toEqual({ url: BASE });
  });

  it("unlocks the configured profile when the server opens none", async () => {
    vi.stubEnv("WF_PASSWORD", "secret");
    writeFileSync(join(cfg.dir(), "config.json"), JSON.stringify({ profile: "Work" }));
    const seen = server({
      "POST /api/v1/profiles/get_profile_state": () =>
        json({
          profiles: [PROFILE, { id: "p2", name: "Work", lockEnabled: false }],
          session: null,
        }),
      "POST /api/v1/profiles/unlock_profile": () => json({ profileId: "p2", scopeId: "scope-2" }),
    });
    const res = await run("login");
    expect(res.json()).toMatchObject({ profile: { id: "p2", name: "Work" } });
    expect(seen.find((r) => r.path.endsWith("/unlock_profile"))!.body).toEqual({ profileId: "p2" });
    expect(readSession().scopeId).toBe("scope-2");
  });

  it("lists profiles when several exist and none is chosen", async () => {
    vi.stubEnv("WF_PASSWORD", "secret");
    server({
      "POST /api/v1/profiles/get_profile_state": () =>
        json({ profiles: [PROFILE, { id: "p2", name: "Work", lockEnabled: true }], session: null }),
    });
    const res = await run("login");
    expect(res.json()).toMatchObject({ profile: null, profiles: [{ id: "p1" }, { id: "p2" }] });
  });
});

describe("session refresh and profile header", () => {
  it("replaces the cached token when a response carries a refreshed Set-Cookie", async () => {
    writeSession({ token: "old", scopeId: "scope-1" });
    mockFetch(() => json([], { cookies: ["wf_session=new; HttpOnly; Path=/api; Max-Age=3600"] }));
    expect((await run("call", "get_accounts")).code).toBe(0);
    expect(readSession().token).toBe("new");
  });

  it("ignores a cleared cookie (empty value)", async () => {
    writeSession({ token: "keep" });
    mockFetch(() => json([], { cookies: ["wf_session=; Path=/api; Max-Age=0"] }));
    await run("call", "get_accounts");
    expect(readSession().token).toBe("keep");
  });

  it("sends x-wf-profile-scope with the cached scope", async () => {
    writeSession({ token: "t", scopeId: "scope-9" });
    const seen = mockFetch(() => json([]));
    await run("call", "get_accounts");
    expect(seen[0]!.headers["x-wf-profile-scope"]).toBe("scope-9");
    expect(seen[0]!.headers.authorization).toBe("Bearer t");
  });

  it("omits the profile header when no scope is cached", async () => {
    writeSession({ token: "t" });
    const seen = mockFetch(() => json([]));
    await run("call", "get_accounts");
    expect(seen[0]!.headers["x-wf-profile-scope"]).toBeUndefined();
  });

  it("captures and resends the wf_browser owner cookie of a no-auth server", async () => {
    const seen = mockFetch(() =>
      json([], { cookies: ["wf_browser=b-1; Path=/; HttpOnly; SameSite=Strict"] }),
    );
    await run("call", "get_accounts");
    await run("call", "get_accounts");
    expect(seen[1]!.headers.cookie).toBe("wf_browser=b-1");
  });

  it("ignores a session cached for another server URL", async () => {
    writeFileSync(sessionFile(), JSON.stringify({ url: "http://other", token: "x" }));
    const seen = mockFetch(() => json([]));
    await run("call", "get_accounts");
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it("uses WF_TOKEN without writing it to disk", async () => {
    vi.stubEnv("WF_TOKEN", "env-token");
    const seen = mockFetch(() => json([], { cookies: ["wf_session=refreshed; Path=/api"] }));
    await run("call", "get_accounts");
    expect(seen[0]!.headers.authorization).toBe("Bearer env-token");
    expect(() => readSession()).toThrow();
  });
});

describe("auth failures", () => {
  it("exits 3 on 401", async () => {
    writeSession({ token: "expired" });
    mockFetch(() => json({ error: "Token expired" }, { status: 401 }));
    const res = await run("call", "get_accounts");
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("wf login");
  });

  it("exits 3 with the server text on PROFILE_LOCKED (423)", async () => {
    writeSession({ token: "t" });
    mockFetch(() => text("PROFILE_LOCKED", 423));
    const res = await run("call", "get_accounts");
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("PROFILE_LOCKED");
    expect(res.stderr).toContain("wf profile use");
  });

  it("exits 3 when a proxy answers with an HTML sign-in page", async () => {
    mockFetch(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
    const res = await run("call", "get_accounts");
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("HTML");
  });

  it("exits 1 when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    const res = await run("call", "get_accounts");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Cannot reach");
  });

  it("Client.login rejects a 401 with AuthError", async () => {
    server();
    const client = new Client(BASE, {}, undefined);
    await expect(client.login("bad")).rejects.toBeInstanceOf(AuthError);
  });
});

describe("wf profile", () => {
  it("use: unlocks a locked profile with WF_PROFILE_PASSWORD as proof", async () => {
    writeSession({ token: "t" });
    vi.stubEnv("WF_PROFILE_PASSWORD", "pp");
    const seen = server({
      "POST /api/v1/profiles/get_profile_state": () =>
        json({ profiles: [{ id: "p2", name: "Work", lockEnabled: true }], session: null }),
      "POST /api/v1/profiles/unlock_profile": () => json({ profileId: "p2", scopeId: "s2" }),
    });
    const res = await run("profile", "use", "Work");
    expect(res.code).toBe(0);
    expect(seen.find((r) => r.path.endsWith("/unlock_profile"))!.body).toEqual({
      profileId: "p2",
      proof: "pp",
    });
    expect(readSession()).toMatchObject({ scopeId: "s2", profileId: "p2" });
  });

  it("use: exits 2 for an unknown profile", async () => {
    writeSession({ token: "t" });
    server();
    expect((await run("profile", "use", "nope")).code).toBe(2);
  });

  it("lock: clears the cached scope", async () => {
    writeSession({ token: "t", scopeId: "s1", profileId: "p1" });
    server({ "POST /api/v1/profiles/lock_profile": () => json(null) });
    expect((await run("profile", "lock")).code).toBe(0);
    expect(readSession().scopeId).toBeUndefined();
  });
});

describe("wf logout", () => {
  it("posts /auth/logout and deletes the session file", async () => {
    writeSession({ token: "t" });
    const seen = mockFetch(() => new Response(null, { status: 204 }));
    expect((await run("logout")).code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/v1/auth/logout" });
    expect(() => readSession()).toThrow();
  });
});

describe("session file writes", () => {
  it("replaces the file in one step, 0600, with no temporary file left", async () => {
    const { saveSession } = await import("../../src/store");
    writeFileSync(sessionFile(), "{}", { mode: 0o644 });
    saveSession({ url: BASE, token: "t1" });
    expect(statSync(sessionFile()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(sessionFile(), "utf8"))).toEqual({ url: BASE, token: "t1" });
    expect(readdirSync(cfg.dir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("swaps in a new file instead of rewriting the old one in place", async () => {
    const { saveSession } = await import("../../src/store");
    saveSession({ url: BASE, token: "old" });
    const before = statSync(sessionFile()).ino;
    saveSession({ url: BASE, token: "new" });
    // A rename gives a new inode; an in-place write, which a crash can truncate, keeps it.
    expect(statSync(sessionFile()).ino).not.toBe(before);
  });
});
