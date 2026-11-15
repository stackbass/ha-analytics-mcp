#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { config, getConfig, ConfigError } from "./config.js";
import { parseMode, assertHttpBindingAllowed, requireAuth } from "./cli.js";
import {
  prefetchStartupData,
  ensureHAConfig,
  isHAReachable,
  getCachedDiscoveryIndex,
  setCachedDiscoveryIndex,
} from "./cache.js";
import { fetchDiscoveryIndex, applyTlsPolicy } from "./ha-client.js";
import { isError as isHAError } from "./errors.js";
import { logError, logInfo, summarizeArgs } from "./logger.js";
import { handleGetCurrentTime, GET_CURRENT_TIME_TOOL } from "./tools/get-current-time.js";
import { handleListEntities, LIST_ENTITIES_TOOL } from "./tools/list-entities.js";
import { handleListAreas, LIST_AREAS_TOOL } from "./tools/list-areas.js";
import { handleListDevices, LIST_DEVICES_TOOL } from "./tools/list-devices.js";
import { handleListDeviceEntities, LIST_DEVICE_ENTITIES_TOOL } from "./tools/list-device-entities.js";
import { handleGetSensorStats, GET_SENSOR_STATS_TOOL } from "./tools/get-sensor-stats.js";
import { handleGetConsumption, GET_CONSUMPTION_TOOL } from "./tools/get-consumption.js";
import { handleDetectSessions, DETECT_SESSIONS_TOOL } from "./tools/detect-sessions.js";
import { handleGetState, GET_STATE_TOOL } from "./tools/get-state.js";
import { handleGetStateHistory, GET_STATE_HISTORY_TOOL } from "./tools/get-state-history.js";

const TOOLS = [
  GET_CURRENT_TIME_TOOL,
  LIST_AREAS_TOOL,
  LIST_DEVICES_TOOL,
  LIST_DEVICE_ENTITIES_TOOL,
  LIST_ENTITIES_TOOL,
  GET_STATE_TOOL,
  GET_SENSOR_STATS_TOOL,
  GET_CONSUMPTION_TOOL,
  DETECT_SESSIONS_TOOL,
  GET_STATE_HISTORY_TOOL,
];

/**
 * Validate call arguments against the tool's declared schema: unknown keys and
 * missing required keys reject the call before any handler runs, so a typo'd
 * or hallucinated parameter can never be silently ignored.
 */
function validateArgs(name: string, args: Record<string, unknown>): string | null {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null; // unknown tool handled in callTool
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const known = Object.keys(schema.properties ?? {});
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    return (
      `ERROR: Unknown parameter${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} ` +
      `for ${name} — the call was NOT executed.\n` +
      `Valid parameters: ${known.length > 0 ? known.join(", ") : "(none)"}.`
    );
  }
  const missing = (schema.required ?? []).filter(
    (k) => args[k] === undefined || args[k] === null || args[k] === ""
  );
  if (missing.length > 0) {
    return (
      `ERROR: Missing required parameter${missing.length > 1 ? "s" : ""} ${missing.map((k) => `"${k}"`).join(", ")} ` +
      `for ${name} — the call was NOT executed.`
    );
  }
  // Enum-typed parameters: an out-of-enum value is rejected, never silently
  // ignored (observed live: group_by="hour_of_day" passed to detect_sessions,
  // whose only grouping is "day", was dropped and the model guessed instead).
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const enumValues = (prop as { enum?: unknown[] }).enum;
    const value = args[key];
    if (value !== undefined && enumValues && !enumValues.includes(value)) {
      return (
        `ERROR: Invalid value ${JSON.stringify(value)} for parameter "${key}" of ${name} — ` +
        `the call was NOT executed. Valid values: ${enumValues.join(", ")}.`
      );
    }
  }
  return null;
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const invalid = validateArgs(name, args);
  if (invalid) return invalid;
  await ensureHAConfig();
  switch (name) {
    case "ha_history_get_current_time":       return handleGetCurrentTime();
    case "ha_history_list_areas":             return handleListAreas(args);
    case "ha_history_list_devices":           return handleListDevices(args);
    case "ha_history_list_device_entities":   return handleListDeviceEntities(args);
    case "ha_history_list_entities":          return handleListEntities(args);
    case "ha_history_get_sensor_stats":       return handleGetSensorStats(args);
    case "ha_history_get_consumption":        return handleGetConsumption(args);
    case "ha_history_detect_sessions":        return handleDetectSessions(args);
    case "ha_history_get_state":              return handleGetState(args);
    case "ha_history_get_state_history":      return handleGetStateHistory(args);
    default: return `ERROR: Unknown tool "${name}". Available tools: ${TOOLS.map(t => t.name).join(", ")}`;
  }
}

