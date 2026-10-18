import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./errors";

export interface Config {
  /** Server root, for example https://wf.example.com */
  url?: string;
  /** Profile to unlock after login when the server has several. */
  profile?: string;
}

/** Cached login state. Never holds the password. */
export interface Session {
  url: string;
  token?: string;
  scopeId?: string;
  profileId?: string;
  browserId?: string;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WF_CONFIG_DIR) return env.WF_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "wf");
}

const configPath = () => join(configDir(), "config.json");
const sessionPath = () => join(configDir(), "session.json");

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new UsageError(`Cannot parse ${path}. Fix or delete the file.`);
  }
}

function writeJson(path: string, value: unknown, mode: number): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode });
  // writeFileSync keeps the old mode of an existing file.
  chmodSync(path, mode);
}

export function loadConfig(): Config {
  return readJson<Config>(configPath()) ?? {};
}

export function saveConfig(config: Config): void {
  writeJson(configPath(), config, 0o644);
}

export function loadSession(): Session | undefined {
  return readJson<Session>(sessionPath());
}

export function saveSession(session: Session): void {
  writeJson(sessionPath(), session, 0o600);
}

export function clearSession(): void {
  rmSync(sessionPath(), { force: true });
}

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(
      `Invalid server URL: ${raw}`,
      "Use a full URL, for example http://localhost:8088",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`Server URL must use http or https: ${raw}`);
  }
  // Accept a pasted .../api/v1 and keep any reverse-proxy path prefix.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${url.origin}${path}`;
}
