#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { MemoryService } from "../memory.js";
import { createMcpServer } from "./tools.js";

/**
 * Unified memory interface for agents.
 *
 * Every MCP client (Claude Code, Codex, Cursor, ...) pointed at the same
 * Supabase project reads and writes the same memory. Writes default to the
 * inbox; search reads active memory. Set MEMINBOX_ACTOR per client so the
 * audit log and provenance show WHICH agent wrote what.
 */
const cfg = loadConfig();
const memory = new MemoryService(cfg, createDb(cfg));

// src/mcp and dist/mcp both sit two levels below the package root.
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const server = createMcpServer(cfg, memory, version);
const transport = new StdioServerTransport();
await server.connect(transport);
