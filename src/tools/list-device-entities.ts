import { getCachedDiscoveryIndex, setCachedDiscoveryIndex } from "../cache.js";
import {
  fetchDiscoveryIndex,
  DiscoveryEntity,
  MetricKind,
  DiscoveryIndex,
} from "../ha-client.js";
import { isError, errFromCaught } from "../errors.js";
import { config } from "../config.js";
import { scoreDevice } from "./list-devices.js";
import { fenceTable } from "../tool-utils.js";

export const LIST_DEVICE_ENTITIES_TOOL = {
  name: "ha_history_list_device_entities",
  description:
    `Lists entities (sensors and controls) on a specific device in ${config.haName}.\n` +
    `Use when ha_history_list_devices did not already surface the needed entity_ids or when you need a deeper per-device inspection.\n` +
    `Returns entity_ids with their metric kind and analytics capability.\n` +
    `Use measurement sensors with ha_history_get_sensor_stats and cumulative counters with ha_history_get_consumption.`,
  inputSchema: {
    type: "object",
    properties: {
      device: {
        type: "string",
        description:
          `Device name (case-insensitive). Use the device name from ha_history_list_devices.\n` +
          `Partial name match is supported, e.g. "car charging" matches "Car Charging Plug".`,
      },
      device_class: {
        type: "string",
        enum: ["power", "energy", "temperature", "humidity", "motion", "presence"],
        description:
          `Optional metric-type filter, e.g. "power".\n` +
          `Leave empty to show all analytics-capable entities on the device.`,
      },
      include_diagnostics: {
        type: "boolean",
        default: false,
        description: `When true, includes diagnostic and config entities. Default: false.`,
      },
      max_results: {
        type: "number",
        default: 20,
        description: `Maximum number of results to return. Default: 20.`,
      },
    },
    required: ["device"],
    additionalProperties: false,
  },
};

/**
 * Score an entity for relevance given an optional target metric kind.
 * Returns a numeric score — higher is better, -1 means filtered out.
 */
export function scoreEntity(
  entity: DiscoveryEntity,
  targetMetric: MetricKind | undefined,
): number {
  // Hard filter: metric kind must match if specified
  if (targetMetric && entity.metric_kind !== targetMetric) return -1;

  let score = 0;

  // Analytics capability bonus
  if (entity.has_mean || entity.has_sum) score += 2;

  // Diagnostic/config penalty
  if (
    entity.entity_category === "diagnostic" ||
    entity.entity_category === "config"
  )
    score -= 3;

  // Hidden/disabled penalty
  if (entity.hidden_by) score -= 2;
  if (entity.disabled_by) score -= 2;

  // Prefer measurement (has_mean) for activity/level metrics
  // Prefer cumulative (has_sum) for energy/consumption
  if (entity.metric_kind === "energy" && entity.has_sum) score += 1;
  if (entity.metric_kind !== "energy" && entity.has_mean) score += 1;

  return score;
}

/**
 * Try to find a device by name in the discovery index using the same
 * scoring strategy as list-devices (scoreDevice), so both steps of the
 * discovery flow behave consistently.
 */
function resolveDevice(
  index: DiscoveryIndex,
  deviceArg: string,
): { device_id: string; effective_name: string; runnersUp: string[] } | { error: string } {
  // Models copy device names verbatim from list_devices output, which appends
  // the manufacturer in brackets ("Aquara Motion - Compresseur [LUMI]") —
  // strip that suffix so the copied-back form resolves (observed live, twice).
  const cleaned = deviceArg.replace(/\s*\[[^\]]*\]\s*$/, "");
  const scored = index.devices
    .map((d) => ({ device: d, score: scoreDevice(d, cleaned) }))
    .filter((s) => s.score >= 0);

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      error:
        `ERROR: No device found matching "${deviceArg}" in ${config.haName}.\n` +
        `Call ha_history_list_devices with search="..." to see available devices.`,
    };
  }

  // Other plausible matches are reported so a wrong resolution is vetoable,
  // never a silent guess.
  return {
    device_id: scored[0].device.device_id,
    effective_name: scored[0].device.effective_name,
    runnersUp: scored.slice(1, 4).map((s) => s.device.effective_name),
  };
}

