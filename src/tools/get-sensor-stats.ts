import { config } from "../config.js";
import { fetchStatistics, StatisticRow, EnrichedEntity } from "../ha-client.js";
import { getCachedStats, setCachedStats } from "../cache.js";
import { resolvePeriod } from "../period-resolver.js";
import { validateEntities } from "../entity-validator.js";
import { isError, errFromCaught } from "../errors.js";
import { mean, min, max, median } from "simple-statistics";
import {
  FilterOperator, matchesFilter,
  parseMaxResults, getTz,
  round, capitalize, toLocalTimestamp,
  statsEndTime, fenceTable,
  START_TIME_DESC, END_TIME_DESC,
} from "../tool-utils.js";

// Day-of-week ordering: Mon-first display (ISO week), mapped to JS getDay() values
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const JS_TO_ISO_DAY = [1, 2, 3, 4, 5, 6, 0] as const; // Mon→Sun in JS getDay()

export const GET_SENSOR_STATS_TOOL = {
  name: "ha_history_get_sensor_stats",
  description:
    `Computes statistics for one or more instantaneous-value sensors such as temperature, humidity, CO₂, pressure, illuminance, or power in W.\n` +
    `Always pass entity_ids as an array. Prefer one multi-entity call over repeated single-entity calls when units match.\n` +
    `Use aggregations for several whole-period stats in one call. Use interval for time series and group_by for repeating patterns.\n` +
    `Do not use for cumulative consumption in kWh; use ha_history_get_consumption. Do not use for event counting; use ha_history_detect_sessions.`,
  inputSchema: {
    type: "object",
    properties: {
      entity_ids: {
        type: "array",
        items: { type: "string" },
        description:
          `Array of exact entity_ids. Use one item for a single sensor or multiple items for homogeneous comparisons.\n` +
          `Resolve IDs first with ha_history_list_entities or ha_history_list_device_entities.`,
      },
      start_time: {
        type: "string",
        description: START_TIME_DESC,
      },
      end_time: {
        type: "string",
        description: END_TIME_DESC,
      },
      aggregations: {
        type: "array",
        items: {
          type: "string",
          enum: ["mean", "min", "max", "median", "count"],
        },
        default: ["mean"],
        description:
          `Statistics to compute, e.g. ["mean"] or ["mean","min","max"]. Default: ["mean"].\n` +
          `median: whole-period only (interval="none", no group_by). count: alone, with group_by + filter —\n` +
          `counts readings per slot that satisfy the filter (e.g. "how many days per hour exceeded 21°C?").`,
      },
      interval: {
        type: "string",
        enum: ["none", "hour", "day", "week", "month"],
        description:
          `"none" for one whole-period summary table; "hour"/"day"/"week"/"month" for time series.\n` +
          `Cannot be used with group_by.`,
      },
      group_by: {
        type: "string",
        enum: ["hour_of_day", "day_of_week"],
        description:
          `Groups by repeating time unit across the full period: "hour_of_day" or "day_of_week".\n` +
          `Cannot be used with interval.`,
      },
      filter_operator: {
        type: "string",
        enum: ["<", "<=", ">", ">=", "="],
        description:
          `Keep only buckets where the aggregated value satisfies the threshold.\n` +
          `Requires interval (not "none") or group_by.`,
      },
      filter_value: {
        type: "number",
        description: `Threshold for filter_operator. Required when filter_operator is set.`,
      },
      max_results: {
        type: ["number", "string"],
        default: config.maxResults,
        description:
          `Applies to interval time series only. Caps rows, not columns. Default: ${config.maxResults}. Pass "all" for the full series.`,
      },
    },
    required: ["entity_ids"],
    additionalProperties: false,
  },
};

type Aggregation = "mean" | "min" | "max" | "median" | "count";
type ScalarAggregation = Exclude<Aggregation, "count">;
type Interval = "none" | "hour" | "day" | "week" | "month";
type GroupBy = "hour_of_day" | "day_of_week";

interface EntityInfo {
  entityId: string;
  entity: EnrichedEntity;
  label: string;
}

