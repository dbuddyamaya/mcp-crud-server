#!/usr/bin/env node
/**
 * mcp-http-server.js
 *
 * Exposes the same tools as index.js, but over the MCP "Streamable HTTP"
 * transport instead of stdio. This is what lets ANY Claude Desktop or
 * claude.ai user add this server as a custom connector via just a URL —
 * no local install, no cloning this repo, no local .env file.
 *
 * Protocol notes (per the MCP spec):
 * - A client first POSTs an "initialize" request with no session id.
 *   We create a new McpServer + transport for that session, generate a
 *   session id, and return it in the Mcp-Session-Id response header.
 * - Every subsequent request (POST for messages, GET for the server-sent
 *   event stream, DELETE to end the session) includes that same
 *   Mcp-Session-Id header so we route it to the right transport.
 *
 * Auth: this file checks a simple bearer token (MCP_ACCESS_TOKEN) on every
 * request. This is NOT full OAuth — the MCP spec's preferred auth model
 * for public connectors — but it's a reasonable, simple gate for a small
 * team, and stops the URL from being usable by literally anyone who finds
 * it. See the note at the bottom of this file for upgrading to OAuth later.
 *
 * Run with: node mcp-http-server.js
 */

import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server-factory.js";

const app = express();
app.use(express.json());

// ── Auth middleware ──────────────────────────────────────────────────────
// Every request must include: Authorization: Bearer <MCP_ACCESS_TOKEN>
const REQUIRED_TOKEN = process.env.MCP_ACCESS_TOKEN;

function checkAuth(req, res, next) {
  if (!REQUIRED_TOKEN) {
    console.warn(
      "WARNING: MCP_ACCESS_TOKEN is not set — running with no auth check.",
    );
    return next();
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== REQUIRED_TOKEN) {
    return res
      .status(401)
      .json({ error: "Unauthorized. Provide a valid Bearer token." });
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

const PORT = process.env.MCP_HTTP_PORT || process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(
    `MCP Streamable HTTP server running on port ${PORT} (endpoint: /mcp)`,
  );
  if (!REQUIRED_TOKEN) {
    console.warn(
      "No MCP_ACCESS_TOKEN set — anyone with this URL can use it. Set one before sharing the URL.",
    );
  }
});

/**
 * Upgrading to real OAuth later:
 * The MCP spec's standard auth model for public connectors is OAuth 2.1
 * with dynamic client registration. That's a meaningfully bigger project
 * (an authorization server, token issuance/refresh, per-user scoping) —
 * worth doing if this ever needs to support untrusted/public users, but
 * overkill for a small internal team where a shared bearer token behind
 * this URL is a reasonable interim gate.
 */
