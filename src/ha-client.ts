import WebSocket from "ws";
import { config } from "./config.js";
import {
  errUnreachable,
  errUnauthorized,
  errTimeout,
  errFromCaught,
  McpError,
} from "./errors.js";
import { logInfo, logWarn, summarizeArgs } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HAConfig {
  timezone: string;
  locationName: string;
  latitude: number;
  longitude: number;
  version: string;
}

export interface StatisticId {
  statistic_id: string;
  name: string | null;
  source: string;
  unit_of_measurement: string | null;
  has_mean: boolean;
  has_sum: boolean;
}

export interface StatisticRow {
  start: number;   // Unix ms
  end: number;     // Unix ms
  mean: number | null;
  min: number | null;
  max: number | null;
  sum: number | null;
  state: number | null;
  last_reset: number | null;
}

export interface HistoryState {
  // With minimal_response the keys are abbreviated
  s?: string;       // state
  lc?: number;      // last_changed (Unix seconds)
  lu?: number;      // last_updated (Unix seconds)
  // Full keys (first/last entry always has these)
  state?: string;
  last_changed?: number;
  last_updated?: number;
  entity_id?: string;
  attributes?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

function wsUrl(): string {
  return config.haUrl.replace(/^http/, "ws") + "/api/websocket";
}

const COMMAND_TIMEOUT_MS = 30_000;

/**
 * TLS policy: certificates are verified by default.
 * Set HA_INSECURE_TLS=1 to accept self-signed certificates on a local HA.
 *
 * The WebSocket client takes `rejectUnauthorized` directly; Node's global fetch
 * has no per-request equivalent, so the opt-out is applied process-wide (once)
 * to keep REST and WebSocket behaviour consistent.
 */
let tlsPolicyApplied = false;

export function applyTlsPolicy(): boolean {
  const insecure = config.haInsecureTls;
  if (insecure && !tlsPolicyApplied) {
    tlsPolicyApplied = true;
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    logWarn("HA", "TLS certificate verification DISABLED (HA_INSECURE_TLS is set)", {
      scope: "websocket + REST",
    });
  }
  return insecure;
}

type PendingCommand = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let ws: WebSocket | null = null;
let wsReady = false;
let idCounter = 1;
const pending = new Map<number, PendingCommand>();

function nextId(): number {
  return idCounter++;
}

/**
 * Get or create the authenticated WebSocket connection to HA.
 * Resolves when the connection is ready for commands.
 */
export function getConnection(): Promise<WebSocket | McpError> {
  return new Promise((resolve) => {
    if (ws && wsReady) {
      resolve(ws);
      return;
    }

    const insecure = applyTlsPolicy();
    const socket = new WebSocket(wsUrl(), {
      // Verify certificates by default; opt out with HA_INSECURE_TLS=1.
      rejectUnauthorized: !insecure,
    });

    let authDone = false;

    const connectTimer = setTimeout(() => {
      socket.terminate();
      resolve(errUnreachable(config.haUrl));
    }, 10_000);

    socket.on("open", () => {
      // HA sends auth_required immediately on open
    });

    socket.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg["type"] === "auth_required") {
        socket.send(JSON.stringify({ type: "auth", access_token: config.haToken }));
        return;
      }

      if (msg["type"] === "auth_ok") {
        clearTimeout(connectTimer);
        authDone = true;
        ws = socket;
        wsReady = true;
        resolve(socket);
        return;
      }

      if (msg["type"] === "auth_invalid") {
        clearTimeout(connectTimer);
        socket.close();
        resolve(errUnauthorized());
        return;
      }

      if (msg["type"] === "result" && typeof msg["id"] === "number") {
        const pending_cmd = pending.get(msg["id"]);
        if (!pending_cmd) return;
        clearTimeout(pending_cmd.timer);
        pending.delete(msg["id"]);
        if (msg["success"] === true) {
          pending_cmd.resolve(msg["result"]);
        } else {
          const err = msg["error"] as { code: string; message: string } | undefined;
          pending_cmd.reject(new Error(err?.message ?? "Unknown HA error"));
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(connectTimer);
      if (!authDone) {
        resolve(errUnreachable(config.haUrl));
      }
      wsReady = false;
      ws = null;
      // Reject all pending commands
      for (const [, cmd] of pending) {
        clearTimeout(cmd.timer);
        cmd.reject(err);
      }
      pending.clear();
    });

    socket.on("close", () => {
      wsReady = false;
      ws = null;
    });
  });
}