export async function handleGetSensorStats(
  args: Record<string, unknown>
): Promise<string> {
  try {
    // --- Parse entity_ids ---
    const rawIds = args["entity_ids"];
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return `ERROR: Missing required parameter "entity_ids". Provide an array of exact entity_ids, e.g. ["sensor.bedroom_temperature"].`;
    }
    const parsedIds = rawIds
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter((id) => id.length > 0);
    if (parsedIds.length === 0) {
      return `ERROR: "entity_ids" must contain at least one non-empty entity ID.`;
    }

    // Deduplicate while preserving first-seen order
    const seen = new Set<string>();
    const entityIds: string[] = [];
    for (const id of parsedIds) {
      if (!seen.has(id)) {
        seen.add(id);
        entityIds.push(id);
      }
    }

    // --- Validate aggregations ---
    // Migration teaching error: the singular parameter was removed in the
    // aggregation/aggregations merge (2026-08). Reachable on direct handler
    // calls; MCP dispatch already rejects it as an unknown parameter.
    if (args["aggregation"] !== undefined) {
      return (
        `ERROR: Parameter "aggregation" was removed — use aggregations (an array). ` +
        `Example: aggregations=["${String(args["aggregation"])}"].`
      );
    }

    const validAggregations: Aggregation[] = ["mean", "min", "max", "median", "count"];
    const rawAggregations = args["aggregations"];
    let aggregations: Aggregation[];
    if (rawAggregations === undefined) {
      aggregations = ["mean"];
    } else {
      if (!Array.isArray(rawAggregations) || rawAggregations.length === 0) {
        return `ERROR: "aggregations" must be a non-empty array, e.g. aggregations=["mean"].`;
      }
      const seenAggregations = new Set<Aggregation>();
      aggregations = [];
      for (const value of rawAggregations) {
        if (typeof value !== "string" || !validAggregations.includes(value as Aggregation)) {
          return `ERROR: Invalid aggregation ${JSON.stringify(value)} in "aggregations". Valid values: ${validAggregations.join(", ")}.`;
        }
        const normalized = value as Aggregation;
        if (!seenAggregations.has(normalized)) {
          seenAggregations.add(normalized);
          aggregations.push(normalized);
        }
      }
    }
    const isCount = aggregations.includes("count");
    if (isCount && aggregations.length > 1) {
      return `ERROR: "count" cannot be combined with other aggregations. Use aggregations=["count"] alone.`;
    }

    const interval = (args["interval"] as Interval | undefined) ?? "none";
    const validIntervals: Interval[] = ["none", "hour", "day", "week", "month"];
    if (!validIntervals.includes(interval)) {
      return `ERROR: Invalid interval "${interval}". Valid values: ${validIntervals.join(", ")}.`;
    }

    const groupBy = args["group_by"] as GroupBy | undefined;
    const validGroupBys: GroupBy[] = ["hour_of_day", "day_of_week"];
    if (groupBy && !validGroupBys.includes(groupBy)) {
      return `ERROR: Invalid group_by "${groupBy}". Valid values: ${validGroupBys.join(", ")}.`;
    }
    if (groupBy && interval !== "none") {
      return (
        `ERROR: group_by and interval cannot be used together. ` +
        `Use group_by for pattern analysis (time-of-day, day-of-week) ` +
        `or interval for a chronological time series — not both.`
      );
    }

    // median is a whole-period statistic: per-bucket median over hourly means
    // is not a real median, so it is rejected rather than silently substituted.
    if (aggregations.includes("median") && (groupBy || interval !== "none")) {
      return (
        `ERROR: "median" is only supported whole-period (interval="none", no group_by). ` +
        `Per-bucket median is not computable from hourly statistics — use "mean" for time series and grouped queries.`
      );
    }

    // Validate filter parameters
    const filterOp = args["filter_operator"] as FilterOperator | undefined;
    const filterVal = typeof args["filter_value"] === "number" ? args["filter_value"] : undefined;
    const validFilterOps: FilterOperator[] = ["<", "<=", ">", ">=", "="];
    if (filterOp && !validFilterOps.includes(filterOp)) {
      return `ERROR: Invalid filter_operator "${filterOp}". Valid values: ${validFilterOps.join(", ")}.`;
    }
    if (filterOp && filterVal === undefined) {
      return `ERROR: filter_value is required when filter_operator is set. Add filter_value (a number) or drop filter_operator.`;
    }
    if (filterOp && interval === "none" && !groupBy) {
      return (
        `ERROR: filter_operator requires interval (not "none") or group_by. ` +
        `With interval="none", the result is a single structured value row — use the value directly.`
      );
    }

    // Reject filter+multi-aggregation: ambiguous which aggregation the filter applies to
    if (aggregations.length > 1 && filterOp !== undefined) {
      return (
        `ERROR: filter_operator with multiple aggregations is ambiguous — ` +
        `it is unclear which aggregation the filter applies to. ` +
        `Use a single aggregation (e.g. aggregations=["mean"]) when filtering.`
      );
    }

    // count is only valid with group_by + filter
    if (isCount && !groupBy) {
      return (
        `ERROR: aggregations=["count"] requires group_by="hour_of_day" or group_by="day_of_week".\n` +
        `It counts how many readings per slot satisfied the filter condition.\n` +
        `Example: group_by="hour_of_day", aggregations=["count"], filter_operator=">", ` +
        `filter_value=21 answers "how many days at each hour exceeded 21°C?"`
      );
    }
    if (isCount && filterOp === undefined) {
      return (
        `ERROR: aggregations=["count"] requires filter_operator and filter_value to define what to count.\n` +
        `Example: filter_operator=">", filter_value=21 counts readings above 21 per slot.`
      );
    }

    // Parse max_results
    const capParsed = parseMaxResults(args["max_results"]);
    if (typeof capParsed === "string") return capParsed;
    const { returnAll, rowCap } = capParsed;

    // Validate entities (all at once, with same-unit check for multi-entity)
    const validation = validateEntities(entityIds, "mean");
    if (typeof validation === "string") return validation;
    const { entities } = validation;

    // Derive compact column labels
    const friendlyNames = entities.map((e) => e.friendly_name);
    const labels = deriveColumnLabels(friendlyNames);
    const entityInfos: EntityInfo[] = entityIds.map((id, i) => ({
      entityId: id,
      entity: entities[i]!,
      label: labels[i]!,
    }));

    // Resolve time period
    const tz = getTz();
    const now = new Date();
    const period = resolvePeriod(
      args["start_time"] as string | undefined,
      args["end_time"] as string | undefined,
      now,
      tz
    );
    if (typeof period === "string") return period;

    // Unit string (with leading space) for filter descriptions
    const unit = entities[0]!.unit ? ` ${entities[0]!.unit}` : "";

    // Cache key
    const filterKey = filterOp !== undefined ? `:filter${filterOp}${filterVal}` : "";
    const groupKey = groupBy ? `:groupby_${groupBy}` : "";
    const capKey = returnAll ? `:all` : rowCap !== config.maxResults ? `:cap${rowCap}` : "";
    const cacheKey = `stats:${entityIds.join(",")}:${aggregations.join(",")}:${interval}${groupKey}${filterKey}${capKey}:${period.start.getTime()}:${period.end.getTime()}`;
    const cached = getCachedStats(cacheKey);
    if (cached) return cached as string;

    // Determine fetch granularity
    const haPeriod = groupBy === "day_of_week" ? "day"
      : groupBy === "hour_of_day" ? "hour"
      : interval === "none" ? "hour"
      : interval;

    // Batch fetch statistics for all requested entities
    const statsResult = await fetchStatistics(
      entityIds,
      period.start,
      statsEndTime(period.end),
      haPeriod as "hour" | "day" | "week" | "month",
      ["mean", "min", "max"]
    );
    if (isError(statsResult)) return statsResult.text;

    const statsMap: Record<string, StatisticRow[]> = {};
    for (const id of entityIds) {
      statsMap[id] = statsResult[id] ?? [];
    }

    // Route to appropriate output path
    let result: string;
    if (interval === "none" && !groupBy) {
      if (entityInfos.length === 1 && aggregations.length === 1) {
        result = renderSingleScalar(entityInfos[0]!, statsMap, aggregations[0]!, period, unit, tz);
      } else {
        result = renderScalarMatrix(entityInfos, statsMap, aggregations as ScalarAggregation[], period, unit);
      }
    } else if (groupBy) {
      if (aggregations.length > 1) {
        result = renderGroupByMultiAggOutput(entityInfos, statsMap, groupBy, aggregations as ScalarAggregation[], period, unit, tz);
      } else {
        result = renderGroupByOutput(entityInfos, statsMap, groupBy, aggregations[0]!, period, unit, tz, filterOp, filterVal);
      }
    } else {
      if (aggregations.length > 1) {
        result = renderIntervalMultiAggOutput(entityInfos, statsMap, aggregations as ScalarAggregation[], interval, period, unit, tz, rowCap);
      } else {
        result = renderIntervalOutput(entityInfos, statsMap, aggregations[0]!, interval, period, unit, tz, filterOp, filterVal, rowCap);
      }
    }

    setCachedStats(cacheKey, result, period.end);
    return result;

  } catch (err) {
    return errFromCaught(err, "ha_history_get_sensor_stats").text;
  }
}

