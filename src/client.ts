import { COMMANDS, invoke as upstreamInvoke } from "./contract";
import { AuthError, ServerError, UsageError, WfError } from "./errors";
import { PROFILE_HINT } from "./shims/session";
import {
  clearSession,
  loadConfig,
  loadSession,
  normalizeUrl,
  saveSession,
  type Config,
  type Session,
} from "./store";
import {
  send,
  setTransport,
  SESSION_COOKIE,
  parseSetCookies,
  type TransportState,
} from "./transport";

const API = "/api/v1";

export interface ProfileSummary {
  id: string;
  name: string;
  lockEnabled: boolean;
  [key: string]: unknown;
}

export interface ProfileState {
  profiles: ProfileSummary[];
  session: { profileId: string; scopeId: string } | null;
  [key: string]: unknown;
}

export interface AuthStatus {
  requiresPassword: boolean;
  oidcEnabled: boolean;
}

export interface OpenOptions {
  /** --url flag; wins over WF_URL and the config file. */
  url?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveUrl(flag: string | undefined, env: NodeJS.ProcessEnv, config: Config) {
  const raw = flag || env.WF_URL || config.url;
  if (!raw) {
    throw new UsageError(
      "No server URL configured.",
      "Run `wf login --url <server>`, or set WF_URL.",
    );
  }
  return normalizeUrl(raw);
}

/** One server connection: resolved URL, cached session, and the shared transport. */
export class Client {
  readonly state: TransportState;
  private readonly persist: boolean;

  constructor(
    readonly url: string,
    readonly config: Config,
    session: Session | undefined,
    envToken?: string,
  ) {
    const cached = session?.url === url ? session : undefined;
    this.state = {
      baseUrl: url,
      token: envToken ?? cached?.token,
      scopeId: cached?.scopeId,
      browserId: cached?.browserId,
    };
    this.profileId = cached?.profileId;
    // A token from WF_TOKEN stays in the environment, never on disk.
    this.persist = envToken === undefined;
    setTransport({ state: this.state, onChange: () => this.save() });
  }

  profileId?: string;

  static open({ url, env = process.env }: OpenOptions = {}): Client {
    const config = loadConfig();
    return new Client(
      resolveUrl(url, env, config),
      config,
      loadSession(),
      env.WF_TOKEN || undefined,
    );
  }

  save(): void {
    if (!this.persist) return;
    saveSession({
      url: this.url,
      token: this.state.token,
      scopeId: this.state.scopeId,
      profileId: this.profileId,
      browserId: this.state.browserId,
    });
  }

  clear(): void {
    this.state.token = undefined;
    this.state.scopeId = undefined;
    this.profileId = undefined;
    if (this.persist) clearSession();
  }

  /** Runs one command from the vendored COMMANDS map through upstream invoke. */
  async invoke<T = unknown>(command: string, payload?: Record<string, unknown>): Promise<T> {
    if (!Object.hasOwn(COMMANDS, command)) {
      throw new UsageError(`Unknown command: ${command}`, "Run `wf commands` to list commands.");
    }
    // Upstream logs every failure with console.error; the CLI reports it once.
    const consoleError = console.error;
    if (!process.env.WF_DEBUG) console.error = () => {};
    try {
      return await upstreamInvoke<T>(command, payload);
    } catch (error) {
      throw toWfError(error, command);
    } finally {
      console.error = consoleError;
    }
  }

  async authStatus(): Promise<AuthStatus> {
    return this.json<AuthStatus>(await send(`${API}/auth/status`));
  }

  /** True when the server accepts the cached token (or needs none). */
  async isAuthenticated(): Promise<boolean> {
    const res = await send(`${API}/auth/me`);
    if (res.status === 401) return false;
    await this.json(res);
    return true;
  }

