import { getCachedDiscoveryIndex, setCachedDiscoveryIndex } from "../cache.js";
import { fetchDiscoveryIndex, DiscoveryDevice, DiscoveryEntity, MetricKind } from "../ha-client.js";
import { isError, errFromCaught } from "../errors.js";
import { config } from "../config.js";

export const LIST_DEVICES_TOOL = {
  name: "ha_history_list_devices",
  description:
    `Lists devices in ${config.haName}, filtered by area or search.\n` +
    `Use area for room-based discovery and search for device or appliance lookup.\n` +
    `Returns matched devices together with analytics-ready entity_ids on each device.\n` +
    `Use the returned entity_ids directly with the analytics tools. Call ha_history_list_device_entities only when you need deeper per-device inspection.`,
  inputSchema: {
    type: "object",
    properties: {
      area: {
        type: "string",
        description:
          `Filter by area name (case-insensitive). Use the area name from ha_history_list_areas.\n` +
          `Leave empty to list all devices across all areas.`,
      },
      search: {
        type: "string",
        description:
          `Optional search term matched against device names (case-insensitive substring match).\n` +
          `E.g. "charger", "climate", "motion". Returns devices whose name contains the term.`,
      },
      include_disabled: {
        type: "boolean",
        description: `When true, includes disabled devices. Default: false.`,
      },
      max_results: {
        type: "number",
        description: `Maximum number of results to return. Default: unlimited when search or area is provided.`,
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/**
 * Score a device against an optional search term.
 * Returns a numeric score — higher is better, -1 means no match.
 */
/**
 * Return true if any word in `deviceName` matches `searchWord` by:
 *   - exact match
 *   - deviceWord starts with searchWord  (searchWord is a prefix, e.g. "charg" → "charging")
 *   - searchWord starts with deviceWord  (symmetric prefix)
 *   - stem match: deviceWord starts with searchWord[0..-2] when stem length >= 4
 *     (handles morphological variants: "charger"→stem "charg" matches "charging")
 */
function wordMatchesAny(deviceName: string, searchWord: string): boolean {
  const dWords = deviceName.split(/\s+/).filter(w => w.length > 0);
  if (dWords.length === 0) return false;
  for (const dw of dWords) {
    if (dw === searchWord) return true;
    if (dw.startsWith(searchWord)) return true;
    if (searchWord.startsWith(dw)) return true;
    // stem-match forward: strip 2 chars from search word, see if device word has that prefix
    // "charger"→stem "charg" matches "charging"
    if (searchWord.length >= 5) {
      const stem = searchWord.slice(0, -2);
      if (stem.length >= 4 && dw.startsWith(stem)) return true;
    }
    // stem-match reverse: strip 2 chars from device word, see if search word starts with that prefix
    // "heater"→stem "heat" matches "heating"
    if (dw.length >= 5) {
      const dStem = dw.slice(0, -2);
      if (dStem.length >= 4 && searchWord.startsWith(dStem)) return true;
    }
  }
  return false;
}

export function scoreDevice(device: DiscoveryDevice, search: string | undefined): number {
  if (!search) return 0;
  const lc = search.toLowerCase();
  const userName = (device.user_name ?? "").toLowerCase();
  const defaultName = (device.name ?? "").toLowerCase();

  // Exact / prefix / substring on full search string — user-set name scores higher
  if (userName === lc) return 4;
  if (userName.startsWith(lc)) return 3;
  if (userName.includes(lc)) return 2;
  if (defaultName === lc) return 2;
  if (defaultName.startsWith(lc)) return 1;
  if (defaultName.includes(lc)) return 1;

  // Word-level matching: every search word must match at least one device name word
  const sWords = lc.split(/\s+/).filter(w => w.length > 0);
  if (sWords.length > 0) {
    const allMatch = (name: string) => sWords.every(sw => wordMatchesAny(name, sw));
    if (allMatch(userName)) return 2;
    if (allMatch(defaultName)) return 1;
    // Partial: at least one search word matches (good for single-word searches like "charger")
    const anyMatch = (name: string) => sWords.some(sw => wordMatchesAny(name, sw));
    if (sWords.length === 1 && anyMatch(userName)) return 2;
    if (sWords.length === 1 && anyMatch(defaultName)) return 1;
  }

  return -1;
}

/**
 * Compute the distinct metric kinds present on a device's entities.
 * Excludes diagnostic/config/hidden/disabled entities unless they are all that exist.
 */
export function deviceMetricSummary(entities: DiscoveryEntity[]): MetricKind[] {
  const useful = entities.filter(
    e => !e.entity_category && !e.hidden_by && !e.disabled_by
  );
  const pool = useful.length > 0 ? useful : entities;
  const kinds = new Set<MetricKind>(pool.map(e => e.metric_kind));
  kinds.delete("other");
  // Put "other" back only if it's the only kind
  if (kinds.size === 0) kinds.add("other");
  return [...kinds].sort();
}

function scoreDeviceEntity(entity: DiscoveryEntity): number {
  let score = 0;

  if (entity.has_mean || entity.has_sum) score += 3;
  else score -= 4;

  if (entity.entity_category === "diagnostic" || entity.entity_category === "config") score -= 3;
  if (entity.hidden_by) score -= 2;
  if (entity.disabled_by) score -= 2;

  if (entity.has_sum) score += 1;
  if (entity.has_mean) score += 1;
  if (entity.metric_kind !== "other") score += 1;

  return score;
}

function selectDeviceEntities(entities: DiscoveryEntity[]): DiscoveryEntity[] {
  const scored = entities
    .map((entity) => ({ entity, score: scoreDeviceEntity(entity) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || a.entity.entity_id.localeCompare(b.entity.entity_id));

  const selected: DiscoveryEntity[] = [];
  const seenKinds = new Set<string>();

  for (const { entity } of scored) {
    const kindKey = `${entity.metric_kind}:${entity.has_sum ? "sum" : entity.has_mean ? "mean" : "none"}`;
    if (!seenKinds.has(kindKey) || selected.length < 3) {
      selected.push(entity);
      seenKinds.add(kindKey);
    }
    if (selected.length >= 4) break;
  }

  return selected;
}

function analyticsLabel(entity: DiscoveryEntity): string {
  if (entity.has_sum) return "cumulative";
  if (entity.has_mean) return "measurement";
  return "no-stats";
}

export async function handleListDevices(
  args: Record<string, unknown>
): Promise<string> {
  try {
    const areaArg = typeof args["area"] === "string" ? args["area"].trim() : undefined;
    const search = typeof args["search"] === "string" ? args["search"].trim() : undefined;
    const includeDisabled = args["include_disabled"] === true;
    // Only apply a cap when max_results is explicitly provided; unfiltered calls require a filter
    const rawMax = args["max_results"];
    if (rawMax !== undefined && (typeof rawMax !== "number" || !Number.isFinite(rawMax) || rawMax <= 0)) {
      return (
        `ERROR: Invalid max_results ${JSON.stringify(rawMax)} — the call was NOT executed. ` +
        `Pass a positive number, or omit it for the unlimited filtered list.`
      );
    }
    const maxResultsArg = rawMax as number | undefined;

    if (!areaArg && !search) {
      // Block unfiltered browse — would return too many results to be useful
      let index = getCachedDiscoveryIndex();
      if (!index) {
        const result = await fetchDiscoveryIndex();
        if (isError(result)) return result.text;
        setCachedDiscoveryIndex(result);
        index = result;
      }
      const total = index.devices.filter(d => includeDisabled || !d.disabled_by).length;
      return (
        `${total} devices in ${config.haName}. Use search= or area= to narrow results.\n` +
        `Areas available: ${index.areas.map(a => a.name).join(", ")}\n` +
        `Example: ha_history_list_devices with search="charger" or area="Kitchen"`
      );
    }

    let index = getCachedDiscoveryIndex();
    if (!index) {
      const result = await fetchDiscoveryIndex();
      if (isError(result)) return result.text;
      setCachedDiscoveryIndex(result);
      index = result;
    }

    // Resolve area filter
    let resolvedAreaName: string | undefined;
    let filteredDevices = index.devices;

    if (areaArg) {
      const lcArea = areaArg.toLowerCase();
      const matchedArea = index.areas.find(a => a.name.toLowerCase() === lcArea)
        ?? index.areas.find(a => a.name.toLowerCase().includes(lcArea));

      if (!matchedArea) {
        return (
          `ERROR: No area found matching "${areaArg}" in ${config.haName}.\n` +
          `Available areas: ${index.areas.map(a => a.name).join(", ")}\n` +
          `Retry with one of these exact names.`
        );
      }
      resolvedAreaName = matchedArea.name;
      filteredDevices = index.devicesByArea.get(matchedArea.area_id) ?? [];
    }

    // Exclude disabled unless requested
    if (!includeDisabled) {
      filteredDevices = filteredDevices.filter(d => !d.disabled_by);
    }

    // Apply search filter and rank
    if (search) {
      const scored = filteredDevices
        .map(d => ({ device: d, score: scoreDevice(d, search) }))
        .filter(({ score }) => score >= 0);
      scored.sort((a, b) => b.score - a.score);
      filteredDevices = scored.map(s => s.device);
    } else {
      filteredDevices = [...filteredDevices].sort((a, b) =>
        a.effective_name.localeCompare(b.effective_name)
      );
    }

    const limited = maxResultsArg !== undefined ? filteredDevices.slice(0, maxResultsArg) : filteredDevices;

    if (limited.length === 0) {
      const areaHint = resolvedAreaName ? ` in area "${resolvedAreaName}"` : "";
      const searchHint = search ? ` matching "${search}"` : "";
      // Closed-world refusal: name every device in scope so this one empty
      // result is terminal evidence, not an invitation to try more synonyms.
      const scope = resolvedAreaName
        ? (index.devicesByArea.get(index.areas.find((a) => a.name === resolvedAreaName)?.area_id ?? "") ?? [])
        : index.devices;
      const scopeNames = scope
        .filter((d) => includeDisabled || !d.disabled_by)
        .map((d) => d.effective_name)
        .sort((a, b) => a.localeCompare(b));
      const shown = scopeNames.slice(0, 60);
      const more = scopeNames.length > 60 ? `, +${scopeNames.length - 60} more (narrow with area=)` : "";
      return (
        `No devices found${areaHint}${searchHint} in ${config.haName}.\n` +
        `Complete inventory — ALL ${scopeNames.length} devices${areaHint || " on this instance"}: ` +
        `${shown.join(", ")}${more}.\n` +
        `If what you are looking for is not in this list, it does NOT exist in this Home Assistant ` +
        `instance — do not try more search words. Tell the user it is not monitored, or ask them for the exact name. ` +
        `These devices may be in OTHER rooms than the one asked about — never present one as if it were ` +
        `in the requested room; say so and ask before using a substitute.`
      );
    }

    const areaLabel = resolvedAreaName ? ` in area "${resolvedAreaName}"` : "";
    const searchLabel = search ? ` (search=${search})` : "";
    const lines: string[] = [
      `${limited.length} device${limited.length === 1 ? "" : "s"} found${areaLabel}${searchLabel} in ${config.haName}:\n`,
    ];

    for (const device of limited) {
      const entities = index.entitiesByDevice.get(device.device_id) ?? [];
      const metrics = deviceMetricSummary(entities);
      const selectedEntities = selectDeviceEntities(entities);
      const metricsLabel = metrics.length > 0 ? `Metrics: ${metrics.join(", ")}` : "No analytics entities";
      const mfgHint = device.manufacturer ? ` [${device.manufacturer}]` : "";
      lines.push(`  ${device.effective_name}${mfgHint}`);
      lines.push(`    ${metricsLabel}`);
      if (selectedEntities.length > 0) {
        lines.push(`    Ready entities:`);
        for (const entity of selectedEntities) {
          lines.push(
            `      - ${entity.entity_id} (${entity.metric_kind}, ${analyticsLabel(entity)})`
          );
        }
      } else {
        lines.push(`    Ready entities: none`);
      }
    }

    if (maxResultsArg !== undefined && filteredDevices.length > maxResultsArg) {
      lines.push(`\nShowing ${maxResultsArg} of ${filteredDevices.length}. Use a narrower search term or area filter, or raise max_results.`);
    }
    lines.push(
      `\nNext: pass a Ready entity_id to ha_history_get_sensor_stats (measurement) or ` +
      `ha_history_get_consumption (cumulative); ha_history_list_device_entities only for more entities from one device.`
    );

    return lines.join("\n");
  } catch (err) {
    return errFromCaught(err, "ha_history_list_devices").text;
  }
}