export async function handleListDeviceEntities(
  args: Record<string, unknown>,
): Promise<string> {
  try {
    // Migration teaching error: "metric" was renamed to device_class (2026-08)
    // to keep one name per role across the discovery tools.
    if (args["metric"] !== undefined) {
      return (
        `ERROR: Parameter "metric" was renamed — use device_class. ` +
        `Example: device_class=${JSON.stringify(String(args["metric"]))}.`
      );
    }

    const deviceArg =
      typeof args["device"] === "string" ? args["device"].trim() : "";
    const metricArg =
      typeof args["device_class"] === "string"
        ? args["device_class"].toLowerCase().trim()
        : undefined;
    const includeDiagnostics = args["include_diagnostics"] === true;
    const rawMax = args["max_results"];
    if (rawMax !== undefined && (typeof rawMax !== "number" || !Number.isFinite(rawMax) || rawMax <= 0)) {
      return (
        `ERROR: Invalid max_results ${JSON.stringify(rawMax)} — the call was NOT executed. ` +
        `Pass a positive number. Default: 20.`
      );
    }
    const maxResults = rawMax !== undefined ? (rawMax as number) : 20;

    if (!deviceArg) {
      return `ERROR: "device" parameter is required. Call ha_history_list_devices to find device names.`;
    }

    const METRIC_KINDS: MetricKind[] = [
      "power",
      "energy",
      "temperature",
      "humidity",
      "motion",
      "presence",
    ];
    if (metricArg && !METRIC_KINDS.includes(metricArg as MetricKind)) {
      return (
        `ERROR: Invalid device_class "${metricArg}". Supported values: ${METRIC_KINDS.join(", ")}.\n` +
        `Leave device_class empty to show all entities on the device.`
      );
    }
    const targetMetric: MetricKind | undefined = metricArg as
      | MetricKind
      | undefined;

    let index = getCachedDiscoveryIndex();
    if (!index) {
      const result = await fetchDiscoveryIndex();
      if (isError(result)) return result.text;
      setCachedDiscoveryIndex(result);
      index = result;
    }

    const resolved = resolveDevice(index, deviceArg);
    if ("error" in resolved) return resolved.error;

    const { device_id, effective_name, runnersUp } = resolved;
    const allEntities = index.entitiesByDevice.get(device_id) ?? [];

    // Filter diagnostics unless explicitly included
    const candidates = includeDiagnostics
      ? allEntities
      : allEntities.filter(
          (e) =>
            e.entity_category !== "diagnostic" &&
            e.entity_category !== "config",
        );

    // Score and filter
    // Score entities; when diagnostics are explicitly requested keep all, otherwise
    // use a soft score floor to discard very low-value entries.
    const scored = candidates.map((e) => ({
      entity: e,
      score: scoreEntity(e, targetMetric),
    }));
    const softFiltered = includeDiagnostics
      ? scored
      : scored.filter(({ score }) => score >= -2);

    // If all are filtered out by metric, relax to show what exists — but say
    // so: a relaxed result must never be labeled as if the filter held.
    const passing = softFiltered.filter((s) => s.score >= 0);
    const relaxed = !includeDiagnostics && passing.length === 0 && softFiltered.length > 0 && targetMetric !== undefined;
    const pool =
      includeDiagnostics || passing.length === 0 ? softFiltered : passing;
    pool.sort((a, b) => b.score - a.score);

    const limited = pool.slice(0, maxResults);

    if (limited.length === 0) {
      const metricHint = metricArg ? ` with device_class="${metricArg}"` : "";
      return (
        `No entities found on device "${effective_name}"${metricHint} in ${config.haName}.\n` +
        `Tips: try a different device_class or set include_diagnostics=true to see all entities.`
      );
    }

    const metricLabel = metricArg && !relaxed ? ` (device_class=${metricArg})` : "";

    const rows = limited.map(({ entity: e }) => {
      const cap = e.has_sum
        ? "cumulative"
        : e.has_mean
          ? "measurement"
          : "no-stats";
      const flags: string[] = [];
      if (e.entity_category === "diagnostic") flags.push("diagnostic");
      if (e.hidden_by) flags.push("hidden");
      if (e.disabled_by) flags.push("disabled");
      const flagStr = flags.length > 0 ? ` [${flags.join(",")}]` : "";
      return `${e.entity_id} | ${e.friendly_name} | ${e.metric_kind} | ${cap}${flagStr}`;
    });

    const lines: string[] = [
      `${limited.length} entit${limited.length === 1 ? "y" : "ies"} on device "${effective_name}"${metricLabel} in ${config.haName}:\n`,
      fenceTable(["entity_id | friendly_name | kind | analytics", ...rows]),
    ];

    if (relaxed) {
      lines.push(
        `\nNote: no entities matched device_class="${metricArg}" on this device — showing all its entities instead.`,
      );
    }
    if (runnersUp.length > 0) {
      lines.push(
        `\nResolved "${deviceArg}" to "${effective_name}". Other matching devices: ${runnersUp.join(", ")} — call again with the exact name if this is the wrong one.`,
      );
    }
    if (pool.length > maxResults) {
      lines.push(
        `\nShowing ${maxResults} of ${pool.length}. Use device_class= to narrow, or raise max_results.`,
      );
    }
    lines.push(
      `\nNext: use the entity_id with ha_history_get_sensor_stats (measurement) or ha_history_get_consumption (cumulative).`,
    );

    return lines.join("\n");
  } catch (err) {
    return errFromCaught(err, "ha_history_list_device_entities").text;
  }
}
