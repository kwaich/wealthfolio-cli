// Waits for the server's background portfolio job through its event stream
// (GET /api/v1/events/stream, server-sent events), as the web app does.
import { AuthError, ServerError } from "./errors";
import { PROFILE_HINT } from "./shims/session";
import { send } from "./transport";

const EVENTS_PATH = "/api/v1/events/stream";

interface ServerEvent {
  name: string;
  data: unknown;
}

/** Splits an SSE byte stream into events. Comments (keep-alives) are skipped. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let name = "message";
  let data: string[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length) yield { name, data: parseData(data.join("\n")) };
          name = "message";
          data = [];
        } else if (line.startsWith(":")) {
          continue;
        } else {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") name = value;
          else if (field === "data") data.push(value);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** The skip list names an asset id and a reason per skipped asset, around 2 KB, and never changes the outcome. */
function withoutSkipped(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const rest: Record<string, unknown> = { ...data };
  delete rest.skipped_reasons;
  delete rest.show_skipped_reasons;
  return rest;
}

function parseData(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface WaitResult {
  /** complete: the portfolio was recalculated. error: the job failed. timeout: no result in time. */
  status: "complete" | "error" | "timeout";
  seconds: number;
  /** The job's error payload (portfolio:update-error or market:sync-error). */
  error?: unknown;
  /** market:sync-complete payload, when the job synced quotes. */
  marketSync?: unknown;
}

interface Watch {
  /** Resolves when the portfolio job that starts after this call finishes. */
  done(timeoutMs: number): Promise<WaitResult>;
  close(): void;
}

/**
 * Opens the event stream. Call it before the write, so the job's events
 * cannot be missed, then call done() after the write.
 */
export async function watchPortfolio(): Promise<Watch> {
  const controller = new AbortController();
  const res = await send(
    EVENTS_PATH,
    {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    },
    { scoped: true },
  );
  if (!res.ok || !res.body) {
    controller.abort();
    if (res.status === 401) {
      throw new AuthError("Not logged in, or the session expired.", "Run `wf login`.");
    }
    if (res.status === 423) {
      const text = (await res.text()).trim();
      if (text.startsWith("PROFILE_")) throw new AuthError(text, PROFILE_HINT);
    }
    throw new ServerError(
      `Cannot open the event stream (${res.status} ${res.statusText}).`,
      res.status,
    );
  }
  const events = parseSse(res.body);
  const started = Date.now();

  async function follow(): Promise<WaitResult> {
    const seconds = () => Math.round((Date.now() - started) / 100) / 10;
    let running = false;
    let marketSync: unknown;
    let marketError: unknown;
    for await (const event of events) {
      switch (event.name) {
        case "market:sync-complete":
          marketSync = withoutSkipped(event.data);
          break;
        case "market:sync-error":
          marketError = event.data;
          break;
        case "portfolio:update-start":
          running = true;
          break;
        case "portfolio:update-complete":
          // A job that was already running when the stream opened does not count.
          if (running) {
            return {
              status: "complete",
              seconds: seconds(),
              ...(marketSync === undefined ? {} : { marketSync }),
              ...(marketError === undefined ? {} : { error: marketError }),
            };
          }
          break;
        case "portfolio:update-error":
          if (running) return { status: "error", seconds: seconds(), error: event.data };
          break;
      }
    }
    throw new ServerError("The event stream closed before the portfolio update finished.");
  }

  return {
    async done(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<WaitResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "timeout", seconds: Math.round(timeoutMs / 100) / 10 }),
          timeoutMs,
        );
      });
      // The write has happened by now, so a broken stream is reported as the
      // job's outcome instead of an error that would hide the write's result.
      const followed = follow().catch((error: unknown): WaitResult => ({
        status: "error",
        seconds: Math.round((Date.now() - started) / 100) / 10,
        error: error instanceof Error ? error.message : String(error),
      }));
      try {
        return await Promise.race([followed, timeout]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
    close() {
      controller.abort();
    },
  };
}