/**
 * Header line carrying both friendly names and canonical entity_ids, so the
 * model can chain a follow-up call straight from the payload.
 */
function sensorsLine(entityInfos: EntityInfo[]): string {
  return `Sensors: ${entityInfos.map((i) => `${i.entity.friendly_name} (${i.entityId})`).join(" | ")}`;
}

function unitLine(unit: string): string {
  return `Unit: ${unit.trim() || "(none)"}`;
}

/**
 * Whole-period mean/min/max computed from ALL fetched rows, independent of
 * filtering and row caps — the safe number to cite for "over the period" claims.
 */
function wholePeriodLine(
  entityInfos: EntityInfo[],
  statsMap: Record<string, StatisticRow[]>,
): string {
  const parts = entityInfos.map((info) => {
    const rows = statsMap[info.entityId] ?? [];
    const m = computeScalar(rows, "mean");
    const lo = computeScalar(rows, "min");
    const hi = computeScalar(rows, "max");
    if (m === null && lo === null && hi === null) return `${info.label}: no data`;
    const fmt = (v: number | null) => (v === null ? "-" : round(v));
    return `${info.label}: mean ${fmt(m)}, min ${fmt(lo)}, max ${fmt(hi)}`;
  });
  return `Whole period: ${parts.join(" | ")}`;
}

