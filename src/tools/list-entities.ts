import { getCachedEntityList, setCachedEntityList } from "../cache.js";
import { fetchEnrichedEntities } from "../ha-client.js";
import { isError, errFromCaught } from "../errors.js";
import { config } from "../config.js";
import { logInfo } from "../logger.js";
import { fenceTable, parseMaxResults } from "../tool-utils.js";

/** Domains that have no long-term statistics — always served from live /api/states. */
const LIVE_ONLY_DOMAINS = new Set([
  "binary_sensor",
  "device_tracker",
  "zone",
  "input_boolean",
  "input_select",
  "input_text",
  "person",
]);

export const LIST_ENTITIES_TOOL = {
  name: "ha_history_list_entities",
  description:
    `Primary discovery tool for the exact entity_ids that the ha_history_* analytics tools require.\n` +
    `Filter by area, device, device_class, and search.\n` +
    `Results are grouped by area and device and include entity_id, name, unit, and type.\n` +
    `For one entity's live state, use ha_history_get_state after discovery.\n` +
    `Not needed before device-control (Hass*) tools — those take plain names and areas, never entity_ids.`,
  inputSchema: {
    type: "object",
    properties: {
      domains: {
        type: "array",
        items: { type: "string" },
        description:
          `Optional entity domains, e.g. ["sensor"], ["binary_sensor"], or ["person","device_tracker"]\n` +
          `for person tracking. Leave empty for statistics-ready entities.`,
      },
      search: {
        type: "string",
        description:
          `Matched against entity_id, friendly name, and device name. Multiple words use AND semantics.\n` +
          `Use for name words like "cave" or "charger", not type words that device_classes can express.`,
      },
      areas: {
        type: "array",
        items: { type: "string" },
        description: `Optional area/room filter, e.g. ["Kitchen"] or ["Cave", "Kitchen", "Salon", "Outdoor"].`,
      },
      device: {
        type: "string",
        description: `Optional device-name filter when the user clearly refers to one appliance or device.`,
      },
      device_classes: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "temperature",
            "humidity",
            "power",
            "energy",
            "motion",
            "occupancy",
            "presence",
          ],
        },
        description: `Optional device-class filter, e.g. ["temperature"] or ["temperature", "humidity"].`,
      },
      include_state: {
        type: "boolean",
        default: false,
        description:
          `When true, adds the current state value to each row. Default: false.\n` +
          `Costs one extra full state-machine fetch — use only when current values matter.`,
      },
      max_results: {
        type: ["number", "string"],
        default: 100,
        description: `Max entity rows to return. Default: 100. Pass "all" for the complete list.`,
      },
    },
    required: [],
    additionalProperties: false,
  },
};

type EntityTypeFilter =
  | "temperature"
  | "humidity"
  | "power"
  | "energy"
  | "motion"
  | "occupancy"
  | "presence";

function inferMetric(entity: {
  statistic_id: string;
  friendly_name?: string | null;
  device_name?: string | null;
  device_class: string | null;
  unit: string | null;
}): EntityTypeFilter | "other" {
  const deviceClass = entity.device_class;
  const entityId = entity.statistic_id.toLowerCase();
  const friendlyName = (entity.friendly_name ?? "").toLowerCase();
  const deviceName = (entity.device_name ?? "").toLowerCase();

  const combined = `${entityId} ${friendlyName} ${deviceName}`;

  if (deviceClass === "power") return "power";
  if (deviceClass === "energy") return "energy";
  if (deviceClass === "temperature") return "temperature";
  if (deviceClass === "humidity") return "humidity";
  if (deviceClass === "motion") return "motion";
  if (deviceClass === "occupancy") return "occupancy";
  if (deviceClass === "presence") return "presence";

  if (entity.unit === "W" || entity.unit === "kW") return "power";
  if (entity.unit === "kWh" || entity.unit === "Wh" || entity.unit === "MWh")
    return "energy";

  if (combined.includes("_power") || combined.includes(" power"))
    return "power";
  if (
    combined.includes("_energy") ||
    combined.includes("summation") ||
    combined.includes("consumption") ||
    combined.includes(" energy")
  )
    return "energy";
  if (combined.includes("temperature") || combined.includes(" temp"))
    return "temperature";
  if (combined.includes("humidity") || combined.includes(" humid"))
    return "humidity";
  if (combined.includes("motion")) return "motion";
  if (combined.includes("occupancy")) return "occupancy";
  if (combined.includes("presence")) return "presence";

  return "other";
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) =>
      typeof entry === "string" ? entry.trim().toLowerCase() : "",
    )
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function normalizeTextFilter(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDomainInput(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const normalized = normalizeTextFilter(value);
    return normalized ? [normalized] : undefined;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) =>
        typeof entry === "string" ? entry.trim().toLowerCase() : "",
      )
      .filter((entry) => entry.length > 0);
    return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
  }
  return undefined;
}

