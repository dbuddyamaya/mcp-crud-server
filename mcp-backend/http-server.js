#!/usr/bin/env node
/**
 * mcp-crud-server/http-server.js
 *
 * A thin HTTP wrapper around index.js so a browser (crud-dashboard) can use
 * its tools. Auto-connects to index.js as a subprocess on startup — no path
 * configuration needed since it lives right next to it.
 *
 * Run with: node http-server.js
 * (index.js itself is unchanged — it's still used directly by Claude Desktop.)
 */

import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, "index.js");

const app = express();
app.use(cors());
app.use(express.json());

let client = null;
let tools = [];

async function connect() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_SCRIPT],
  });
  client = new Client(
    { name: "crud-dashboard-backend", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const listed = await client.listTools();
  tools = listed.tools;
  console.log(
    `Connected to ${SERVER_SCRIPT} — ${tools.length} tools available.`,
  );
}

app.get("/api/status", (req, res) => {
  res.json({ connected: !!client, tools });
});

app.post("/api/call", async (req, res) => {
  const { name, arguments: args } = req.body || {};
  if (!client)
    return res.status(503).json({ error: "Not connected to MCP server yet." });
  if (!name) return res.status(400).json({ error: "Tool name is required." });

  try {
    const result = await client.callTool({ name, arguments: args || {} });
    res.json({ result });
  } catch (err) {
    console.error(`Tool "${name}" failed:`, err);
    res.status(500).json({ error: err.message || "Tool call failed." });
  }
});

const PORT = process.env.PORT || 3001;

connect()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `mcp-crud-server HTTP backend running on http://localhost:${PORT}`,
      );
    });
  })
  .catch((err) => {
    console.error("Failed to connect to index.js on startup:", err);
    process.exit(1);
  });
