import { config } from "../config.js";
import { errFromCaught, errHttp, errUnauthorized } from "../errors.js";
import { logInfo } from "../logger.js";
import { getTz, toLocalTimestamp } from "../tool-utils.js";

export const GET_STATE_TOOL = {
  name: "ha_history_get_state",
  description:
    `Returns the current state of one ${config.haName} entity by exact entity_id.\n` +
    `Works for all entity domains, including entities not exposed to the voice assistant.\n` +
    `Returns the state value, unit, last_changed/last_updated timestamps, and key attributes.\n` +
    `If a GetLiveContext tool is available, prefer it for current values of exposed entities;\n` +
    `use this tool for entities it cannot see, for staleness checks via timestamps, or when the entity_id is already resolved.`,
  inputSchema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description: `Exact entity_id resolved earlier, e.g. "sensor.living_room_temperature". Do not guess.`,
      },
    },
    required: ["entity_id"],
    additionalProperties: false,
  },
};

interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context?: unknown;
}

export async function handleGetState(
  args: Record<string, unknown>
): Promise<string> {
  try {
    const entityId = String(args["entity_id"] ?? "").trim();
    if (!entityId) return `ERROR: entity_id is required.`;

    const startMs = Date.now();
    const path = `/api/states/${encodeURIComponent(entityId)}`;
    logInfo("HA", "rest request", { method: "GET", path, tool: "ha_history_get_state" });
    const res = await fetch(`${config.haUrl}/api/states/${encodeURIComponent(entityId)}`, {
      headers: { Authorization: `Bearer ${config.haToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    logInfo("HA", "rest response", {
      method: "GET",
      path,
      tool: "ha_history_get_state",
      status: res.status,
      duration_ms: Date.now() - startMs,
    });

    if (res.status === 404) {
      return (
        `ERROR: Entity "${entityId}" not found in ${config.haName}.\n` +
        `Call ha_history_list_entities with search="..." to find the correct entity_id.`
      );
    }
    if (res.status === 401) return errUnauthorized().text;
    if (!res.ok) return errHttp(res.status, path).text;

    const s = await res.json() as HAState;
    return formatState(s);

  } catch (err) {
    return errFromCaught(err, "ha_history_get_state").text;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Attributes to always include when present (beyond the state value). */
const USEFUL_ATTRS: Record<string, string[]> = {
  // common
  default: ["friendly_name", "device_class", "unit_of_measurement", "icon"],
  // climate
  climate: ["current_temperature", "temperature", "target_temp_low", "target_temp_high",
            "hvac_mode", "hvac_action", "preset_mode", "humidity", "current_humidity"],
  // device_tracker
  device_tracker: ["latitude", "longitude", "gps_accuracy", "source_type", "battery_level",
                   "altitude", "speed"],
  // zone
  zone: ["latitude", "longitude", "radius", "passive"],
  // media_player
  media_player: ["media_title", "media_artist", "media_album_name", "volume_level",
                 "is_volume_muted", "source", "sound_mode"],
  // cover
  cover: ["current_position", "current_tilt_position"],
  // light
  light: ["brightness", "color_temp", "rgb_color", "effect"],
  // weather
  weather: ["temperature", "humidity", "pressure", "wind_speed", "wind_bearing",
            "visibility", "forecast"],
};

function formatState(s: HAState): string {
  const attrs = s.attributes;
  const domain = s.entity_id.split(".")[0] ?? "unknown";
  const friendlyName = (attrs["friendly_name"] as string | undefined) ?? s.entity_id;
  const unit = (attrs["unit_of_measurement"] as string | undefined) ?? "";
  const deviceClass = attrs["device_class"] as string | undefined;

  // Header — timestamps rendered in the HA timezone like every other tool,
  // not the Node process timezone.
  const stateDisplay = unit ? `${s.state} ${unit}` : s.state;
  const dcNote = deviceClass ? ` [${deviceClass}]` : "";
  const changedAt = toLocalTimestamp(new Date(s.last_changed).getTime(), getTz());

  const lines = [
    `${friendlyName}${dcNote}`,
    `entity_id: ${s.entity_id}`,
    `state: ${stateDisplay}`,
    `last_changed: ${changedAt}`,
  ];

  // Domain-specific attributes
  const wantedKeys = [
    ...(USEFUL_ATTRS[domain] ?? []),
    ...USEFUL_ATTRS.default,
  ];
  const seen = new Set(["friendly_name", "unit_of_measurement", "device_class", "icon"]);

  const extraLines: string[] = [];
  for (const key of wantedKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const val = attrs[key];
    if (val === undefined || val === null) continue;
    if (typeof val === "object" && !Array.isArray(val)) continue; // skip nested objects
    const valStr = Array.isArray(val) ? JSON.stringify(val) : String(val);
    extraLines.push(`${key}: ${valStr}`);
  }

  if (extraLines.length > 0) {
    lines.push("", ...extraLines);
  }

  return lines.join("\n");
}