function matchesSubstringFilter(
  candidate: string | null | undefined,
  filter: string | undefined,
): boolean {
  if (!filter) return true;
  return (candidate ?? "").toLowerCase().includes(filter);
}

function matchesAnySubstringFilter(
  candidate: string | null | undefined,
  filters: string[] | undefined,
): boolean {
  if (!filters || filters.length === 0) return true;
  const normalized = (candidate ?? "").toLowerCase();
  return filters.some((filter) => normalized.includes(filter));
}

function matchesSearchTerms(
  fields: (string | null | undefined)[],
  searchTerms: string[] | undefined,
): boolean {
  if (!searchTerms || searchTerms.length === 0) return true;
  const joined = fields.filter(Boolean).join(" ").toLowerCase();
  return searchTerms.every((term) => joined.includes(term));
}

function isLikelyAmbientEntity(
  entity: {
    statistic_id: string;
    friendly_name: string;
    device_name: string | null;
    device_class: string | null;
  },
  requestedTypes: EntityTypeFilter[] | undefined,
  explicitDeviceFilter: string | undefined,
): boolean {
  if (!requestedTypes || requestedTypes.length === 0 || explicitDeviceFilter)
    return true;

  const targeted = requestedTypes.filter(
    (value) => value === "temperature" || value === "humidity",
  );
  if (targeted.length === 0) return true;

  const combined =
    `${entity.statistic_id} ${entity.friendly_name} ${entity.device_name ?? ""}`.toLowerCase();
  const rejectTokens = [
    "battery",
    "target",
    "setpoint",
    "current",
    "internal",
    "extruder",
    "bed",
  ];
  return !rejectTokens.some((token) => combined.includes(token));
}

/**
 * Terminal stop rule appended to every closed-world zero-result payload.
 * An empty search result alone invites another synonym guess; paired with the
 * inventory of what DOES exist, it becomes terminal evidence (Benchmark2:
 * proving "no EV charger" took 13-17 rounds of synonym search without this).
 */
const STOP_RULE =
  `If what you are looking for is not in the inventory above, it does NOT exist in this ` +
  `Home Assistant instance — do not try more search words. Tell the user it is not ` +
  `monitored, or ask them for the exact name. The listed devices may belong to OTHER ` +
  `rooms/areas than the one asked about — never present one as if it were in the ` +
  `requested room; say the requested room has none and ask before using a substitute.`;

/**
 * Closed-world inventory of the statistics catalog: what IS monitored, scoped
 * to the requested device classes when given, otherwise per-class counts.
 */
function statsInventory(
  entities: NonNullable<ReturnType<typeof getCachedEntityList>>,
  requestedTypes: EntityTypeFilter[] | undefined,
): string {
  if (requestedTypes && requestedTypes.length > 0) {
    const lines = requestedTypes.map((cls) => {
      const names = new Set<string>();
      let count = 0;
      for (const e of entities) {
        if (inferMetric(e) === cls) {
          count++;
          names.add(e.device_name ?? e.friendly_name);
        }
      }
      if (count === 0) return `  ${cls}: none monitored`;
      const shown = [...names].slice(0, 15);
      const more = names.size > 15 ? `, +${names.size - 15} more` : "";
      return `  ${cls} (${count} entities): ${shown.join(", ")}${more}`;
    });
    return `Complete inventory of monitored devices for the requested class(es):\n${lines.join("\n")}`;
  }
  const counts = new Map<string, number>();
  for (const e of entities) {
    const cls = inferMetric(e);
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cls, n]) => `${cls} (${n})`)
    .join(", ");
  return `Complete inventory by class — this instance monitors: ${summary}.`;
}