const AREAS_RESOURCE_URI = `ha://${config.haName.toLowerCase()}/areas`;

async function getAreasResourceText(): Promise<string> {
  let index = getCachedDiscoveryIndex();
  if (!index) {
    const result = await fetchDiscoveryIndex();
    if (isHAError(result)) return `Error fetching areas: ${result.text}`;
    setCachedDiscoveryIndex(result);
    index = result;
  }
  const lines = [`Areas in ${config.haName} (${index.areas.length} total):`];
  for (const area of index.areas) {
    const deviceCount = (index.devicesByArea.get(area.area_id) ?? []).length;
    lines.push(`  ${area.name}${deviceCount > 0 ? ` (${deviceCount} device${deviceCount === 1 ? "" : "s"})` : ""}`);
  }
  lines.push(`\nUse ha_history_list_devices with area="<name>" to see devices and ready entity_ids in a specific area.`);
  return lines.join("\n");
}

function createServer(): Server {
  const server = new Server(
    { name: `ha-history-${config.haName.toLowerCase()}`, version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        `You are a data analyst for ${config.haName} home automation data.\n\n` +
        `Answer from tool results only. State sensor, period, and aggregation. Keep answers short and factual.\n\n` +
        `Never guess entity_ids. Resolve them first. Prefer ha_history_list_entities with areas, device, and device_classes; use search only for remaining name words.\n` +
        `For multi-area climate comparisons, one call with areas=[...] and device_classes=["temperature","humidity"] should usually find the needed entities.\n` +
        `For people or phone location history, use ha_history_list_entities with domains=["person"], domains=["device_tracker"], or both in one call.\n` +
        `Use ha_history_list_devices only when the device or area is still unclear, ha_history_list_device_entities only for one-device inspection, and ha_history_list_areas only when the exact area name is unknown.\n` +
        `If discovery returns weak or ambiguous matches, retry with a tighter area, device, or search filter before asking the user.\n` +
        `If a discovery call returns no matches, read the inventory in its response: when the thing is not listed there, it does not exist — say so instead of retrying other search words.\n\n` +
        `Tool choice: ha_history_get_sensor_stats for instantaneous measurements, ha_history_get_consumption for cumulative meters, ha_history_detect_sessions for threshold-based activity, ha_history_get_state_history for discrete-state timelines, ha_history_get_state for current state.\n\n` +
        `Time formats: relative ("7d","30d","24h"), named ("last month","yesterday","Q1"), or ISO date ("2026-04-01"). Default start: 30d. Default end: now. "overnight" for detect_sessions means 22:00 yesterday to 06:00 today.`,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: AREAS_RESOURCE_URI,
        name: `Areas in ${config.haName}`,
        description: `All defined areas (rooms/locations) in ${config.haName} with device counts. Read when you need the exact area names for room-based discovery.`,
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === AREAS_RESOURCE_URI) {
      const text = await getAreasResourceText();
      return { contents: [{ uri, mimeType: "text/plain", text }] };
    }
    return { contents: [{ uri, mimeType: "text/plain", text: `Unknown resource: ${uri}` }] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const startMs = Date.now();
    logInfo("MCP", "tool request", {
      tool: name,
      args: summarizeArgs(args as Record<string, unknown>),
    });
    const text = await callTool(name, args as Record<string, unknown>);
    // Convention: every error path returns a string starting with "ERROR" —
    // enforced across handlers so this flag (and the MCP isError field) is
    // reliable, not a heuristic.
    const isErr = text.startsWith("ERROR");
    logInfo("MCP", "tool response", {
      tool: name,
      duration_ms: Date.now() - startMs,
      response_chars: text.length,
      is_error: isErr,
    });
    return { content: [{ type: "text", text }], ...(isErr ? { isError: true } : {}) };
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server (stateless Streamable HTTP transport)
//
// Every POST gets a fresh Server + transport pair with `sessionIdGenerator:
// undefined`, so no session id is ever issued and no per-session state is kept.
// This is what makes us connectable from Home Assistant's built-in `mcp`
// integration, whose config flow calls `initialize()` twice on the same
// connection — a stateful transport answers the duplicate with 400
// "Server already initialized". All real state (cache, HA client) lives at
// module scope and is process-wide, so nothing is lost by discarding sessions.
// ---------------------------------------------------------------------------

function createHttpApp(token: string | undefined): express.Express {
  const app = express();

  // Open origin is safe only in combination with the loopback default and the
  // bearer-token requirement enforced in startHttp(). The MCP headers must be
  // listed explicitly so browser clients can read/send them.
  app.use(
    cors({
      // Stateless: we never emit mcp-session-id, so there is nothing to expose
      // beyond the protocol version.
      exposedHeaders: ["mcp-protocol-version"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
        "Last-Event-ID",
        "mcp-session-id",
        "mcp-protocol-version",
      ],
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
    })
  );
  app.use(express.json());

  const auth = requireAuth(token);

  app.post("/mcp", auth, handleMcpPost);
  app.get("/mcp", auth, methodNotAllowed);
  app.delete("/mcp", auth, methodNotAllowed);

  // Minimal, non-identifying health payload — no HA URL or instance name.
  app.get("/health", (_req, res) => {
    res.json({
      status: isHAReachable() ? "ok" : "degraded",
      uptime_s: Math.floor(process.uptime()),
    });
  });

  return app;
}

const handleMcpPost = async (req: Request, res: Response): Promise<void> => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  // The pair lives exactly as long as this request/response.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logError("MCP", "request handling failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
};

/**
 * Stateless servers expose no standalone SSE stream and hold no session to
 * terminate, so GET and DELETE are simply not allowed. MCP clients (including
 * HA's) treat 405 as "no server-initiated stream" and carry on.
 */
const methodNotAllowed = (_req: Request, res: Response): void => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: this server is stateless (POST only)" },
    id: null,
  });
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function startStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  logInfo("STARTUP", "server running", { transport: "stdio", home: config.haName });
}

function startHttp(): void {
  const { host, port, httpToken } = getConfig();
  const app = createHttpApp(httpToken);
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  app.listen(port, host, () => {
    logInfo("STARTUP", "server running", {
      transport: "http",
      home: config.haName,
      bind: `${displayHost}:${port}`,
      auth: httpToken
        ? "token required (Authorization: Bearer <token> or ?token=<token>)"
        : "none (loopback only)",
      mcp_url: httpToken
        ? `http://${displayHost}:${port}/mcp?token=<MCP_HTTP_TOKEN>`
        : `http://${displayHost}:${port}/mcp`,
      health_url: `http://${displayHost}:${port}/health`,
    });
    if (!httpToken) {
      logInfo("STARTUP", "no MCP_HTTP_TOKEN set — access limited to this machine", {});
    }
  });
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv);

  // Fail fast on missing/invalid configuration before touching the network.
  const cfg = getConfig();
  if (mode === "http") assertHttpBindingAllowed(cfg.host, cfg.httpToken);
  applyTlsPolicy();

  await prefetchStartupData();

  if (mode === "http") {
    startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    logError("STARTUP", "configuration error", { error: err.message });
  } else {
    logError("STARTUP", "fatal startup error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  process.exit(1);
});
