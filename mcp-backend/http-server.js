#!/usr/bin/env node
/**
 * mcp-crud-server/http-server.js
 *
 * HTTP backend for the frontend. On startup, connects to index.js (the
 * MCP server) as a subprocess and keeps that connection alive. Exposes a
 * /api/chat endpoint that runs the standard Claude tool-use loop: send the
 * conversation + the MCP server's tools to Claude, execute any tool_use
 * calls against the MCP server, feed results back, repeat until Claude
 * replies with plain text.
 *
 * index.js itself is unchanged and still usable directly by Claude Desktop.
 *
 * Requires ANTHROPIC_API_KEY as an environment variable (set in Render's
 * dashboard for this service, or in .env locally).
 *
 * Run with: node http-server.js
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, "index.js");

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

let mcpClient = null;
let mcpTools = [];

async function connectMcp() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_SCRIPT],
  });
  mcpClient = new Client(
    { name: "mcp-frontend-backend", version: "1.0.0" },
    { capabilities: {} },
  );
  await mcpClient.connect(transport);
  const listed = await mcpClient.listTools();
  mcpTools = listed.tools;
  console.log(
    `Connected to ${SERVER_SCRIPT} — ${mcpTools.length} tools available.`,
  );
}

function toClaudeTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

async function callMcpTool(name, args) {
  const result = await mcpClient.callTool({ name, arguments: args || {} });
  const text = (result.content || []).map((c) => c.text).join("\n");
  return { text, isError: !!result.isError };
}

const SYSTEM_PROMPT = `You are an assistant with access to tools that query an Athena database
(trusted_prod) via an MCP server. Available tools let you list tables, describe their
columns, sample rows, get row counts, and run arbitrary SELECT queries (query tool).

Guidelines:
- Use describe_table before writing a query against a table you haven't inspected yet,
  so you don't guess at column names.
- Prefer sample_table or query with a LIMIT when exploring, rather than large scans.
- Present results as returned; don't reformat tables yourself.
- If a tool errors, explain the issue plainly rather than retrying blindly.`;

const sessions = new Map();

app.get("/api/status", (req, res) => {
  res.json({ connected: !!mcpClient, tools: mcpTools });
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || typeof message !== "string" || !message.trim()) {
    return res
      .status(400)
      .json({ error: "sessionId and message are required." });
  }
  if (!mcpClient)
    return res.status(503).json({ error: "Not connected to MCP server yet." });

  const history = sessions.get(sessionId) || [];
  history.push({ role: "user", content: message });

  try {
    const events = [];

    for (let turn = 0; turn < 8; turn++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        tools: toClaudeTools(mcpTools),
        messages: history,
      });

      history.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const textBlocks = response.content.filter((b) => b.type === "text");
      for (const t of textBlocks)
        if (t.text) events.push({ type: "text", text: t.text });

      if (toolUses.length === 0) break;

      const toolResults = [];
      for (const call of toolUses) {
        events.push({ type: "tool_call", name: call.name, input: call.input });
        let output;
        try {
          const { text, isError } = await callMcpTool(call.name, call.input);
          output =
            text ||
            (isError
              ? "Tool returned an error with no message."
              : "(empty result)");
        } catch (err) {
          output = `Error calling tool: ${err.message}`;
        }
        events.push({ type: "tool_result", name: call.name, output });
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: output,
        });
      }
      history.push({ role: "user", content: toolResults });
    }

    sessions.set(sessionId, history);
    res.json({ events });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message || "Something went wrong." });
  }
});

app.post("/api/reset", (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) sessions.delete(sessionId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;

connectMcp()
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