/**
 * Send a command over the WebSocket and await the result.
 */
async function sendCommand(
  payload: Record<string, unknown>
): Promise<unknown | McpError> {
  const startMs = Date.now();
  logInfo("HA", "ws request", {
    type: payload["type"],
    payload: summarizeArgs(payload),
  });
  const connOrErr = await getConnection();
  if ("isError" in connOrErr) return connOrErr;

  const id = nextId();
  const msg = { ...payload, id };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      logWarn("HA", "ws request timeout", {
        type: payload["type"],
        duration_ms: Date.now() - startMs,
      });
      resolve(errTimeout(wsUrl()));
    }, COMMAND_TIMEOUT_MS);

    pending.set(id, {
      resolve: (result) => {
        logInfo("HA", "ws response", {
          type: payload["type"],
          duration_ms: Date.now() - startMs,
          ok: true,
        });
        resolve(result);
      },
      reject: (err) => resolve(errFromCaught(err, `command ${payload["type"]}`)),
      timer,
    });

    (connOrErr as WebSocket).send(JSON.stringify(msg));
  });
}

// ---------------------------------------------------------------------------
// HA REST API (config only — no statistics there)
// ---------------------------------------------------------------------------

export async function fetchHAConfig(): Promise<HAConfig | McpError> {
  try {
    applyTlsPolicy();
    const startMs = Date.now();
    logInfo("HA", "rest request", { method: "GET", path: "/api/config" });
    const res = await fetch(`${config.haUrl}/api/config`, {
      headers: { Authorization: `Bearer ${config.haToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    logInfo("HA", "rest response", {
      method: "GET",
      path: "/api/config",
      status: res.status,
      duration_ms: Date.now() - startMs,
    });
    if (res.status === 401) return errUnauthorized();
    if (!res.ok) return errUnreachable(config.haUrl);
    const raw = await res.json() as {
      time_zone: string;
      location_name: string;
      latitude: number;
      longitude: number;
      version: string;
    };
    return {
      timezone: raw.time_zone,
      locationName: raw.location_name,
      latitude: raw.latitude,
      longitude: raw.longitude,
      version: raw.version,
    };
  } catch {
    return errUnreachable(config.haUrl);
  }
}

// ---------------------------------------------------------------------------
// WebSocket: Registry commands (entity metadata, areas, devices)
// ---------------------------------------------------------------------------

interface EntityRegistryEntry {
  entity_id: string;
  name: string | null;        // user override
  original_name: string | null;
  device_id: string | null;
  area_id: string | null;     // entity-level override (takes priority over device)
  labels: string[];
  platform: string;
  entity_category: string | null;  // "config" | "diagnostic" | null
  hidden_by: string | null;
  disabled_by: string | null;
}

interface DeviceRegistryEntry {
  id: string;
  name: string | null;        // auto name
  name_by_user: string | null; // user-set name
  area_id: string | null;
  manufacturer: string | null;
  model: string | null;
  disabled_by: string | null;
}

// ---------------------------------------------------------------------------
// Discovery types
// ---------------------------------------------------------------------------

export type MetricKind = "power" | "energy" | "temperature" | "humidity" | "motion" | "presence" | "other";

export interface DiscoveryArea {
  area_id: string;
  name: string;
  floor_id: string | null;
  temperature_entity_id: string | null;
  humidity_entity_id: string | null;
}

export interface DiscoveryDevice {
  device_id: string;
  name: string | null;
  user_name: string | null;
  effective_name: string;
  area_id: string | null;
  area_name: string | null;
  manufacturer: string | null;
  model: string | null;
  disabled_by: string | null;
  entity_ids: string[];
}

export interface DiscoveryEntity {
  entity_id: string;
  friendly_name: string;
  registry_name: string | null;
  original_name: string | null;
  device_id: string | null;
  area_id: string | null;
  area_name: string | null;
  device_name: string | null;
  device_class: string | null;
  entity_category: string | null;
  unit: string | null;
  hidden_by: string | null;
  disabled_by: string | null;
  has_mean: boolean;
  has_sum: boolean;
  metric_kind: MetricKind;
}

export interface DiscoveryIndex {
  areas: DiscoveryArea[];
  devices: DiscoveryDevice[];
  entities: DiscoveryEntity[];
  areaById: Map<string, DiscoveryArea>;
  deviceById: Map<string, DiscoveryDevice>;
  entityById: Map<string, DiscoveryEntity>;
  entitiesByDevice: Map<string, DiscoveryEntity[]>;
  devicesByArea: Map<string, DiscoveryDevice[]>;
}

function classifyMetricKind(
  entityId: string,
  deviceClass: string | null,
  unit: string | null,
): MetricKind {
  // Trust device_class first
  if (deviceClass === "power") return "power";
  if (deviceClass === "energy") return "energy";
  if (deviceClass === "temperature") return "temperature";
  if (deviceClass === "humidity") return "humidity";
  if (deviceClass === "motion") return "motion";
  if (deviceClass === "occupancy" || deviceClass === "presence") return "presence";

  // Unit-based fallback
  if (unit === "W" || unit === "kW") return "power";
  if (unit === "kWh" || unit === "Wh" || unit === "MWh") return "energy";
  if (unit === "°C" || unit === "°F" || unit === "K") return "temperature";
  if (unit === "%RH" || unit === "g/m³") return "humidity";

  // Name/id token-based fallback
  const lc = entityId.toLowerCase();
  if (lc.includes("_power") || lc.endsWith("_power")) return "power";
  if (lc.includes("_energy") || lc.includes("_consumption") || lc.includes("summation")) return "energy";
  if (lc.includes("temperature") || lc.includes("_temp")) return "temperature";
  if (lc.includes("humidity")) return "humidity";
  if (lc.includes("motion") || lc.includes("occupancy")) return "motion";

  return "other";
}

interface AreaRegistryEntry {
  area_id: string;
  name: string;
  floor_id: string | null;
  temperature_entity_id: string | null;
  humidity_entity_id: string | null;
}

export interface EnrichedEntity {
  statistic_id: string;
  friendly_name: string;       // best available display name
  device_name: string | null;  // user-set device label
  area_name: string | null;    // room/area
  floor_id: string | null;
  unit: string | null;
  device_class: string | null; // e.g. "power", "energy", "temperature", "timestamp"
  has_mean: boolean;
  has_sum: boolean;
}

/**
 * Builds a full hierarchical discovery index from HA registry data.
 * Covers all entities (not just statistics-backed ones).
 */
export async function fetchDiscoveryIndex(): Promise<DiscoveryIndex | McpError> {
  const [statIdsResult, entityRegResult, deviceRegResult, areaRegResult, statesResult] =
    await Promise.all([
      sendCommand({ type: "recorder/list_statistic_ids" }),
      sendCommand({ type: "config/entity_registry/list" }),
      sendCommand({ type: "config/device_registry/list" }),
      sendCommand({ type: "config/area_registry/list" }),
      (async () => {
        applyTlsPolicy();
        const res = await fetch(`${config.haUrl}/api/states`, {
          headers: { Authorization: `Bearer ${config.haToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return [];
        return res.json() as Promise<Array<{ entity_id: string; attributes: Record<string, unknown> }>>;
      })().catch(() => []),
    ]);

  for (const r of [statIdsResult, entityRegResult, deviceRegResult, areaRegResult]) {
    if (r && typeof r === "object" && "isError" in r) return r as McpError;
  }

  const statIds = statIdsResult as StatisticId[];
  const statMap = new Map<string, StatisticId>();
  for (const s of statIds) statMap.set(s.statistic_id, s);

  const rawEntityReg = entityRegResult as EntityRegistryEntry[];
  const rawDeviceReg = deviceRegResult as DeviceRegistryEntry[];
  const rawAreaReg = areaRegResult as AreaRegistryEntry[];
  const rawStates = statesResult as Array<{ entity_id: string; attributes: Record<string, unknown> }>;

  const statesMap = new Map<string, Record<string, unknown>>();
  for (const s of rawStates) statesMap.set(s.entity_id, s.attributes);

  // Build area index
  const areaById = new Map<string, DiscoveryArea>();
  const areas: DiscoveryArea[] = rawAreaReg.map(a => {
    const area: DiscoveryArea = {
      area_id: a.area_id,
      name: a.name,
      floor_id: a.floor_id,
      temperature_entity_id: a.temperature_entity_id ?? null,
      humidity_entity_id: a.humidity_entity_id ?? null,
    };
    areaById.set(a.area_id, area);
    return area;
  });

  // Build device index
  const deviceById = new Map<string, DiscoveryDevice>();
  const deviceEntityIds = new Map<string, string[]>();
  const devices: DiscoveryDevice[] = rawDeviceReg.map(d => {
    const area = d.area_id ? areaById.get(d.area_id) : undefined;
    const effectiveName = d.name_by_user ?? d.name ?? d.id;
    const device: DiscoveryDevice = {
      device_id: d.id,
      name: d.name,
      user_name: d.name_by_user,
      effective_name: effectiveName,
      area_id: d.area_id,
      area_name: area?.name ?? null,
      manufacturer: d.manufacturer,
      model: d.model,
      disabled_by: d.disabled_by ?? null,
      entity_ids: [],
    };
    deviceById.set(d.id, device);
    deviceEntityIds.set(d.id, []);
    return device;
  });

  // Build entity index
  const entityById = new Map<string, DiscoveryEntity>();
  const entitiesByDevice = new Map<string, DiscoveryEntity[]>();
  const devicesByArea = new Map<string, DiscoveryDevice[]>();

  const entities: DiscoveryEntity[] = rawEntityReg.map(e => {
    const statInfo = statMap.get(e.entity_id);
    const stateAttrs = statesMap.get(e.entity_id);
    const device = e.device_id ? deviceById.get(e.device_id) : undefined;
    const areaId = e.area_id ?? device?.area_id ?? null;
    const area = areaId ? areaById.get(areaId) : undefined;

    const unit = (stateAttrs?.["unit_of_measurement"] as string | undefined)
      ?? statInfo?.unit_of_measurement
      ?? null;
    const deviceClass = (stateAttrs?.["device_class"] as string | undefined) ?? null;
    const haFriendlyName = stateAttrs?.["friendly_name"] as string | undefined;
    const deviceDisplayName = device?.effective_name ?? null;
    const entityDisplayName = e.name ?? e.original_name ?? null;
    const friendlyName =
      haFriendlyName ??
      (deviceDisplayName && entityDisplayName
        ? `${deviceDisplayName} ${entityDisplayName}`
        : deviceDisplayName ?? entityDisplayName ?? e.entity_id);

    const entity: DiscoveryEntity = {
      entity_id: e.entity_id,
      friendly_name: friendlyName,
      registry_name: e.name,
      original_name: e.original_name,
      device_id: e.device_id,
      area_id: areaId,
      area_name: area?.name ?? null,
      device_name: deviceDisplayName,
      device_class: deviceClass,
      entity_category: e.entity_category ?? null,
      unit,
      hidden_by: e.hidden_by ?? null,
      disabled_by: e.disabled_by ?? null,
      has_mean: statInfo?.has_mean ?? false,
      has_sum: statInfo?.has_sum ?? false,
      metric_kind: classifyMetricKind(e.entity_id, deviceClass, unit),
    };

    entityById.set(e.entity_id, entity);

    if (e.device_id) {
      const devEntities = entitiesByDevice.get(e.device_id) ?? [];
      devEntities.push(entity);
      entitiesByDevice.set(e.device_id, devEntities);
      const devEntityIds = deviceEntityIds.get(e.device_id);
      if (devEntityIds) devEntityIds.push(e.entity_id);
    }

    return entity;
  });

  // Populate device.entity_ids from collected lists
  for (const device of devices) {
    device.entity_ids = deviceEntityIds.get(device.device_id) ?? [];
  }

  // Build devicesByArea map
  for (const device of devices) {
    if (device.area_id) {
      const areaDevices = devicesByArea.get(device.area_id) ?? [];
      areaDevices.push(device);
      devicesByArea.set(device.area_id, areaDevices);
    }
  }

  return { areas, devices, entities, areaById, deviceById, entityById, entitiesByDevice, devicesByArea };
}

/**
 * Derives an EnrichedEntity list from an already-built DiscoveryIndex.
 * This is the canonical way to get the statistics-backed entity view —
 * call fetchDiscoveryIndex() once and pass the result here instead of
 * making a second overlapping set of HA calls.
 */
export function deriveEnrichedEntities(index: DiscoveryIndex): EnrichedEntity[] {
  return index.entities
    .filter(e => e.has_mean || e.has_sum)
    .map(e => {
      const floor_id = e.area_id ? (index.areaById.get(e.area_id)?.floor_id ?? null) : null;
      return {
        statistic_id: e.entity_id,
        friendly_name: e.friendly_name,
        device_name: e.device_name,
        area_name: e.area_name,
        floor_id,
        unit: e.unit,
        device_class: e.device_class,
        has_mean: e.has_mean,
        has_sum: e.has_sum,
      };
    });
}

/**
 * Fetches a statistics-backed enriched entity list.
 * Delegates to fetchDiscoveryIndex() so no separate HA calls are made.
 * Prefer using a cached DiscoveryIndex + deriveEnrichedEntities() where possible.
 */
export async function fetchEnrichedEntities(): Promise<EnrichedEntity[] | McpError> {
  const index = await fetchDiscoveryIndex();
  if ("isError" in index) return index;
  return deriveEnrichedEntities(index);
}

/** Returns map of area_id → AreaRegistryEntry, used for direct room→sensor resolution. */
export async function fetchAreaRegistry(): Promise<Map<string, AreaRegistryEntry> | McpError> {
  const result = await sendCommand({ type: "config/area_registry/list" });
  if (result && typeof result === "object" && "isError" in result) return result as McpError;
  const areas = result as AreaRegistryEntry[];
  return areas.reduce((m, a) => m.set(a.area_id, a), new Map<string, AreaRegistryEntry>());
}

// ---------------------------------------------------------------------------
// WebSocket: Statistics commands
// ---------------------------------------------------------------------------

/**
 * recorder/list_statistic_ids
 * Returns all entity IDs that have long-term statistics.
 */
export async function fetchStatisticIds(
  statisticType?: "mean" | "sum"
): Promise<StatisticId[] | McpError> {
  const payload: Record<string, unknown> = { type: "recorder/list_statistic_ids" };
  if (statisticType) payload["statistic_type"] = statisticType;
  const result = await sendCommand(payload);
  if (result && typeof result === "object" && "isError" in result) return result as McpError;
  return result as StatisticId[];
}

/**
 * recorder/statistics_during_period
 * Fetches aggregated statistics for one or more entities over a period.
 * start/end times must be ISO 8601 strings with timezone offset.
 * Returns timestamps in Unix milliseconds.
 */
export async function fetchStatistics(
  statisticIds: string[],
  startTime: Date,
  endTime: Date,
  period: "5minute" | "hour" | "day" | "week" | "month" | "year",
  types: Array<"mean" | "min" | "max" | "sum" | "state" | "change" | "last_reset">
): Promise<Record<string, StatisticRow[]> | McpError> {
  const result = await sendCommand({
    type: "recorder/statistics_during_period",
    statistic_ids: statisticIds,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    period,
    types,
  });
  if (result && typeof result === "object" && "isError" in result) return result as McpError;
  return result as Record<string, StatisticRow[]>;
}

/**
 * history/history_during_period
 * Fetches raw state history for one or more entities.
 * Use for binary sensors and session detection (power threshold analysis).
 */
export async function fetchHistory(
  entityIds: string[],
  startTime: Date,
  endTime: Date
): Promise<Record<string, HistoryState[]> | McpError> {
  const result = await sendCommand({
    type: "history/history_during_period",
    entity_ids: entityIds,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    include_start_time_state: true,
    significant_changes_only: false,
    minimal_response: true,
    no_attributes: true,
  });
  if (result && typeof result === "object" && "isError" in result) return result as McpError;
  return result as Record<string, HistoryState[]>;
}
