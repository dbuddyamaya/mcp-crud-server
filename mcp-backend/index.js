#!/usr/bin/env node
/**
 * index.js — stdio MCP server, used by Claude Desktop running locally on
 * your own machine (Settings → Developer → Edit Config).
 *
 * Tool logic now lives in server-factory.js, shared with mcp-http-server.js
 * (the remote/connector version).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createMcpServer } from "./server-factory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
