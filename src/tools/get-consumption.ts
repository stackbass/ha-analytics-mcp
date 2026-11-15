import { config } from "../config.js";
import { fetchStatistics, StatisticRow } from "../ha-client.js";
import { getCachedStats, setCachedStats } from "../cache.js";
import { resolvePeriod } from "../period-resolver.js";
import { validateEntity } from "../entity-validator.js";
import { isError, errFromCaught } from "../errors.js";
import { subDays, subWeeks, subMonths } from "date-fns";
import {
  FilterOperator, matchesFilter,
  parseMaxResults, getTz,
  formatSensorLine, formatUnit, round, toLocalTimestamp,
  statsEndTime, getRefPeriod, fenceTable,
  START_TIME_DESC, END_TIME_DESC,
} from "../tool-utils.js";

type ConsumptionInterval = "none" | "day" | "week" | "month";
type SumRow = StatisticRow & { sum: number };

export const GET_CONSUMPTION_TOOL = {
  name: "ha_history_get_consumption",
  description:
    `Calculates how much energy, water, gas, or other resource was consumed or produced\n` +
    `in ${config.haName} over a time period.\n` +
    `Use for totals, interval breakdowns, and period-over-period comparisons of cumulative meters.\n` +
    `Always returns consumption (the change over the period), never raw meter readings.\n` +
    `Do NOT use for instantaneous sensors (temperature, power in Watts) → use ha_history_get_sensor_stats.`,
  inputSchema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description:
          `Exact entity_id of a cumulative meter, resolved earlier, e.g. "sensor.home_energy_total". Do not guess.`,
      },
      start_time: {
        type: "string",
        description: START_TIME_DESC,
      },
      end_time: {
        type: "string",
        description: END_TIME_DESC,
      },
      interval: {
        type: "string",
        enum: ["none", "day", "week", "month"],
        default: "none",
        description:
          `"none": total consumption for the whole period (default).\n` +
          `"day": daily breakdown. "week": weekly. "month": monthly.\n` +
          `Required when using filter_operator/filter_value.`,
      },
      filter_operator: {
        type: "string",
        enum: ["<", "<=", ">", ">=", "="],
        description:
          `Filter results to buckets where consumption satisfies [op] filter_value. Requires interval.\n` +
          `E.g. "which days used more than 10 kWh?" → interval="day", filter_operator=">", filter_value=10`,
      },
      filter_value: {
        type: "number",
        description: `Threshold for filter_operator. Required when filter_operator is set.`,
      },
      max_results: {
        type: ["number", "string"],
        default: config.maxResults,
        description:
          `Applies to interval breakdown only (not scalar). ` +
          `Default: ${config.maxResults}. Pass "all" for complete series. ` +
          `Response shows total count when capped.`,
      },
      comparison: {
        type: "string",
        enum: ["previous_period", "same_period_last_year"],
        description:
          `Only applicable with interval="none". Compares the total to a reference period.\n` +
          `"previous_period": equal-length period immediately before.\n` +
          `"same_period_last_year": same calendar dates 1 year ago.\n` +
          `Returns both totals and the absolute/percentage difference.`,
      },
    },
    required: ["entity_id"],
    additionalProperties: false,
  },
};

