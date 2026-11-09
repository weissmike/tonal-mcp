import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { authorize, same } from "./authorize.js";
import { env, setEnv, type Env } from "./env.js";
import { createMcpServer } from "./mcp.js";
import { TonalSession } from "./session.js";

// Injected at build time from the "define" block in wrangler config (see wrangler.example.jsonc).
declare const __ORIGIN__: string;
const ORIGIN = __ORIGIN__;

/** Public routes: landing, health, and the /authorize login + consent page. */
const publicApp = new Hono<{ Bindings: Env }>();
publicApp.get("/", (c) => c.text("tonal-mcp — MCP endpoint: /mcp"));
publicApp.get("/health", async (c) => {
  setEnv(c.env);
  return c.json({ ok: true, ...await env().TONAL_SESSION.getByName("owner").status() });
});
publicApp.all("/authorize", (c) => authorize(c.req.raw, c.env));

/** Protected MCP endpoint: only reached with a valid OAuth token or the legacy owner bearer. */
const mcpHandler = {
  async fetch(request: Request, e: Env, ctx: ExecutionContext & { props?: unknown }): Promise<Response> {
    if (!ctx.props) return Response.json({ error: "Unauthorized" }, { status: 401 });
    setEnv(e);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = await createMcpServer();
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

export { TonalSession };

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: { fetch: (request, e, ctx) => publicApp.fetch(request, e, ctx) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp"],
  accessTokenTTL: 60 * 60,
  refreshTokenTTL: 60 * 60 * 24 * 90,
  resourceMetadata: {
    resource: `${ORIGIN}/mcp`,
    authorization_servers: [ORIGIN],
    resource_name: "Tonal MCP",
  },
  // Claude Code / Desktop keep working with the static owner bearer token.
  resolveExternalToken: async ({ token, env: e }) =>
    await same(token, e.MCP_BEARER) ? { props: { owner: true, legacy: true }, audience: `${ORIGIN}/mcp` } : null,
});
