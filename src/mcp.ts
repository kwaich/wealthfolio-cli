// A minimal client for the server's own MCP endpoint (/mcp, Streamable HTTP).
// `wf activity update` uses it to run the server's prepare/commit_activity_updates
// tools, so the update rules are the server's, not a copy. /mcp takes a
// personal access token (`wf agent-token create`), not the login session.
import { AuthError, ServerError } from "./errors";
import { parseSse } from "./events";
import { joinUrl, PROFILE_ID_HEADER } from "./transport";

export const MCP_PATH = "/mcp";
const PROTOCOL_VERSION = "2025-06-18";

export const MCP_OFF_HINT =
  "Start the server with WF_MCP_ENABLED=true (AI Agent Access), then run `wf agent-token create`.";

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpOptions {
  baseUrl: string;
  token: string;
  /** Profile the token belongs to; the server uses its default profile without it. */
  profileId?: string;
  version: string;
}

export class McpClient {
  private sessionId?: string;
  private nextId = 1;

  private constructor(private readonly options: McpOptions) {}

  /** Opens an MCP session (initialize, then notifications/initialized). */
  static async connect(options: McpOptions): Promise<McpClient> {
    const client = new McpClient(options);
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "wf", version: options.version },
    });
    await client.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return client;
  }

  /** Calls one tool and returns its structured result. A tool error becomes ServerError. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await this.request("tools/call", { name, arguments: args })) as ToolResult;
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    if (result.isError) throw new ServerError(`${name}: ${text || "tool error"}`);
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  /** Ends the MCP session. Failures are ignored: the server expires it anyway. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.url(), { method: "DELETE", headers: this.headers() });
    } catch {
      // ignore
    }
  }

  private url(): string {
    return joinUrl(this.options.baseUrl, MCP_PATH);
  }

  private headers(): Headers {
    const headers = new Headers({
      authorization: `Bearer ${this.options.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    if (this.options.profileId) headers.set(PROFILE_ID_HEADER, this.options.profileId);
    if (this.sessionId) {
      headers.set("mcp-session-id", this.sessionId);
      headers.set("mcp-protocol-version", PROTOCOL_VERSION);
    }
    return headers;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    const reply = await readReply(res, id);
    if (reply.error) throw new ServerError(`MCP ${method}: ${reply.error.message}`);
    return reply.result;
  }

  private async post(message: Record<string, unknown>): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(message),
      });
    } catch (error) {
      const cause =
        error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
      throw new ServerError(`Cannot reach ${this.url()}${cause ? `: ${cause}` : ""}`);
    }
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (res.ok) return res;
    const body = (await res.text()).trim();
    if (res.status === 401) {
      throw new AuthError(
        "The server rejected the agent access token (revoked, expired, or from another server).",
        "Run `wf agent-token create`.",
      );
    }
    // Without WF_MCP_ENABLED the path falls through to the static web app (405 for POST).
    if (res.status === 404 || res.status === 405) {
      throw new ServerError(
        `The server has no MCP endpoint at ${MCP_PATH}.`,
        res.status,
        MCP_OFF_HINT,
      );
    }
    throw new ServerError(
      body || `MCP request failed (${res.status} ${res.statusText})`,
      res.status,
    );
  }
}

/** Reads the JSON-RPC reply with `id` from a JSON or an SSE response. */
async function readReply(res: Response, id: number): Promise<RpcResponse> {
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    return (await res.json()) as RpcResponse;
  }
  const body = res.body;
  if (!body) throw new ServerError("MCP response had no body.");
  let reply: RpcResponse | undefined;
  for await (const event of parseSse(body)) {
    const data = event.data as RpcResponse | string;
    if (typeof data === "object" && data !== null && data.id === id) {
      reply = data;
      break;
    }
  }
  // Leaving the loop released the parser's reader lock, so the stream can be
  // cancelled now; while locked, cancel() only rejects and the stream stays open.
  await body.cancel().catch(() => {});
  if (!reply) throw new ServerError("The MCP response ended without a reply.");
  return reply;
}