export async function handleListEntities(
  args: Record<string, unknown>,
): Promise<string> {
  try {
    // Migration teaching errors: singular variants and the legacy "metric"
    // alias were removed in the singular/plural merge (2026-08). Reachable on
    // direct handler calls; MCP dispatch rejects them as unknown parameters.
    const removedParams: Array<[string, string]> = [
      ["domain", "domains"],
      ["area", "areas"],
      ["device_class", "device_classes"],
      ["metric", "device_classes"],
    ];
    for (const [removed, replacement] of removedParams) {
      if (args[removed] !== undefined) {
        return (
          `ERROR: Parameter "${removed}" was removed — use ${replacement} (an array). ` +
          `Example: ${replacement}=[${JSON.stringify(String(args[removed]))}].`
        );
      }
    }

    const requestedDomains = normalizeDomainInput(args["domains"]);
    const searchRaw = normalizeTextFilter(args["search"]);
    const areas = normalizeStringArray(args["areas"]);
    const device = normalizeTextFilter(args["device"]);
    const deviceClasses = normalizeStringArray(args["device_classes"]);
    const searchTerms = searchRaw
      ? searchRaw.split(/\s+/).filter(Boolean)
      : undefined;
    const includeState = args["include_state"] === true;
    const capParsed = parseMaxResults(args["max_results"], 100);
    if (typeof capParsed === "string") return capParsed;
    const { returnAll, rowCap } = capParsed;
    const cap = returnAll ? Infinity : rowCap;

    const areaFilters = areas;
    const validTypes: EntityTypeFilter[] = [
      "temperature",
      "humidity",
      "power",
      "energy",
      "motion",
      "occupancy",
      "presence",
    ];

    const domain =
      requestedDomains?.length === 1 ? requestedDomains[0] : undefined;
    const domainLabel = requestedDomains?.join(",");
    const hasMultipleDomains = (requestedDomains?.length ?? 0) > 1;
    const allDomainsLiveOnly =
      requestedDomains !== undefined &&
      requestedDomains.every((value) => LIVE_ONLY_DOMAINS.has(value));

    if (
      deviceClasses &&
      deviceClasses.some(
        (value) => !validTypes.includes(value as EntityTypeFilter),
      )
    ) {
      return `ERROR: Invalid device_classes value. Valid values: ${validTypes.join(", ")}.`;
    }

    const requestedTypes = deviceClasses
      ? (deviceClasses as EntityTypeFilter[])
      : undefined;

    // -----------------------------------------------------------------------
    // Live-only domains (no long-term statistics) — serve from /api/states
    // -----------------------------------------------------------------------
    const isLiveOnly =
      requestedDomains !== undefined &&
      (hasMultipleDomains
        ? allDomainsLiveOnly
        : domain !== undefined && LIVE_ONLY_DOMAINS.has(domain));

    if (!isLiveOnly) {
      if (hasMultipleDomains) {
        return `ERROR: Multiple domains are only supported for live-state discovery domains such as person and device_tracker. Pass one domain, e.g. domains=["sensor"].`;
      }

      // Normal path: search statistics entities (fast, cached)
      let entities = getCachedEntityList();
      if (!entities) {
        const result = await fetchEnrichedEntities();
        if (isError(result)) return result.text;
        setCachedEntityList(result);
        entities = result;
      }

      let filtered = entities;
      if (domain) {
        filtered = filtered.filter((e) =>
          e.statistic_id.startsWith(`${domain}.`),
        );
      }
      if (areaFilters) {
        filtered = filtered.filter((e) =>
          matchesAnySubstringFilter(e.area_name, areaFilters),
        );
      }
      if (device) {
        filtered = filtered.filter((e) =>
          matchesSubstringFilter(e.device_name, device),
        );
      }
      let ambientExcluded = 0;
      if (requestedTypes) {
        filtered = filtered.filter((e) =>
          requestedTypes.includes(inferMetric(e) as EntityTypeFilter),
        );
        // The ambient heuristic narrows results — its exclusions are counted
        // and confessed in the payload, never applied silently.
        const beforeAmbient = filtered.length;
        filtered = filtered.filter((e) =>
          isLikelyAmbientEntity(e, requestedTypes, device),
        );
        ambientExcluded = beforeAmbient - filtered.length;
      }
      if (searchTerms) {
        filtered = filtered.filter((e) =>
          matchesSearchTerms(
            [e.statistic_id, e.friendly_name, e.device_name],
            searchTerms,
          ),
        );
      }

      // When searching, also fetch live-only sensor entities (e.g. device_class=timestamp)
      // that match but have no statistics. Append them after the stats results.
      // Only include sensor/binary_sensor domains — skip buttons, lights, events, etc.
      const EXTRA_DOMAINS = new Set(["sensor", "binary_sensor"]);
      let liveOnlyExtras: Awaited<ReturnType<typeof searchLiveEntities>> = [];
      let extrasUnavailable: string | undefined;
      if (
        searchTerms &&
        !domain &&
        !areaFilters &&
        !device &&
        !requestedTypes
      ) {
        // The extras sweep is a bonus on top of the statistics answer: its
        // failure is reported as a note, never allowed to sink the main result.
        try {
          const statsIds = new Set(filtered.map((e) => e.statistic_id));
          const liveAll = await searchLiveEntities(undefined, searchTerms);
          liveOnlyExtras = liveAll.filter((s) => {
            const d = s.entity_id.split(".")[0] ?? "";
            return (
              EXTRA_DOMAINS.has(d) &&
              !LIVE_ONLY_DOMAINS.has(d) &&
              !statsIds.has(s.entity_id)
            );
          });
        } catch (extrasErr) {
          extrasUnavailable = extrasErr instanceof Error ? extrasErr.message : String(extrasErr);
        }
      }

      if (filtered.length > 0 || liveOnlyExtras.length > 0) {
        const stateMap = includeState ? await fetchStateMap() : undefined;
        return buildStatisticsResponse(filtered, {
          domain: domainLabel,
          search: searchRaw,
          areas: areaFilters,
          device,
          deviceClasses: requestedTypes,
          stateMap,
          liveOnlyExtras,
          cap,
          ambientExcluded,
          extrasUnavailable,
        });
      }

      // Zero stats results + explicit search → try full live-state fallback
      if (searchTerms) {
        const liveResult = await searchLiveEntities(undefined, searchTerms);
        if (liveResult.length > 0) {
          return buildLiveResponse(
            liveResult,
            undefined,
            searchRaw,
            cap,
            `No statistics entities matched "${searchRaw}" — showing live-state entities instead:`,
          );
        }
      }

      const hint = searchRaw ? ` matching "${searchRaw}"` : "";
      const domainHint = domainLabel ? ` in domain "${domainLabel}"` : "";
      const areaHint = areaFilters
        ? ` in areas "${areaFilters.join(", ")}"`
        : "";
      const deviceHint = device ? ` on device "${device}"` : "";
      const typeHint = requestedTypes
        ? ` for device_class "${requestedTypes.join(", ")}"`
        : "";
      // Closed-world refusal: the inventory + stop rule turn this single empty
      // result into terminal evidence instead of an invitation to retry.
      const areaNames = [...new Set(entities.map((e) => e.area_name).filter(Boolean))] as string[];
      return (
        `No entities found${hint}${domainHint}${areaHint}${deviceHint}${typeHint} in ${config.haName}.\n` +
        `${statsInventory(entities, requestedTypes)}\n` +
        `Areas: ${areaNames.join(", ")}. Note: rooms are often named after people or nicknames, not room types.\n` +
        `Motion/door/presence sensors live in domains=["binary_sensor"]; location in domains=["device_tracker"].\n` +
        STOP_RULE
      );
    }

    // Live-only domain path (binary_sensor, device_tracker, zone, …).
    // Fetch the whole domain first so a search miss can present the complete
    // domain inventory as closed-world evidence.
    const allInDomain = await searchLiveEntities(requestedDomains);
    const matches =
      searchTerms && searchTerms.length > 0
        ? allInDomain.filter((s) => {
            const fields = [s.entity_id, s.attributes.friendly_name, s.attributes.device_class]
              .join(" ")
              .toLowerCase();
            return searchTerms.every((t) => fields.includes(t));
          })
        : allInDomain;
    if (matches.length === 0) {
      const hint = searchRaw ? ` matching "${searchRaw}"` : "";
      if (allInDomain.length === 0) {
        return (
          `This instance has no ${domainLabel ?? "matching"} entities at all.\n` + STOP_RULE
        );
      }
      const shown = allInDomain.slice(0, 25);
      const more = allInDomain.length > 25 ? `\n  … and ${allInDomain.length - 25} more` : "";
      return (
        `No ${domainLabel ?? "matching"} entities found${hint} in ${config.haName}.\n` +
        `Complete inventory — ALL ${allInDomain.length} ${domainLabel} entities on this instance:\n` +
        shown.map((s) => `  ${s.entity_id} (${s.attributes.friendly_name ?? "—"})`).join("\n") +
        more + `\n` + STOP_RULE
      );
    }
    return buildLiveResponse(matches, domainLabel, searchRaw, cap);
  } catch (err) {
    return errFromCaught(err, "ha_history_list_entities").text;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HAStateEntry {
  entity_id: string;
  state: string;
  attributes: {
    friendly_name?: string;
    device_class?: string;
    unit_of_measurement?: string;
    source_type?: string;
    [key: string]: unknown;
  };
}

async function fetchStateMap(): Promise<Map<string, string>> {
    const startMs = Date.now();
    logInfo("HA", "rest request", {
      method: "GET",
      path: "/api/states",
      tool: "ha_history_list_entities",
    });
    const res = await fetch(`${config.haUrl}/api/states`, {
      headers: { Authorization: `Bearer ${config.haToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    logInfo("HA", "rest response", {
      method: "GET",
      path: "/api/states",
      tool: "ha_history_list_entities",
      status: res.status,
      duration_ms: Date.now() - startMs,
    });
    // Failures propagate to the handler's errFromCaught: a broken state fetch
    // must not degrade into "state=—" rows that look like missing entity data.
    if (!res.ok) throw new Error(`HA /api/states returned HTTP ${res.status} (needed for include_state)`);
    const all = (await res.json()) as HAStateEntry[];
    return new Map(
      all.map((s) => [
        s.entity_id,
        s.attributes.unit_of_measurement
          ? `${s.state} ${s.attributes.unit_of_measurement}`
          : s.state,
      ]),
    );
}

async function searchLiveEntities(
  domains?: string | string[],
  search?: string[],
): Promise<HAStateEntry[]> {
    const normalizedDomains = typeof domains === "string" ? [domains] : domains;
    const startMs = Date.now();
    logInfo("HA", "rest request", {
      method: "GET",
      path: "/api/states",
      tool: "ha_history_list_entities",
      domain: normalizedDomains,
      search,
    });
    const res = await fetch(`${config.haUrl}/api/states`, {
      headers: { Authorization: `Bearer ${config.haToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    logInfo("HA", "rest response", {
      method: "GET",
      path: "/api/states",
      tool: "ha_history_list_entities",
      status: res.status,
      duration_ms: Date.now() - startMs,
    });
    // Failures propagate to the handler's errFromCaught: an HA outage must
    // not render as "No entities found".
    if (!res.ok) throw new Error(`HA /api/states returned HTTP ${res.status}`);
    const all = (await res.json()) as HAStateEntry[];
    let matches =
      normalizedDomains && normalizedDomains.length > 0
        ? all.filter((s) =>
            normalizedDomains.some((domain) =>
              s.entity_id.startsWith(`${domain}.`),
            ),
          )
        : all;
    if (search && search.length > 0) {
      // AND semantics, matching the statistics path and the schema text.
      matches = matches.filter((s) => {
        const fields = [
          s.entity_id,
          s.attributes.friendly_name,
          s.attributes.device_class,
        ]
          .join(" ")
          .toLowerCase();
        return search.every((t) => fields.includes(t));
      });
    }
    return matches.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
}

/** Per-area match counts — the cheap breakdown that makes a capped result navigable. */
function areaBreakdown(
  entities: Array<{ area_name: string | null }>,
): string {
  const counts = new Map<string, number>();
  for (const e of entities) {
    const key = e.area_name ?? "(no area)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 10).map(([name, n]) => `${name} ${n}`);
  const more = sorted.length > 10 ? `, +${sorted.length - 10} more areas` : "";
  return `By area: ${shown.join(", ")}${more}`;
}

function buildStatisticsResponse(
  filtered: NonNullable<ReturnType<typeof getCachedEntityList>>,
  options: {
    domain?: string;
    search?: string;
    areas?: string[];
    device?: string;
    deviceClasses?: string[];
    stateMap?: Map<string, string>;
    liveOnlyExtras?: HAStateEntry[];
    cap?: number;
    ambientExcluded?: number;
    extrasUnavailable?: string;
  },
): string {
  const {
    domain,
    search,
    areas,
    device,
    deviceClasses,
    stateMap,
    liveOnlyExtras,
    cap = 100,
    ambientExcluded = 0,
    extrasUnavailable,
  } = options;
  const totalStats = filtered.length;
  const totalExtras = liveOnlyExtras?.length ?? 0;
  const totalCount = totalStats + totalExtras;

  const lines = [
    `${totalCount} entities found in ${config.haName}` +
      (domain ? ` (domains=${domain})` : "") +
      (search ? ` (search=${search})` : "") +
      (areas ? ` (areas=${areas.join(",")})` : "") +
      (device ? ` (device=${device})` : "") +
      (deviceClasses ? ` (device_classes=${deviceClasses.join(",")})` : "") +
      ":\n",
  ];

  const limited = totalStats > cap ? filtered.slice(0, cap) : filtered;
  const grouped = new Map<string, Map<string, typeof limited>>();
  for (const entity of limited) {
    const areaKey = entity.area_name ?? "—";
    const deviceKey = entity.device_name ?? "—";
    if (!grouped.has(areaKey)) grouped.set(areaKey, new Map());
    const devices = grouped.get(areaKey)!;
    const deviceEntities = devices.get(deviceKey) ?? [];
    deviceEntities.push(entity);
    devices.set(deviceKey, deviceEntities);
  }

  for (const [areaName, devices] of grouped.entries()) {
    lines.push(`Area: ${areaName}`);
    for (const [deviceName, entitiesForDevice] of devices.entries()) {
      lines.push(`  Device: ${deviceName}`);
      for (const e of entitiesForDevice) {
        const type = e.has_sum
          ? "cumulative"
          : e.has_mean
            ? "measurement"
            : "no-stats";
        const metricLabel = inferMetric(e);
        const stateLabel = stateMap
          ? ` | state=${stateMap.get(e.statistic_id) ?? "—"}`
          : "";
        // inferred_type only when it adds information beyond device_class
        const classLabel = e.device_class ?? metricLabel;
        const inferredLabel =
          e.device_class && e.device_class !== metricLabel && metricLabel !== "other"
            ? ` | inferred_type=${metricLabel}`
            : "";
        lines.push(
          `    - ${e.statistic_id} | ${e.friendly_name} | device_class=${classLabel}${inferredLabel} | unit=${e.unit ?? "—"} | type=${type}${stateLabel}`,
        );
      }
    }
  }

  if (ambientExcluded > 0) {
    lines.push(
      `\nNote: ${ambientExcluded} device-internal temperature/humidity entities excluded ` +
        `(battery/target/setpoint/…). Pass device= or search= to include them.`,
    );
  }

  if (totalStats > cap) {
    lines.push(
      `\nShowing ${cap} of ${totalStats} statistics entities. ${areaBreakdown(filtered)}.\n` +
        `Narrow with areas=, device_classes=, or search=, or pass max_results="all".`,
    );
  }

  // Append live-only extras (e.g. timestamp sensors) after the stats table
  if (liveOnlyExtras && liveOnlyExtras.length > 0) {
    lines.push(
      `\nAdditional live-state only entities (no long-term statistics):`,
    );
    const rows = liveOnlyExtras.slice(0, 50).map((s) => {
      const name = s.attributes.friendly_name ?? "—";
      const dc = (s.attributes.device_class as string | undefined) ?? "—";
      return `${s.entity_id} | ${name} | ${s.state} | ${dc}`;
    });
    lines.push(fenceTable(["entity_id | friendly_name | state | class", ...rows]));
    if (liveOnlyExtras.length > 50) {
      lines.push(`… and ${liveOnlyExtras.length - 50} more.`);
    }
    lines.push(
      `\nNote: live-state-only entities (e.g. device_class=timestamp) have no historical statistics.\n` +
        `Use ha_history_get_state to read their current value.`,
    );
  }

  if (extrasUnavailable) {
    lines.push(
      `\nNote: could not check for additional live-state-only entities (${extrasUnavailable}) — the list above covers statistics entities only.`,
    );
  }

  lines.push(entityNextStepLine(limited[0]?.statistic_id));
  return lines.join("\n");
}

/**
 * One copy-pastable next step, using an id from this payload. Discovery →
 * analytics is the natural sequence; the analytics tools themselves are
 * terminal answers and carry no hint.
 */
function entityNextStepLine(exampleId: string | undefined): string {
  const id = exampleId ?? "sensor.example";
  return (
    `\nNext: pass the exact entity_id to an analytics tool, e.g. ` +
    `ha_history_get_sensor_stats with entity_ids=["${id}"] (measurements), ` +
    `ha_history_get_consumption with entity_id="..." (cumulative meters), or ` +
    `ha_history_get_state_history with entity_id="..." (binary/discrete states).`
  );
}

function buildLiveResponse(
  matches: HAStateEntry[],
  domain: string | undefined,
  search: string | undefined,
  cap = 100,
  header?: string,
): string {
  const domainLabel = domain ?? "live-state";
  const title =
    header ??
    `${matches.length} ${domainLabel} entities found in ${config.haName}` +
      (search ? ` (search=${search})` : "") +
      ":";

  const lines = [title + "\n"];
  const shown = matches.slice(0, cap === Infinity ? undefined : cap);

  if (
    domain === "device_tracker" ||
    domain === "person" ||
    domain === "person,device_tracker" ||
    domain === "device_tracker,person"
  ) {
    const extraCol =
      domain === "device_tracker"
        ? "source_type"
        : domain === "person"
          ? "domain"
          : "kind";
    const rows = shown.map((s) => {
      const src =
        domain === "device_tracker"
          ? ((s.attributes.source_type as string | undefined) ?? "—")
          : domain === "person"
            ? "person"
            : (s.entity_id.split(".")[0] ?? "—");
      return `${s.entity_id} | ${s.attributes.friendly_name ?? "—"} | ${s.state} | ${src}`;
    });
    lines.push(fenceTable([`entity_id | friendly_name | state | ${extraCol}`, ...rows]));
    lines.push(
      `\nNote: person and device_tracker entities show location zones (e.g. "home", "not_home", zone name).\n` +
        `Use ha_history_get_state_history for zone/session history and ha_history_get_state for current coordinates or attributes.\n` +
        `History comes from recorder state history, so retention is typically about 10 days.`,
    );
  } else if (domain === "zone") {
    const rows = shown.map(
      (s) =>
        `${s.entity_id} | ${s.attributes.friendly_name ?? "—"} | ${s.state} | ${String(s.attributes.passive ?? false)}`,
    );
    lines.push(fenceTable(["entity_id | friendly_name | state | passive", ...rows]));
  } else {
    // binary_sensor and others
    const rows = shown.map(
      (s) =>
        `${s.entity_id} | ${s.attributes.friendly_name ?? "—"} | ${s.state} | ${(s.attributes.device_class as string | undefined) ?? "—"}`,
    );
    lines.push(fenceTable(["entity_id | friendly_name | state | device_class", ...rows]));
    if (
      domain === "binary_sensor" ||
      (!domain &&
        matches.every((m) => m.entity_id.startsWith("binary_sensor.")))
    ) {
      lines.push(
        `\nNote: binary sensors have no long-term statistics — use ha_history_detect_sessions\n` +
          `(not ha_history_get_sensor_stats) to query their activity history.`,
      );
    }
  }

  if (matches.length > shown.length) {
    lines.push(
      `\nShowing ${shown.length} of ${matches.length}. Narrow your search term, or pass max_results="all".`,
    );
  }

  lines.push(entityNextStepLine(shown[0]?.entity_id));
  return lines.join("\n");
}