export async function handleGetConsumption(
  args: Record<string, unknown>
): Promise<string> {
  try {
    const entityId = typeof args["entity_id"] === "string" ? args["entity_id"].trim() : "";
    if (!entityId) {
      return (
        `ERROR: Missing required parameter "entity_id" — the call was NOT executed. ` +
        `Provide the exact entity_id of a cumulative meter.`
      );
    }

    const interval = (args["interval"] as ConsumptionInterval | undefined) ?? "none";
    const validIntervals: ConsumptionInterval[] = ["none", "day", "week", "month"];
    if (!validIntervals.includes(interval)) {
      return `ERROR: Invalid interval "${interval}". Valid values: ${validIntervals.join(", ")}.`;
    }

    const filterOp = args["filter_operator"] as FilterOperator | undefined;
    const filterVal = typeof args["filter_value"] === "number" ? args["filter_value"] : undefined;
    const validFilterOps: FilterOperator[] = ["<", "<=", ">", ">=", "="];
    if (filterOp && !validFilterOps.includes(filterOp)) {
      return `ERROR: Invalid filter_operator "${filterOp}". Valid values: ${validFilterOps.join(", ")}.`;
    }
    if (filterOp && filterVal === undefined) {
      return `ERROR: filter_value is required when filter_operator is set. Add filter_value (a number) or drop filter_operator.`;
    }
    if (filterOp && interval === "none") {
      return `ERROR: filter_operator requires interval (not "none"). Set interval="day", "week", or "month" to filter by period.`;
    }

    const capParsed = parseMaxResults(args["max_results"]);
    if (typeof capParsed === "string") return capParsed;
    const { returnAll, rowCap } = capParsed;

    const comparison = args["comparison"] as "previous_period" | "same_period_last_year" | undefined;
    const validComparisons = ["previous_period", "same_period_last_year"];
    if (comparison && !validComparisons.includes(comparison)) {
      return `ERROR: Invalid comparison "${comparison}". Valid values: ${validComparisons.join(", ")}.`;
    }
    if (comparison && interval !== "none") {
      return `ERROR: comparison is only supported with interval="none". For interval breakdowns, make two separate calls.`;
    }

    // Validate entity (must have sum/cumulative capability)
    const validation = await validateEntity(entityId, "sum");
    if (typeof validation === "string") return validation;
    const { entity } = validation;

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

    const unit = formatUnit(entity);
    const sensorLine = formatSensorLine(entity, entityId);

    // Cache key
    const filterKey = filterOp !== undefined ? `:filter${filterOp}${filterVal}` : "";
    const capKey = returnAll ? `:all` : rowCap !== config.maxResults ? `:cap${rowCap}` : "";
    const cmpKey = comparison ? `:cmp_${comparison}` : "";
    const cacheKey = `consumption:${entityId}:${interval}${filterKey}${capKey}${cmpKey}:${period.start.getTime()}:${period.end.getTime()}`;
    const cached = getCachedStats(cacheKey);
    if (cached) return cached as string;

    // Fetch granularity:
    // - interval="none" → daily (compact, first/last sum delta gives accurate total)
    // - interval breakdown → same as requested interval, plus one extra bucket before start as baseline
    const haPeriod = interval === "none" ? "day" : interval as "day" | "week" | "month";
    const fetchStart = interval !== "none" ? expandStart(period.start, haPeriod) : period.start;

    const statsResult = await fetchStatistics(
      [entityId],
      fetchStart,
      statsEndTime(period.end),
      haPeriod,
      ["sum"]
    );
    if (isError(statsResult)) return statsResult.text;

    const allRows = (statsResult[entityId] ?? [])
      .filter((r): r is SumRow => r.sum !== null)
      .sort((a, b) => a.start - b.start);

    if (allRows.length === 0) {
      return (
        `No statistics found for ${entity.friendly_name} (${entityId})\n` +
        `over ${period.label}.\n` +
        `The sensor may not have recorded data in this period, or statistics may not yet\n` +
        `be computed for very recent data.`
      );
    }

    // --- Scalar total (interval="none") ---
    if (interval === "none") {
      const total = allRows[allRows.length - 1]!.sum - allRows[0]!.sum;

      // A requested comparison that cannot be computed is reported as
      // unavailable — never silently dropped from the payload.
      let compLine = "";
      if (comparison) {
        const compLabel = comparison === "previous_period" ? "previous period" : "same period last year";
        const refDates = getRefPeriod(period.start, period.end, comparison);
        const refResult = await fetchStatistics([entityId], refDates.start, refDates.end, "day", ["sum"]);
        if (isError(refResult)) {
          compLine = `\nComparison (${compLabel}): unavailable — reference-period fetch failed (${refResult.text.split("\n")[0]})`;
        } else {
          const refRows = (refResult[entityId] ?? [])
            .filter((r): r is SumRow => r.sum !== null)
            .sort((a, b) => a.start - b.start);
          if (refRows.length >= 2) {
            const refTotal = refRows[refRows.length - 1]!.sum - refRows[0]!.sum;
            const diff = total - refTotal;
            const pct = refTotal !== 0 ? diff / refTotal * 100 : null;
            const sign = diff >= 0 ? "+" : "";
            const pctStr = pct !== null ? ` (${sign}${Math.round(pct)}%)` : "";
            compLine = `\nComparison (${compLabel}): ${round(refTotal, 2)}${unit}  Δ ${sign}${round(diff, 2)}${unit}${pctStr}`;
          } else {
            compLine = `\nComparison (${compLabel}): unavailable — reference period has ${refRows.length} readings (2+ needed)`;
          }
        }
      }

      const result =
        `${sensorLine}\nPeriod: ${period.label} (${allRows.length} daily readings)\n` +
        `Total: ${round(total, 2)}${unit}${compLine}`;
      setCachedStats(cacheKey, result, period.end);
      return result;
    }

    // --- Interval breakdown ---
    // Compute consumption per bucket as delta between consecutive sum values.
    // allRows[0] may be the pre-period baseline row (start < period.start).
    const buckets: Array<{ ts: string; value: number }> = [];
    let droppedNegative = 0;
    for (let i = 1; i < allRows.length; i++) {
      const row = allRows[i]!;
      if (row.start < period.start.getTime()) continue; // skip rows still in pre-period zone
      const prev = allRows[i - 1]!;
      const delta = row.sum - prev.sum;
      if (delta >= 0) {
        buckets.push({ ts: toLocalTimestamp(row.start, tz, true), value: delta });
      } else {
        // Negative deltas are anomalous (meter reset/replacement) — dropped, but counted and confessed below.
        droppedNegative++;
      }
    }

    if (buckets.length === 0) {
      return `${sensorLine}\nPeriod: ${period.label}\nNo consumption data available for this period.`;
    }

    const totalConsumption = buckets.reduce((s, b) => s + b.value, 0);
    const avgConsumption = totalConsumption / buckets.length;

    // Apply filter
    let displayBuckets = buckets;
    let filterNote = "";
    if (filterOp !== undefined && filterVal !== undefined) {
      const matching = buckets.filter((b) => matchesFilter(b.value, filterOp, filterVal));
      const excluded = buckets.length - matching.length;
      filterNote = ` — ${matching.length}/${buckets.length} matched: Consumption ${filterOp} ${filterVal}${unit} (${excluded} excluded)`;
      displayBuckets = matching;
    }

    // Apply row cap
    const totalDisplay = displayBuckets.length;
    let capNotice = "";
    if (totalDisplay > rowCap) {
      displayBuckets = displayBuckets.slice(0, rowCap);
      capNotice =
        `\nShowing ${rowCap} of ${totalDisplay} ${interval} buckets (oldest first); Total/Avg above cover all ${buckets.length}. ` +
        `Pass max_results="all" to retrieve the complete series, or narrow the period.`;
    }

    const droppedNote = droppedNegative > 0
      ? ` (${droppedNegative} bucket${droppedNegative === 1 ? "" : "s"} with negative delta excluded — meter reset?)`
      : "";
    const summaryLine =
      `${buckets.length} ${interval} buckets${droppedNote} — Total: ${round(totalConsumption, 2)}${unit}, Avg: ${round(avgConsumption, 2)}${unit}/${interval}${filterNote}`;

    const lines = [`${sensorLine}\nPeriod: ${period.label}\n${summaryLine}\n`];
    if (totalDisplay === 0) {
      lines.push(`  (no ${interval}s matched — try a different threshold or wider period)`);
    } else {
      const rows = displayBuckets.map((b) => `${b.ts} | ${round(b.value, 2)}${unit}`);
      lines.push(fenceTable(rows));
    }
    if (capNotice) lines.push(capNotice);

    const result = lines.join("\n");
    setCachedStats(cacheKey, result, period.end);
    return result;

  } catch (err) {
    return errFromCaught(err, "ha_history_get_consumption").text;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Subtract one period from a date to obtain a pre-period baseline row. */
function expandStart(date: Date, period: "day" | "week" | "month"): Date {
  switch (period) {
    case "day":   return subDays(date, 1);
    case "week":  return subWeeks(date, 1);
    case "month": return subMonths(date, 1);
  }
}