function renderScalarMatrix(
  entityInfos: EntityInfo[],
  statsMap: Record<string, StatisticRow[]>,
  aggregations: ScalarAggregation[],
  period: { label: string },
  unit: string,
): string {
  const noDataNames: string[] = [];
  const tableRows = entityInfos.map((info) => {
    const rows = statsMap[info.entityId] ?? [];
    if (rows.length === 0) noDataNames.push(info.entity.friendly_name);
    return [
      info.entity.friendly_name,
      ...aggregations.map((agg) => {
        const value = computeScalar(rows, agg);
        return value === null ? "-" : round(value);
      }),
    ];
  });

  const headerLines = [
    sensorsLine(entityInfos),
    `Period: ${period.label}`,
    `Aggregations: ${aggregations.join(" | ")}`,
    unitLine(unit),
    `Rows: ${tableRows.length}`,
  ];

  const parts = [
    headerLines.join("\n"),
    "",
    renderTable(["sensor", ...aggregations], tableRows),
  ];

  if (noDataNames.length > 0) {
    parts.push("", `Note: no data in this period for: ${noDataNames.join(", ")}`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Scalar output — single entity, interval="none"
// ---------------------------------------------------------------------------

function renderSingleScalar(
  info: EntityInfo,
  statsMap: Record<string, StatisticRow[]>,
  aggregation: Aggregation,
  period: { label: string },
  unit: string,
  tz: string,
): string {
  const rows = statsMap[info.entityId] ?? [];
  const header =
    `Sensors: ${info.entity.friendly_name} (${info.entityId})\n` +
    `Period: ${period.label}\n` +
    `Aggregation: ${aggregation}\n` +
    unitLine(unit);

  // Absent detail is said in words, never shipped as an empty-looking table.
  const noDataNote =
    `No statistics found for ${info.entityId} in this period. ` +
    `Widen the period, or check when this sensor started recording.`;

  if (rows.length === 0) {
    return `${header}\n\n${noDataNote}`;
  }

  if (aggregation === "min" || aggregation === "max") {
    const extreme = findExtremeBucket(rows, aggregation, tz);
    if (extreme === null) {
      return `${header}\n\n${noDataNote}`;
    }
    return `${header}\n\n${renderTable(["value", "time_bucket"], [[round(extreme.value), extreme.bucket]])}`;
  }

  // mean / median
  const value = computeScalar(rows, aggregation);
  if (value === null) {
    return `${header}\n\n${noDataNote}`;
  }
  return `${header}\n\n${renderTable(["value"], [[round(value)]])}`;
}

// ---------------------------------------------------------------------------
// Interval output — single or multi-entity, interval != "none"
// ---------------------------------------------------------------------------

function renderIntervalOutput(
  entityInfos: EntityInfo[],
  statsMap: Record<string, StatisticRow[]>,
  aggregation: Aggregation,
  interval: Interval,
  period: { label: string },
  unit: string,
  tz: string,
  filterOp: FilterOperator | undefined,
  filterVal: number | undefined,
  rowCap: number,
): string {
  const dateOnly = interval === "day" || interval === "week" || interval === "month";

  // Collect buckets with stable sort order (chronological by raw start time)
  type Bucket = { rawTs: number; display: string; cells: Map<string, number | null> };
  const bucketMap = new Map<string, Bucket>();
  const noDataEntityIds: string[] = [];

  for (const info of entityInfos) {
    const rows = statsMap[info.entityId] ?? [];
    if (rows.length === 0) {
      noDataEntityIds.push(info.entityId);
      continue;
    }
    for (const row of rows) {
      const display = toLocalTimestamp(row.start, tz, dateOnly);
      if (!bucketMap.has(display)) {
        bucketMap.set(display, { rawTs: row.start, display, cells: new Map() });
      }
      const val = computeRowValue(row, aggregation);
      bucketMap.get(display)!.cells.set(info.entityId, val);
    }
  }

  const allBuckets = Array.from(bucketMap.values()).sort((a, b) => a.rawTs - b.rawTs);

  // Build matrix rows
  type MatRow = { display: string; rawVals: Record<string, number | null>; vals: Record<string, string> };
  let matRows: MatRow[] = allBuckets.map((b) => {
    const rawVals: Record<string, number | null> = {};
    const vals: Record<string, string> = {};
    for (const info of entityInfos) {
      const v = b.cells.get(info.entityId);
      rawVals[info.entityId] = v !== undefined ? v : null;
      vals[info.entityId] = v !== undefined && v !== null ? round(v) : "-";
    }
    return { display: b.display, rawVals, vals };
  });

  // Apply filter — include row if any entity value satisfies the filter
  let filterDesc: string | undefined;
  const totalBeforeFilter = matRows.length;
  if (filterOp !== undefined && filterVal !== undefined) {
    filterDesc = `${capitalize(aggregation)} ${filterOp} ${filterVal}${unit}`;
    matRows = matRows.filter((row) =>
      entityInfos.some((info) => {
        const v = row.rawVals[info.entityId];
        if (v === undefined || v === null) return false;
        return matchesFilter(v, filterOp, filterVal);
      })
    );
  }

  // Apply row cap
  const totalDisplay = matRows.length;
  let capNotice = "";
  if (totalDisplay > rowCap) {
    matRows = matRows.slice(0, rowCap);
    capNotice =
      `Showing ${rowCap} of ${totalDisplay} ${interval} buckets (oldest first); ` +
      `the whole-period line above covers the full period. ` +
      `Pass max_results="all" for the complete series.`;
  }

  // Build header. Rows: is the pre-cap count, so it never contradicts the cap
  // notice, and the whole-period aggregate is always present — averaging the
  // visible rows of a truncated series would silently produce a wrong number.
  const headerLines: string[] = [
    sensorsLine(entityInfos),
    `Period: ${period.label}`,
    `Aggregation: ${aggregation} per ${interval}`,
    unitLine(unit),
    `Rows: ${totalDisplay}`,
    wholePeriodLine(entityInfos, statsMap),
  ];
  if (filterDesc) {
    const excluded = totalBeforeFilter - totalDisplay;
    headerLines.push(
      `Filter: ${filterDesc} — ${totalDisplay} of ${totalBeforeFilter} buckets matched (${excluded} excluded)`
    );
  }
  const header = headerLines.join("\n");

  // Build table body
  const colHeaders = ["time", ...entityInfos.map((i) => i.label)];
  const tableRows = matRows.map((r) => [r.display, ...entityInfos.map((i) => r.vals[i.entityId] ?? "-")]);

  let body: string;
  if (tableRows.length === 0) {
    body = "(no buckets matched the filter — try a different threshold or wider period)";
  } else {
    body = renderTable(colHeaders, tableRows);
  }

  const footerNotes: string[] = [];
  if (noDataEntityIds.length > 0) {
    const names = noDataEntityIds.map(
      (id) => entityInfos.find((i) => i.entityId === id)?.entity.friendly_name ?? id
    );
    footerNotes.push(`Note: no data in this period for: ${names.join(", ")}`);
  }
  if (capNotice) footerNotes.push(capNotice);

  const parts = [header, "", body];
  if (footerNotes.length > 0) parts.push("", footerNotes.join("\n"));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Interval multi-aggregation output — one or more entities, several aggregations
// ---------------------------------------------------------------------------

function renderIntervalMultiAggOutput(
  entityInfos: EntityInfo[],
  statsMap: Record<string, StatisticRow[]>,
  aggregations: ScalarAggregation[],
  interval: Interval,
  period: { label: string },
  unit: string,
  tz: string,
  rowCap: number,
): string {
  const dateOnly = interval === "day" || interval === "week" || interval === "month";

  // Collect all time buckets across entities
  type Bucket = {
    rawTs: number;
    display: string;
    cells: Map<string, Map<ScalarAggregation, number | null>>;
  };
  const bucketMap = new Map<string, Bucket>();
  const noDataEntityIds: string[] = [];

  for (const info of entityInfos) {
    const rows = statsMap[info.entityId] ?? [];
    if (rows.length === 0) {
      noDataEntityIds.push(info.entityId);
      continue;
    }
    for (const dataRow of rows) {
      const display = toLocalTimestamp(dataRow.start, tz, dateOnly);
      if (!bucketMap.has(display)) {
        bucketMap.set(display, { rawTs: dataRow.start, display, cells: new Map() });
      }
      const bucket = bucketMap.get(display)!;
      if (!bucket.cells.has(info.entityId)) {
        bucket.cells.set(info.entityId, new Map());
      }
      const aggMap = bucket.cells.get(info.entityId)!;
      for (const agg of aggregations) {
        aggMap.set(agg, computeRowValue(dataRow, agg));
      }
    }
  }

  const allBuckets = Array.from(bucketMap.values()).sort((a, b) => a.rawTs - b.rawTs);

  // Build matrix rows
  let matRows = allBuckets.map((b) => {
    const cells = new Map<string, Map<ScalarAggregation, string>>();
    for (const info of entityInfos) {
      const aggMap = b.cells.get(info.entityId);
      const displayMap = new Map<ScalarAggregation, string>();
      for (const agg of aggregations) {
        const v = aggMap?.get(agg);
        displayMap.set(agg, v !== undefined && v !== null ? round(v) : "-");
      }
      cells.set(info.entityId, displayMap);
    }
    return { display: b.display, cells };
  });

  // Apply row cap
  const totalDisplay = matRows.length;
  let capNotice = "";
  if (totalDisplay > rowCap) {
    matRows = matRows.slice(0, rowCap);
    capNotice =
      `Showing ${rowCap} of ${totalDisplay} ${interval} buckets (oldest first); ` +
      `the whole-period line above covers the full period. ` +
      `Pass max_results="all" for the complete series.`;
  }

  // Build header (Rows: pre-cap count; whole-period aggregate always present)
  const headerLines: string[] = [
    sensorsLine(entityInfos),
    `Period: ${period.label}`,
    `Aggregations: ${aggregations.join(" | ")} per ${interval}`,
    unitLine(unit),
    `Rows: ${totalDisplay}`,
    wholePeriodLine(entityInfos, statsMap),
  ];
  const header = headerLines.join("\n");

  // Column headers: time | entity1 agg1 | entity1 agg2 | ... | entity2 agg1 | ...
  // (order: entity order from request, then aggregation order from request)
  const colHeaders = ["time"];
  for (const info of entityInfos) {
    for (const agg of aggregations) {
      colHeaders.push(`${info.label} ${agg}`);
    }
  }

  const tableRows = matRows.map((r) => {
    const cells = [r.display];
    for (const info of entityInfos) {
      for (const agg of aggregations) {
        cells.push(r.cells.get(info.entityId)?.get(agg) ?? "-");
      }
    }
    return cells;
  });

  let body: string;
  if (tableRows.length === 0) {
    body = "(no data in this period — widen the period, or check when these sensors started recording)";
  } else {
    body = renderTable(colHeaders, tableRows);
  }

  const footerNotes: string[] = [];
  if (noDataEntityIds.length > 0) {
    const names = noDataEntityIds.map(
      (id) => entityInfos.find((i) => i.entityId === id)?.entity.friendly_name ?? id
    );
    footerNotes.push(`Note: no data in this period for: ${names.join(", ")}`);
  }
  if (capNotice) footerNotes.push(capNotice);

  const parts = [header, "", body];
  if (footerNotes.length > 0) parts.push("", footerNotes.join("\n"));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Group-by multi-aggregation output — one or more entities, several aggregations
// ---------------------------------------------------------------------------

function renderGroupByMultiAggOutput(
  entityInfos: EntityInfo[],
  statsMap: Record<string, StatisticRow[]>,
  groupBy: GroupBy,
  aggregations: ScalarAggregation[],
  period: { label: string },
  unit: string,
  tz: string,
): string {
  const groupLabel = groupBy === "hour_of_day" ? "hour of day" : "day of week";

  // Build slot data: entityId → slotKey → agg → collected values
  const slotData = new Map<string, Map<number, Map<ScalarAggregation, number[]>>>();
  const noDataEntityIds: string[] = [];

  for (const info of entityInfos) {
    const rows = statsMap[info.entityId] ?? [];
    if (rows.length === 0) {
      noDataEntityIds.push(info.entityId);
      continue;
    }
    const entitySlots = new Map<number, Map<ScalarAggregation, number[]>>();
    for (const dataRow of rows) {
      const local = new Date(new Date(dataRow.start).toLocaleString("en-US", { timeZone: tz }));
      const slotKey = groupBy === "hour_of_day" ? local.getHours() : local.getDay();
      if (!entitySlots.has(slotKey)) {
        entitySlots.set(slotKey, new Map());
      }
      const aggSlot = entitySlots.get(slotKey)!;
      for (const agg of aggregations) {
        const val = computeRowValue(dataRow, agg);
        if (val !== null) {
          const existing = aggSlot.get(agg) ?? [];
          existing.push(val);
          aggSlot.set(agg, existing);
        }
      }
    }
    slotData.set(info.entityId, entitySlots);
  }

  // Build display slots — only slots with any data, in canonical order
  interface SlotRow { label: string; cells: Map<string, Map<ScalarAggregation, string>> }
  const slots: SlotRow[] = [];

  if (groupBy === "hour_of_day") {
    for (let h = 0; h < 24; h++) {
      const cells = new Map<string, Map<ScalarAggregation, string>>();
      let hasAnyData = false;
      for (const info of entityInfos) {
        const aggSlot = slotData.get(info.entityId)?.get(h);
        const aggDisplay = new Map<ScalarAggregation, string>();
        for (const agg of aggregations) {
          const vals = aggSlot?.get(agg);
          if (vals && vals.length > 0) {
            aggDisplay.set(agg, round(aggregate(vals, agg)));
            hasAnyData = true;
          } else {
            aggDisplay.set(agg, "-");
          }
        }
        cells.set(info.entityId, aggDisplay);
      }
      if (hasAnyData) slots.push({ label: `${String(h).padStart(2, "0")}:00`, cells });
    }
  } else {
    for (let i = 0; i < 7; i++) {
      const jsDay = JS_TO_ISO_DAY[i]!;
      const cells = new Map<string, Map<ScalarAggregation, string>>();
      let hasAnyData = false;
      for (const info of entityInfos) {
        const aggSlot = slotData.get(info.entityId)?.get(jsDay);
        const aggDisplay = new Map<ScalarAggregation, string>();
        for (const agg of aggregations) {
          const vals = aggSlot?.get(agg);
          if (vals && vals.length > 0) {
            aggDisplay.set(agg, round(aggregate(vals, agg)));
            hasAnyData = true;
          } else {
            aggDisplay.set(agg, "-");
          }
        }
        cells.set(info.entityId, aggDisplay);
      }
      if (hasAnyData) slots.push({ label: DAY_NAMES[i]!, cells });
    }
  }

  if (slots.length === 0) {
    return `${sensorsLine(entityInfos)}\nPeriod: ${period.label}\nNo data available for group_by="${groupBy}".`;
  }

  // Build header
  const headerLines: string[] = [
    sensorsLine(entityInfos),
    `Period: ${period.label}`,
    `Aggregations: ${aggregations.join(" | ")} by ${groupBy}`,
    unitLine(unit),
    `Slots: ${slots.length} of ${groupBy === "hour_of_day" ? 24 : 7} with data`,
  ];
  const header = headerLines.join("\n");

  // Column headers: bucket | entity1 agg1 | entity1 agg2 | ... | entity2 agg1 | ...
  const colHeaders = ["bucket"];
  for (const info of entityInfos) {
    for (const agg of aggregations) {
      colHeaders.push(`${info.label} ${agg}`);
    }
  }

  const tableRows = slots.map((slot) => {
    const cells = [slot.label];
    for (const info of entityInfos) {
      for (const agg of aggregations) {
        cells.push(slot.cells.get(info.entityId)?.get(agg) ?? "-");
      }
    }
    return cells;
  });

  const body = renderTable(colHeaders, tableRows);

  const footerNotes: string[] = [];
  if (noDataEntityIds.length > 0) {
    const names = noDataEntityIds.map(
      (id) => entityInfos.find((i) => i.entityId === id)?.entity.friendly_name ?? id
    );
    footerNotes.push(`Note: no data in this period for: ${names.join(", ")}`);
  }

  // Low-sample warning (same threshold as single-aggregation path)
  let lowSample = false;
  outer: for (const info of entityInfos) {
    const entitySlots = slotData.get(info.entityId);
    if (entitySlots) {
      for (const aggMap of entitySlots.values()) {
        for (const vals of aggMap.values()) {
          if (vals.length < 5) { lowSample = true; break outer; }
        }
      }
    }
  }
  if (lowSample) {
    footerNotes.push(
      `Warning: some ${groupLabel} slots have < 5 readings — ` +
      `results may not be statistically reliable. Use a longer period for stable patterns.`
    );
  }

  const parts = [header, "", body];
  if (footerNotes.length > 0) parts.push("", footerNotes.join("\n"));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Group-by output — single or multi-entity
// ---------------------------------------------------------------------------

function renderGroupByOutput(
  entityInfos: EntityInfo[],
  statsMap: Record<string, StatisticRow[]>,
  groupBy: GroupBy,
  aggregation: Aggregation,
  period: { label: string },
  unit: string,
  tz: string,
  filterOp: FilterOperator | undefined,
  filterVal: number | undefined,
): string {
  const isCount = aggregation === "count";
  const groupLabel = groupBy === "hour_of_day" ? "hour of day" : "day of week";

  type CountData = { matched: number; total: number };
  const entityCountData = new Map<string, Map<number, CountData>>();
  const entityValData = new Map<string, Map<number, number[]>>();
  const noDataEntityIds: string[] = [];

  for (const info of entityInfos) {
    const rows = statsMap[info.entityId] ?? [];
    if (rows.length === 0) {
      noDataEntityIds.push(info.entityId);
      continue;
    }

    if (isCount) {
      const slotMap = new Map<number, CountData>();
      for (const row of rows) {
        const local = new Date(new Date(row.start).toLocaleString("en-US", { timeZone: tz }));
        const slotKey = groupBy === "hour_of_day" ? local.getHours() : local.getDay();
        const val = row.mean;
        if (val !== null) {
          const entry = slotMap.get(slotKey) ?? { matched: 0, total: 0 };
          entry.total++;
          if (filterOp !== undefined && filterVal !== undefined && matchesFilter(val, filterOp, filterVal)) {
            entry.matched++;
          }
          slotMap.set(slotKey, entry);
        }
      }
      entityCountData.set(info.entityId, slotMap);
    } else {
      const slotMap = new Map<number, number[]>();
      for (const row of rows) {
        const local = new Date(new Date(row.start).toLocaleString("en-US", { timeZone: tz }));
        const slotKey = groupBy === "hour_of_day" ? local.getHours() : local.getDay();
        const val = computeRowValue(row, aggregation);
        if (val !== null) {
          const existing = slotMap.get(slotKey) ?? [];
          existing.push(val);
          slotMap.set(slotKey, existing);
        }
      }
      entityValData.set(info.entityId, slotMap);
    }
  }

  // Build slot rows
  interface SlotRow { key: number; label: string; rawVals: Record<string, number | null>; vals: Record<string, string> }
  const slots: SlotRow[] = [];

  if (groupBy === "hour_of_day") {
    for (let h = 0; h < 24; h++) {
      const rawVals: Record<string, number | null> = {};
      const vals: Record<string, string> = {};
      let hasAnyData = false;
      for (const info of entityInfos) {
        if (isCount) {
          const entry = entityCountData.get(info.entityId)?.get(h);
          if (entry && entry.total > 0) {
            rawVals[info.entityId] = null;
            vals[info.entityId] = `${entry.matched}/${entry.total}`;
            hasAnyData = true;
          }
          else {
            rawVals[info.entityId] = null;
            vals[info.entityId] = "-";
          }
        } else {
          const data = entityValData.get(info.entityId)?.get(h);
          if (data && data.length > 0) {
            const aggregated = aggregate(data, aggregation);
            rawVals[info.entityId] = aggregated;
            vals[info.entityId] = round(aggregated);
            hasAnyData = true;
          }
          else {
            rawVals[info.entityId] = null;
            vals[info.entityId] = "-";
          }
        }
      }
      if (hasAnyData) slots.push({ key: h, label: `${String(h).padStart(2, "0")}:00`, rawVals, vals });
    }
  } else {
    for (let i = 0; i < 7; i++) {
      const jsDay = JS_TO_ISO_DAY[i]!;
      const rawVals: Record<string, number | null> = {};
      const vals: Record<string, string> = {};
      let hasAnyData = false;
      for (const info of entityInfos) {
        if (isCount) {
          const entry = entityCountData.get(info.entityId)?.get(jsDay);
          if (entry && entry.total > 0) {
            rawVals[info.entityId] = null;
            vals[info.entityId] = `${entry.matched}/${entry.total}`;
            hasAnyData = true;
          }
          else {
            rawVals[info.entityId] = null;
            vals[info.entityId] = "-";
          }
        } else {
          const data = entityValData.get(info.entityId)?.get(jsDay);
          if (data && data.length > 0) {
            const aggregated = aggregate(data, aggregation);
            rawVals[info.entityId] = aggregated;
            vals[info.entityId] = round(aggregated);
            hasAnyData = true;
          }
          else {
            rawVals[info.entityId] = null;
            vals[info.entityId] = "-";
          }
        }
      }
      if (hasAnyData) slots.push({ key: jsDay, label: DAY_NAMES[i]!, rawVals, vals });
    }
  }

  if (slots.length === 0) {
    return `${sensorsLine(entityInfos)}\nPeriod: ${period.label}\nNo data available for group_by="${groupBy}".`;
  }

  // Apply filter for non-count aggregations
  let displaySlots = slots;
  let filterDesc: string | undefined;
  if (!isCount && filterOp !== undefined && filterVal !== undefined) {
    filterDesc = `${capitalize(aggregation)} ${filterOp} ${filterVal}${unit}`;
    displaySlots = slots.filter((slot) =>
      entityInfos.some((info) => {
        const v = slot.rawVals[info.entityId];
        if (v === undefined || v === null) return false;
        return matchesFilter(v, filterOp, filterVal);
      })
    );
  }

  // Build header
  const aggrMode = isCount ? `count by ${groupBy}` : `${aggregation} by ${groupBy}`;
  const headerLines: string[] = [
    sensorsLine(entityInfos),
    `Period: ${period.label}`,
    `Aggregation: ${aggrMode}`,
    unitLine(unit),
    `Slots: ${slots.length} of ${groupBy === "hour_of_day" ? 24 : 7} with data`,
  ];
  if (filterDesc) {
    const excluded = slots.length - displaySlots.length;
    headerLines.push(
      `Filter: ${filterDesc} — ${displaySlots.length} of ${slots.length} slots matched (${excluded} excluded)`
    );
  }
  if (isCount && filterOp !== undefined && filterVal !== undefined) {
    headerLines.push(`Counting: mean ${filterOp} ${filterVal}${unit}`);
  }
  const header = headerLines.join("\n");

  // Build table
  const colHeaders = ["bucket", ...entityInfos.map((i) => i.label)];
  const tableRows = displaySlots.map((slot) =>
    [slot.label, ...entityInfos.map((i) => slot.vals[i.entityId] ?? "-")]
  );

  let body: string;
  if (displaySlots.length === 0) {
    body = "(no slots matched — try a different threshold or wider period)";
  } else {
    body = renderTable(colHeaders, tableRows);
  }

  const footerNotes: string[] = [];
  if (noDataEntityIds.length > 0) {
    const names = noDataEntityIds.map(
      (id) => entityInfos.find((i) => i.entityId === id)?.entity.friendly_name ?? id
    );
    footerNotes.push(`Note: no data in this period for: ${names.join(", ")}`);
  }

  // Low-sample warning
  let lowSample = false;
  if (!isCount) {
    outer: for (const info of entityInfos) {
      const valMap = entityValData.get(info.entityId);
      if (valMap) { for (const vals of valMap.values()) { if (vals.length < 5) { lowSample = true; break outer; } } }
    }
  } else {
    outer: for (const info of entityInfos) {
      const countMap = entityCountData.get(info.entityId);
      if (countMap) { for (const entry of countMap.values()) { if (entry.total < 5) { lowSample = true; break outer; } } }
    }
  }
  if (lowSample) {
    footerNotes.push(
      `Warning: some ${groupLabel} slots have < 5 readings — ` +
      `results may not be statistically reliable. Use a longer period for stable patterns.`
    );
  }

  const parts = [header, "", body];
  if (footerNotes.length > 0) parts.push("", footerNotes.join("\n"));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Generic table renderer
// ---------------------------------------------------------------------------

// No column padding: alignment whitespace costs tokens on every row and buys
// nothing for the model — the " | " separator alone carries the structure.
function renderTable(colHeaders: string[], rows: string[][]): string {
  const headerRow = colHeaders.join(" | ");
  const dataRows = rows.map((row) => row.join(" | "));
  return fenceTable([headerRow, ...dataRows]);
}

// ---------------------------------------------------------------------------
// Column label derivation
// ---------------------------------------------------------------------------

function deriveColumnLabels(names: string[]): string[] {
  if (names.length === 0) return [];
  const lowerNames = names.map((n) => n.toLowerCase());
  if (names.length === 1) return [lowerNames[0]!];

  const splitWords = lowerNames.map((n) => n.split(/\s+/).filter((w) => w.length > 0));
  const minLen = Math.min(...splitWords.map((w) => w.length));

  let commonSuffixCount = 0;
  for (let depth = 1; depth <= minLen; depth++) {
    const refWord = splitWords[0]![splitWords[0]!.length - depth]!;
    if (splitWords.every((w) => w[w.length - depth] === refWord)) {
      commonSuffixCount = depth;
    } else {
      break;
    }
  }

  const trimmed = splitWords.map((words) => {
    const kept = words.slice(0, words.length - commonSuffixCount);
    return kept.length > 0 ? kept.join(" ") : words.join(" ");
  });

  return trimmed.map((label, i) => {
    const occurrences = trimmed.filter((l) => l === label).length;
    return occurrences > 1 ? `${label}_${i + 1}` : label;
  });
}

// ---------------------------------------------------------------------------
// Computation helpers
// ---------------------------------------------------------------------------

function findExtremeBucket(
  rows: StatisticRow[],
  agg: "min" | "max",
  tz: string,
): { value: number; bucket: string } | null {
  let extreme: { value: number; bucket: string } | null = null;
  for (const row of rows) {
    const val = agg === "min" ? row.min : row.max;
    if (val === null) continue;
    if (extreme === null || (agg === "min" ? val < extreme.value : val > extreme.value)) {
      extreme = { value: val, bucket: toLocalTimestamp(row.start, tz, false) };
    }
  }
  return extreme;
}

function aggregate(vals: number[], agg: Aggregation): number {
  switch (agg) {
    case "mean":   return mean(vals);
    case "min":    return min(vals);
    case "max":    return max(vals);
    case "median": return median(vals);
    case "count":  throw new Error("aggregate() called with count — handled in renderGroupByOutput");
  }
}

function computeScalar(rows: StatisticRow[], agg: Aggregation): number | null {
  switch (agg) {
    case "mean": {
      const vals = rows.map((r) => r.mean).filter((v): v is number => v !== null);
      return vals.length ? mean(vals) : null;
    }
    case "min": {
      const vals = rows.map((r) => r.min).filter((v): v is number => v !== null);
      return vals.length ? min(vals) : null;
    }
    case "max": {
      const vals = rows.map((r) => r.max).filter((v): v is number => v !== null);
      return vals.length ? max(vals) : null;
    }
    case "median": {
      const vals = rows.map((r) => r.mean).filter((v): v is number => v !== null);
      return vals.length ? median(vals) : null;
    }
    case "count": return null; // validated before reaching here — count requires group_by
  }
}

function computeRowValue(row: StatisticRow, agg: Aggregation): number | null {
  switch (agg) {
    case "mean":   return row.mean;
    case "min":    return row.min;
    case "max":    return row.max;
    // median/count never reach per-bucket paths: validation rejects median for
    // interval/group_by, and count is handled separately in renderGroupByOutput.
    case "median": return null;
    case "count":  return null;
  }
}
