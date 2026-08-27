#!/usr/bin/env node
/**
 * mcp-http-server.js
 *
 * Exposes the same tools as index.js over the MCP "Streamable HTTP"
 * transport, plus a minimal, self-hosted OAuth 2.1 authorization server
 * so Claude Desktop's "Add custom connector" flow can complete its
 * required OAuth + dynamic-client-registration handshake.
 *
 * This is intentionally minimal: it's sized for ONE user (you) hitting
 * this from Claude Desktop, not a multi-tenant public service.
 *   - Dynamic client registration (/register) accepts any client and
 *     stores it in memory — fine, since only you will ever register one.
 *   - The "consent screen" at /authorize is a single password field.
 *     Enter MCP_ACCESS_TOKEN there once; that's your login gate. There is
 *     no separate account system.
 *   - PKCE (S256) is enforced on the code exchange, per the MCP spec.
 *   - Everything (clients, auth codes, tokens) lives in memory. That's
 *     fine on a single Render instance but means re-authorizing after
 *     every restart/redeploy — acceptable for personal use.
 *
 * Run with: node mcp-http-server.js
 */

import "dotenv/config";
import express from "express";
import crypto, { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server-factory.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.MCP_HTTP_PORT || process.env.PORT || 3002;
// PUBLIC_URL must be the exact https URL this service is reachable at
// (e.g. https://mcp-server-2gey.onrender.com). Required so the OAuth
// metadata documents advertise correct absolute URLs.
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// The single "password" used at the /authorize consent screen. Reuses the
// same env var you already set on Render.
const OWNER_PASSWORD = process.env.MCP_ACCESS_TOKEN;

if (!OWNER_PASSWORD) {
  console.warn(
    "WARNING: MCP_ACCESS_TOKEN is not set. The /authorize consent screen " +
      "will accept ANY password. Set MCP_ACCESS_TOKEN before exposing this URL.",
  );
}

// ── In-memory OAuth state ────────────────────────────────────────────────
const clients = new Map(); // client_id -> { redirect_uris, client_name }
const authCodes = new Map(); // code -> { client_id, redirect_uri, code_challenge, expiresAt }
const accessTokens = new Map(); // token -> { expiresAt }
const refreshTokens = new Map(); // token -> { expiresAt } (long-lived)

const CODE_TTL_MS = 5 * 60 * 1000; // 5 min to complete the exchange
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sha256Base64Url(input) {
  return base64url(crypto.createHash("sha256").update(input).digest());
}

// ── OAuth discovery metadata ─────────────────────────────────────────────
// Protected Resource Metadata: tells the client where the auth server is.
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
  });
});

// Authorization Server Metadata: describes the endpoints below.
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/authorize`,
    token_endpoint: `${PUBLIC_URL}/token`,
    registration_endpoint: `${PUBLIC_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

// ── Dynamic Client Registration ──────────────────────────────────────────
app.post("/register", (req, res) => {
  const { redirect_uris, client_name } = req.body || {};
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({ error: "invalid_client_metadata" });
  }
  const client_id = randomUUID();
  clients.set(client_id, { redirect_uris, client_name });
  res.status(201).json({
    client_id,
    redirect_uris,
    client_name,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

// ── Authorize (consent screen) ───────────────────────────────────────────
app.get("/authorize", (req, res) => {
  const {
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
  } = req.query;

  const client = clients.get(client_id);
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send("Unknown client_id or redirect_uri.");
  }
  if (code_challenge_method !== "S256" || !code_challenge) {
    return res.status(400).send("PKCE (S256) is required.");
  }

  res.send(`
    <html>
      <body style="font-family: sans-serif; max-width: 400px; margin: 80px auto;">
        <h2>Authorize connector access</h2>
        <p>Enter your access password to allow this connector to reach your MCP server.</p>
        <form method="POST" action="/authorize">
          <input type="hidden" name="client_id" value="${client_id}" />
          <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
          <input type="hidden" name="state" value="${state || ""}" />
          <input type="hidden" name="code_challenge" value="${code_challenge}" />
          <input type="password" name="password" placeholder="Access password" autofocus
                 style="width: 100%; padding: 8px; margin: 12px 0;" />
          <button type="submit" style="padding: 8px 16px;">Authorize</button>
        </form>
      </body>
    </html>
  `);
});

app.post("/authorize", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, password } =
    req.body || {};

  const client = clients.get(client_id);
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send("Unknown client_id or redirect_uri.");
  }
  if (OWNER_PASSWORD && password !== OWNER_PASSWORD) {
    return res.status(401).send("Incorrect password. Go back and try again.");
  }

  const code = randomUUID();
  authCodes.set(code, {
    client_id,
    redirect_uri,
    code_challenge,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  const redirect = new URL(redirect_uri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  res.redirect(redirect.toString());
});

// ── Token exchange ────────────────────────────────────────────────────────
app.post("/token", (req, res) => {
  const { grant_type } = req.body || {};

  if (grant_type === "authorization_code") {
    const { code, redirect_uri, code_verifier, client_id } = req.body;
    const entry = authCodes.get(code);

    if (!entry || entry.expiresAt < Date.now()) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    if (entry.client_id !== client_id || entry.redirect_uri !== redirect_uri) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    if (sha256Base64Url(code_verifier) !== entry.code_challenge) {
      return res
        .status(400)
        .json({
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        });
    }

    authCodes.delete(code); // one-time use

    const access_token = randomUUID();
    const refresh_token = randomUUID();
    accessTokens.set(access_token, {
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });
    refreshTokens.set(refresh_token, {
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    });

    return res.json({
      access_token,
      refresh_token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    });
  }

  if (grant_type === "refresh_token") {
    const { refresh_token } = req.body;
    const entry = refreshTokens.get(refresh_token);
    if (!entry || entry.expiresAt < Date.now()) {
      return res.status(400).json({ error: "invalid_grant" });
    }

    const access_token = randomUUID();
    accessTokens.set(access_token, {
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });

    return res.json({
      access_token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    });
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// ── Auth middleware for the actual MCP endpoint ──────────────────────────
function checkAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const entry = token && accessTokens.get(token);

  if (!entry || entry.expiresAt < Date.now()) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    );
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Session store: sessionId -> transport ───────────────────────────────
const transports = {};

async function handleMcpRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
        console.log(`MCP session initialized: ${sid}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`MCP session closed: ${transport.sessionId}`);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Bad Request: no valid session id and not an initialize request.",
      },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp", checkAuth, handleMcpRequest);
app.get("/mcp", checkAuth, handleMcpRequest);
app.delete("/mcp", checkAuth, handleMcpRequest);

app.get("/", (req, res) => {
  res.send("MCP remote connector is running. Point your MCP client at /mcp.");
});

app.listen(PORT, () => {
  console.log(
    `MCP Streamable HTTP server running on port ${PORT} (endpoint: /mcp)`,
  );
  console.log(`OAuth metadata served from ${PUBLIC_URL}`);
});
