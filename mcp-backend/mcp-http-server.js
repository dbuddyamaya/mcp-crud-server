#!/usr/bin/env node
/**
 * mcp-http-server.js
 *
 * MCP Streamable HTTP server with a self-hosted OAuth 2.1 authorization
 * server, now multi-tenant: each of your clients gets their own account
 * (username + password), and every tool call is persisted per-account in
 * Turso (libSQL) so you can bill by query/tool-call count.
 *
 * Required env vars:
 *   PUBLIC_URL          - exact deployed https URL, e.g. https://mcp-server-2gey.onrender.com
 *   TURSO_DATABASE_URL  - your Turso DB connection URL (libsql://...)
 *   TURSO_AUTH_TOKEN    - your Turso DB auth token
 *   ADMIN_TOKEN         - secret only you know; gates /admin/* endpoints
 *
 * All client accounts, OAuth clients/codes/tokens, and usage events are
 * stored in Turso, so restarting/redeploying this service does NOT log
 * out your clients or lose billing history. Only the live Streamable HTTP
 * session map (`transports`) stays in memory, which is fine — those are
 * just active connections, not billing data.
 *
 * Run with: node mcp-http-server.js
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto, { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server-factory.js";

const app = express();

// The admin dashboard (mcp-frontend/admin.html) is a static site that can be
// hosted on a different origin than this API (e.g. served from Vite locally,
// or from a separate static host), so it needs CORS to call /admin/* and
// /mcp from the browser. This is safe to leave permissive: every /admin/*
// route is gated on the x-admin-token header and /mcp on a bearer token —
// neither is a cookie, so a third-party page can't ride an existing session
// the way it could with cookie-based auth. Without `allowedHeaders` set,
// the `cors` package reflects whatever headers the browser's preflight
// requests (so x-admin-token and Authorization both pass through).
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.MCP_HTTP_PORT || process.env.PORT || 3002;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  console.warn(
    "WARNING: ADMIN_TOKEN is not set. /admin/* endpoints will reject all requests until it is.",
  );
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── DB setup ──────────────────────────────────────────────────────────────
async function initDb() {
  await db.execute(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  // Deployments created before is_admin existed already have an `accounts`
  // table, so CREATE TABLE IF NOT EXISTS above is a no-op for them — add
  // the column here. SQLite has no "ADD COLUMN IF NOT EXISTS", so we try
  // and swallow the one error that means it's already there.
  try {
    await db.execute(
      `ALTER TABLE accounts ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,
    );
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    redirect_uris TEXT NOT NULL,
    client_name TEXT,
    created_at TEXT NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_codes (
    code TEXT PRIMARY KEY,
    oauth_client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    account_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS access_tokens (
    token TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS refresh_tokens (
    token TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    account_name TEXT,
    timestamp TEXT NOT NULL,
    method TEXT,
    tool TEXT,
    status TEXT,
    duration_ms INTEGER
  )`);
}

// ── Password hashing (scrypt, no extra dependency) ──────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const hashBuf = Buffer.from(hash, "hex");
  const testBuf = crypto.scryptSync(password, salt, 64);
  return (
    hashBuf.length === testBuf.length &&
    crypto.timingSafeEqual(hashBuf, testBuf)
  );
}

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
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
  });
});

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

// ── Dynamic Client Registration (per app instance, e.g. each client's Desktop) ─
app.post("/register", async (req, res) => {
  const { redirect_uris, client_name } = req.body || {};
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({ error: "invalid_client_metadata" });
  }
  const client_id = randomUUID();
  await db.execute({
    sql: "INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)",
    args: [
      client_id,
      JSON.stringify(redirect_uris),
      client_name || null,
      new Date().toISOString(),
    ],
  });
  res.status(201).json({
    client_id,
    redirect_uris,
    client_name,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

// ── Authorize (per-client login form) ────────────────────────────────────
app.get("/authorize", async (req, res) => {
  const {
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
  } = req.query;

  const result = await db.execute({
    sql: "SELECT redirect_uris FROM oauth_clients WHERE client_id = ?",
    args: [client_id],
  });
  const row = result.rows[0];
  const redirectUris = row ? JSON.parse(row.redirect_uris) : null;
  if (!row || !redirectUris.includes(redirect_uri)) {
    return res.status(400).send("Unknown client_id or redirect_uri.");
  }
  if (code_challenge_method !== "S256" || !code_challenge) {
    return res.status(400).send("PKCE (S256) is required.");
  }

  res.send(`
    <html>
      <body style="font-family: sans-serif; max-width: 400px; margin: 80px auto;">
        <h2>Sign in</h2>
        <p>Enter the username and password you were given to connect.</p>
        <form method="POST" action="/authorize">
          <input type="hidden" name="client_id" value="${client_id}" />
          <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
          <input type="hidden" name="state" value="${state || ""}" />
          <input type="hidden" name="code_challenge" value="${code_challenge}" />
          <input type="text" name="username" placeholder="Username" autofocus
                 style="width: 100%; padding: 8px; margin: 8px 0;" />
          <input type="password" name="password" placeholder="Password"
                 style="width: 100%; padding: 8px; margin: 8px 0;" />
          <button type="submit" style="padding: 8px 16px;">Sign in</button>
        </form>
      </body>
    </html>
  `);
});

app.post("/authorize", async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, username, password } =
    req.body || {};

  const clientResult = await db.execute({
    sql: "SELECT redirect_uris FROM oauth_clients WHERE client_id = ?",
    args: [client_id],
  });
  const clientRow = clientResult.rows[0];
  const redirectUris = clientRow ? JSON.parse(clientRow.redirect_uris) : null;
  if (!clientRow || !redirectUris.includes(redirect_uri)) {
    return res.status(400).send("Unknown client_id or redirect_uri.");
  }

  const acctResult = await db.execute({
    sql: "SELECT id, password_hash, active FROM accounts WHERE username = ?",
    args: [username],
  });
  const account = acctResult.rows[0];
  if (
    !account ||
    !account.active ||
    !verifyPassword(password || "", account.password_hash)
  ) {
    return res
      .status(401)
      .send("Incorrect username or password. Go back and try again.");
  }

  const code = randomUUID();
  await db.execute({
    sql: "INSERT INTO auth_codes (code, oauth_client_id, redirect_uri, code_challenge, account_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [
      code,
      client_id,
      redirect_uri,
      code_challenge,
      account.id,
      Date.now() + CODE_TTL_MS,
    ],
  });

  const redirect = new URL(redirect_uri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  res.redirect(redirect.toString());
});

// ── Token exchange ────────────────────────────────────────────────────────
app.post("/token", async (req, res) => {
  const { grant_type } = req.body || {};

  if (grant_type === "authorization_code") {
    const { code, redirect_uri, code_verifier, client_id } = req.body;
    const result = await db.execute({
      sql: "SELECT * FROM auth_codes WHERE code = ?",
      args: [code],
    });
    const entry = result.rows[0];

    if (!entry || entry.expires_at < Date.now()) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    if (
      entry.oauth_client_id !== client_id ||
      entry.redirect_uri !== redirect_uri
    ) {
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

    await db.execute({
      sql: "DELETE FROM auth_codes WHERE code = ?",
      args: [code],
    });

    const access_token = randomUUID();
    const refresh_token = randomUUID();
    await db.execute({
      sql: "INSERT INTO access_tokens (token, account_id, expires_at) VALUES (?, ?, ?)",
      args: [access_token, entry.account_id, Date.now() + ACCESS_TOKEN_TTL_MS],
    });
    await db.execute({
      sql: "INSERT INTO refresh_tokens (token, account_id, expires_at) VALUES (?, ?, ?)",
      args: [
        refresh_token,
        entry.account_id,
        Date.now() + REFRESH_TOKEN_TTL_MS,
      ],
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
    const result = await db.execute({
      sql: "SELECT * FROM refresh_tokens WHERE token = ?",
      args: [refresh_token],
    });
    const entry = result.rows[0];
    if (!entry || entry.expires_at < Date.now()) {
      return res.status(400).json({ error: "invalid_grant" });
    }

    const access_token = randomUUID();
    await db.execute({
      sql: "INSERT INTO access_tokens (token, account_id, expires_at) VALUES (?, ?, ?)",
      args: [access_token, entry.account_id, Date.now() + ACCESS_TOKEN_TTL_MS],
    });

    return res.json({
      access_token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    });
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// ── Auth middleware for the MCP endpoint — resolves which account is calling ─
async function checkAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return unauthorized(res);

  const result = await db.execute({
    sql: `SELECT access_tokens.account_id, accounts.name, accounts.active, access_tokens.expires_at
          FROM access_tokens JOIN accounts ON accounts.id = access_tokens.account_id
          WHERE access_tokens.token = ?`,
    args: [token],
  });
  const entry = result.rows[0];
  if (!entry || !entry.active || entry.expires_at < Date.now())
    return unauthorized(res);

  req.accountId = entry.account_id;
  req.accountName = entry.name;
  next();
}
function unauthorized(res) {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
  );
  return res.status(401).json({ error: "Unauthorized" });
}

// ── Admin auth (you only) ────────────────────────────────────────────────
function checkAdmin(req, res, next) {
  if (!ADMIN_TOKEN || req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res
      .status(401)
      .json({ error: "Unauthorized. Set x-admin-token header." });
  }
  next();
}

// ── Admin: manage client accounts ────────────────────────────────────────
app.post("/admin/accounts", checkAdmin, async (req, res) => {
  const { name, username, password, is_admin } = req.body || {};
  if (!name || !username || !password) {
    return res
      .status(400)
      .json({ error: "name, username, and password are required." });
  }
  const id = randomUUID();
  try {
    await db.execute({
      sql: "INSERT INTO accounts (id, name, username, password_hash, active, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
      args: [
        id,
        name,
        username,
        hashPassword(password),
        is_admin ? 1 : 0,
        new Date().toISOString(),
      ],
    });
  } catch (err) {
    return res.status(409).json({ error: "username already taken" });
  }
  res.status(201).json({ id, name, username, is_admin: !!is_admin });
});

app.get("/admin/accounts", checkAdmin, async (req, res) => {
  const result = await db.execute(
    "SELECT id, name, username, active, is_admin, created_at FROM accounts ORDER BY created_at",
  );
  res.json({ accounts: result.rows });
});

// PATCH /admin/accounts/:id — pass `active` and/or `is_admin`; either can
// be omitted to leave it unchanged.
app.patch("/admin/accounts/:id", checkAdmin, async (req, res) => {
  const { active, is_admin } = req.body || {};
  const sets = [];
  const args = [];
  if (active !== undefined) {
    sets.push("active = ?");
    args.push(active ? 1 : 0);
  }
  if (is_admin !== undefined) {
    sets.push("is_admin = ?");
    args.push(is_admin ? 1 : 0);
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }
  args.push(req.params.id);
  await db.execute({
    sql: `UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
  res.json({ ok: true });
});

// DELETE /admin/accounts/:id — removes the account and immediately revokes
// its OAuth tokens/pending codes, so any MCP client using it is cut off on
// its next request. Past usage_events rows are kept on purpose: they
// already store a snapshot of the account's name (account_name), so
// historical billing/activity reports for this account stay intact even
// after it's gone.
app.delete("/admin/accounts/:id", checkAdmin, async (req, res) => {
  const { id } = req.params;
  const existing = await db.execute({
    sql: "SELECT id FROM accounts WHERE id = ?",
    args: [id],
  });
  if (!existing.rows[0]) {
    return res.status(404).json({ error: "account not found" });
  }

  await db.execute({
    sql: "DELETE FROM access_tokens WHERE account_id = ?",
    args: [id],
  });
  await db.execute({
    sql: "DELETE FROM refresh_tokens WHERE account_id = ?",
    args: [id],
  });
  await db.execute({
    sql: "DELETE FROM auth_codes WHERE account_id = ?",
    args: [id],
  });
  await db.execute({ sql: "DELETE FROM accounts WHERE id = ?", args: [id] });

  res.json({ ok: true });
});

// ── Admin: billing report ────────────────────────────────────────────────
// GET /admin/billing?from=2026-08-01&to=2026-09-01
//
// Admin accounts (is_admin = 1) are excluded from both queries below via a
// LEFT JOIN + COALESCE: a LEFT JOIN (not an inner join) so a usage_events
// row for a since-deleted account still counts — there's no accounts row
// left to match, COALESCE treats that as is_admin = 0. Note this means an
// account billed while flagged admin and later deleted would then start
// counting again; an edge case not worth the extra bookkeeping to close.
//
// That same LEFT JOIN also tells us whether the account has since been
// deleted (accounts.id IS NULL — no row left to match): each result row
// carries an `account_deleted` flag so the dashboard can mark it, since
// usage_events keeps a name snapshot even after the account is gone.
app.get("/admin/billing", checkAdmin, async (req, res) => {
  const from = req.query.from || "1970-01-01";
  const to = req.query.to || new Date().toISOString();

  const result = await db.execute({
    sql: `SELECT usage_events.account_id, usage_events.account_name, COUNT(*) as call_count,
                 CASE WHEN accounts.id IS NULL THEN 1 ELSE 0 END as account_deleted
          FROM usage_events
          LEFT JOIN accounts ON accounts.id = usage_events.account_id
          WHERE usage_events.method = 'tools/call'
            AND usage_events.timestamp >= ? AND usage_events.timestamp < ?
            AND COALESCE(accounts.is_admin, 0) = 0
          GROUP BY usage_events.account_id, usage_events.account_name
          ORDER BY call_count DESC`,
    args: [from, to],
  });

  const byToolResult = await db.execute({
    sql: `SELECT usage_events.account_id, usage_events.account_name, usage_events.tool, COUNT(*) as call_count,
                 CASE WHEN accounts.id IS NULL THEN 1 ELSE 0 END as account_deleted
          FROM usage_events
          LEFT JOIN accounts ON accounts.id = usage_events.account_id
          WHERE usage_events.method = 'tools/call'
            AND usage_events.timestamp >= ? AND usage_events.timestamp < ?
            AND COALESCE(accounts.is_admin, 0) = 0
          GROUP BY usage_events.account_id, usage_events.account_name, usage_events.tool
          ORDER BY usage_events.account_name, call_count DESC`,
    args: [from, to],
  });

  res.json({
    range: { from, to },
    totals_by_account: result.rows,
    breakdown_by_tool: byToolResult.rows,
  });
});

// ── Admin: raw activity feed ─────────────────────────────────────────────
// GET /admin/activity                     -> last 100 events, all accounts
// GET /admin/activity?username=acme       -> last 100 events for one account
// GET /admin/activity?username=acme&limit=500
app.get("/admin/activity", checkAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);

  if (req.query.username) {
    const acct = await db.execute({
      sql: "SELECT id, name FROM accounts WHERE username = ?",
      args: [req.query.username],
    });
    if (!acct.rows[0])
      return res.status(404).json({ error: "no account with that username" });

    const result = await db.execute({
      sql: `SELECT timestamp, method, tool, status, duration_ms
            FROM usage_events WHERE account_id = ?
            ORDER BY timestamp DESC LIMIT ?`,
      args: [acct.rows[0].id, limit],
    });
    return res.json({
      account: acct.rows[0].name,
      count: result.rows.length,
      events: result.rows,
    });
  }

  const result = await db.execute({
    sql: `SELECT usage_events.timestamp, usage_events.account_id, usage_events.account_name,
                 usage_events.method, usage_events.tool, usage_events.status, usage_events.duration_ms,
                 CASE WHEN accounts.id IS NULL THEN 1 ELSE 0 END as account_deleted
          FROM usage_events
          LEFT JOIN accounts ON accounts.id = usage_events.account_id
          ORDER BY usage_events.timestamp DESC LIMIT ?`,
    args: [limit],
  });
  res.json({ count: result.rows.length, events: result.rows });
});

// ── Activity logging ──────────────────────────────────────────────────────
function summarizeRpcBody(body) {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.map((m) => {
    if (!m || typeof m !== "object") return { method: "unknown" };
    if (m.method === "tools/call")
      return { method: m.method, tool: m.params?.name };
    return { method: m.method };
  });
}

async function logActivity({
  accountId,
  accountName,
  calls,
  status,
  durationMs,
}) {
  const timestamp = new Date().toISOString();
  for (const call of calls) {
    console.log(
      `[activity] ${JSON.stringify({ timestamp, accountId, accountName, ...call, status, durationMs })}`,
    );
    await db.execute({
      sql: `INSERT INTO usage_events (id, account_id, account_name, timestamp, method, tool, status, duration_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(),
        accountId || null,
        accountName || null,
        timestamp,
        call.method || null,
        call.tool || null,
        String(status),
        durationMs,
      ],
    });
  }
}

// ── Session store: sessionId -> transport ───────────────────────────────
const transports = {};

async function handleMcpRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  const start = Date.now();
  const calls = req.body
    ? summarizeRpcBody(req.body)
    : [{ method: req.method }];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
        console.log(
          `MCP session initialized: ${sid} (account: ${req.accountName})`,
        );
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
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
    await logActivity({
      accountId: req.accountId,
      accountName: req.accountName,
      calls,
      status: 400,
      durationMs: Date.now() - start,
    });
    return;
  }

  try {
    await transport.handleRequest(req, res, req.body);
    await logActivity({
      accountId: req.accountId,
      accountName: req.accountName,
      calls,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    await logActivity({
      accountId: req.accountId,
      accountName: req.accountName,
      calls,
      status: "error",
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

app.post("/mcp", checkAuth, handleMcpRequest);
app.get("/mcp", checkAuth, handleMcpRequest);
app.delete("/mcp", checkAuth, handleMcpRequest);

app.get("/", (req, res) => {
  res.send("MCP remote connector is running. Point your MCP client at /mcp.");
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `MCP Streamable HTTP server running on port ${PORT} (endpoint: /mcp)`,
      );
      console.log(`OAuth metadata served from ${PUBLIC_URL}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