  async login(password: string): Promise<void> {
    this.clear();
    const res = await send(`${API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.status === 401) throw new AuthError("Wrong password.");
    if (res.status === 429) {
      throw new ServerError("Too many login attempts. The server allows 5 per minute.", 429);
    }
    await this.json(res);
    // send() already stored the token from Set-Cookie; check that it came.
    if (!this.state.token) {
      const names = [...parseSetCookies(res.headers).keys()].join(", ") || "none";
      throw new AuthError(
        `Login succeeded but the response had no ${SESSION_COOKIE} cookie (cookies: ${names}).`,
        "A proxy may strip Set-Cookie. Use `wf login --token <jwt>` instead.",
      );
    }
    this.save();
  }

  async loginWithToken(token: string): Promise<void> {
    this.clear();
    this.state.token = token;
    if (!(await this.isAuthenticated())) {
      this.state.token = undefined;
      throw new AuthError("The server rejected the token.");
    }
    this.save();
  }

  async logout(): Promise<void> {
    try {
      if (this.state.token) await send(`${API}/auth/logout`, { method: "POST" });
    } finally {
      this.clear();
    }
  }

  /** POST /api/v1/profiles/{command}. These commands are not in COMMANDS. */
  async profileCommand<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
    const res = await send(
      `${API}/profiles/${command}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      { scoped: true },
    );
    if (res.status === 423) {
      const text = (await res.text()).trim();
      if (text.startsWith("PROFILE_")) throw new AuthError(text, PROFILE_HINT);
      throw new ServerError(text || "Profile request failed", 423);
    }
    return this.json<T>(res);
  }

  async profileState(): Promise<ProfileState> {
    return this.profileCommand<ProfileState>("get_profile_state");
  }

  /**
   * Gets a profile session after login. The server opens one on its own when
   * it has exactly one profile without a password. Otherwise, the configured
   * profile is unlocked when it needs no password.
   */
  async ensureProfile(): Promise<ProfileState> {
    const state = await this.profileState();
    if (state.session) {
      this.adopt(state.session);
      return state;
    }
    const wanted = this.config.profile;
    const target = wanted
      ? state.profiles.find((p) => p.id === wanted || p.name === wanted)
      : undefined;
    if (target && !target.lockEnabled) {
      await this.unlockProfile(target.id);
      return { ...state, session: { profileId: target.id, scopeId: this.state.scopeId! } };
    }
    return state;
  }

  async unlockProfile(profileId: string, password?: string): Promise<void> {
    const session = await this.profileCommand<{ profileId: string; scopeId: string }>(
      "unlock_profile",
      { profileId, ...(password === undefined ? {} : { proof: password }) },
    );
    this.adopt(session);
  }

  async lockProfile(): Promise<void> {
    await this.profileCommand<null>("lock_profile");
    this.state.scopeId = undefined;
    this.profileId = undefined;
    this.save();
  }

  private adopt(session: { profileId: string; scopeId: string }): void {
    this.state.scopeId = session.scopeId;
    this.profileId = session.profileId;
    this.save();
  }

  private async json<T = unknown>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401)
        throw new AuthError("Not logged in, or the session expired.", "Run `wf login`.");
      throw new ServerError(errorMessage(text) || res.statusText, res.status);
    }
    if (res.headers.get("content-type")?.includes("text/html")) {
      throw new AuthError(
        "The server returned an HTML page instead of JSON.",
        "Check the server URL. A proxy sign-in page may be in front of it.",
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function errorMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  } catch {
    // plain-text error body
  }
  return text.trim();
}

export function toWfError(error: unknown, command: string): WfError {
  if (
    error instanceof ServerError &&
    !error.hint &&
    (error.status === 400 || error.status === 422)
  ) {
    return new ServerError(
      error.message,
      error.status,
      `Check the payload with \`wf schema ${command}\`.`,
    );
  }
  if (error instanceof WfError) return error;
  // The vendored switch reads payload keys directly, so a missing key is a TypeError.
  if (error instanceof TypeError) {
    return new UsageError(
      `Bad arguments for ${command}: ${error.message}`,
      `Check the payload with \`wf schema ${command}\`.`,
    );
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return new ServerError(`${command} timed out.`);
    return new ServerError(error.message);
  }
  return new ServerError(String(error));
}
