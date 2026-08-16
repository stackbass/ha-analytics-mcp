/**
 * capture-fixture.ts
 *
 * Captures raw HA history (and optionally statistics) for one or more entities
 * and saves them as JSON fixtures for use in Vitest tests.
 *
 * Usage:
 *   node --env-file=.env --import=tsx/esm scripts/capture-fixture.ts \
 *     --entity binary_sensor.motion_entrance \
 *     --period "last 7d" \
 *     --output src/__tests__/fixtures/motion-entrance.json
 *
 * Or capture multiple entities into one fixture:
 *   node --env-file=.env --import=tsx/esm scripts/capture-fixture.ts \
 *     --entity sensor.car_charger_power,sensor.car_charger_energy \
 *     --period "last 30d" \
 *     --output src/__tests__/fixtures/car-charger.json
 *
 * Flags:
 *   --entity    entity_id(s), comma-separated or repeated  (required)
 *   --period    time expression understood by period-resolver (default: "last 7d")
 *   --output    output file path  (default: src/__tests__/fixtures/<entity>.json)
 *   --stats     also capture statistics (hourly, for numeric sensors)
 *   --list      list entities matching a search term instead of capturing
 *
 * The script needs HA_URL and HA_TOKEN env vars (pass via --env-file).
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import {
  fetchHAConfig,
  fetchHistory,
  fetchStatistics,
  fetchEnrichedEntities,
  getConnection,
} from "../src/ha-client.js";
import { resolvePeriod } from "../src/period-resolver.js";
import { config } from "../src/config.js";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getFlag(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

function getMultiFlag(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) {
      values.push(...args[i + 1].split(",").map((s) => s.trim()));
    }
  }
  return values;
}

const entityIds = getMultiFlag("--entity");
const period = getFlag("--period") ?? "last 7d";
const outputArg = getFlag("--output");
const captureStats = args.includes("--stats");
const listMode = args.includes("--list");
const listQuery = getFlag("--list");

// ---------------------------------------------------------------------------
// List mode — search entities without capturing
// ---------------------------------------------------------------------------

interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

async function runList(query: string) {
  console.log(`\nSearching for entities matching: "${query}"\n`);

  // Fetch both statistics entities and all states (binary sensors have no statistics)
  const [entitiesResult, statesResult] = await Promise.all([
    fetchEnrichedEntities(),
    fetch(`${config.haUrl}/api/states`, {
      headers: { Authorization: `Bearer ${config.haToken}` },
      signal: AbortSignal.timeout(10_000),
    }).then((r) => r.json() as Promise<HAState[]>).catch(() => [] as HAState[]),
  ]);

  if ("isError" in entitiesResult) {
    console.error("Failed to fetch entities:", entitiesResult);
    process.exit(1);
  }

  const q = query.toLowerCase();

  // Statistics entities (sensors with long-term history)
  const statMatches = entitiesResult.filter(
    (e) =>
      e.statistic_id.toLowerCase().includes(q) ||
      e.friendly_name.toLowerCase().includes(q) ||
      (e.area_name?.toLowerCase().includes(q) ?? false)
  );

  // All-states entities — include binary_sensors, input_booleans, etc. that have no statistics
  const statIds = new Set(entitiesResult.map((e) => e.statistic_id));
  const stateMatches = (statesResult as HAState[]).filter(
    (s) =>
      !statIds.has(s.entity_id) && // not already in statistics list
      (
        s.entity_id.toLowerCase().includes(q) ||
        (s.attributes["friendly_name"] as string | undefined ?? "").toLowerCase().includes(q) ||
        (s.attributes["area_id"] as string | undefined ?? "").toLowerCase().includes(q)
      )
  );

  if (statMatches.length === 0 && stateMatches.length === 0) {
    console.log("No matches found.");
    return;
  }

  if (statMatches.length > 0) {
    console.log(`Statistics entities (${statMatches.length}):\n`);
    for (const e of statMatches) {
      const area = e.area_name ? ` [${e.area_name}]` : "";
      const unit = e.unit ? ` (${e.unit})` : "";
      const kind = e.has_sum ? " sum" : e.has_mean ? " mean" : "";
      console.log(`  ${e.statistic_id}${area}${unit}${kind}`);
      console.log(`    "${e.friendly_name}"`);
    }
  }

  if (stateMatches.length > 0) {
    console.log(`\nOther entities with history (${stateMatches.length}) — no statistics:\n`);
    for (const s of stateMatches) {
      const fn = s.attributes["friendly_name"] as string | undefined;
      const label = fn ? `"${fn}"` : "";
      console.log(`  ${s.entity_id}  state="${s.state}"  ${label}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Capture mode — fetch history + optional statistics and write fixture
// ---------------------------------------------------------------------------

async function runCapture() {
  if (entityIds.length === 0) {
    console.error(
      "ERROR: --entity is required. Use --list <term> to search for entity IDs.\n" +
        "Example:\n" +
        "  node --env-file=.env --import=tsx/esm scripts/capture-fixture.ts \\\n" +
        "    --entity binary_sensor.motion_entrance --period 'last 7d'"
    );
    process.exit(1);
  }

  // Resolve period using the same logic as the MCP tools
  const haConfig = await fetchHAConfig();
  if ("isError" in haConfig) {
    console.error("Failed to connect to HA:", haConfig);
    process.exit(1);
  }

  const tz = config.haTimezone ?? haConfig.timezone;
  // Strip "last " prefix for relative durations like "last 7d" → "7d"
  // Named expressions like "last month", "last week" are passed through as-is
  const startExpr = period.replace(/^last\s+(?=\d)/i, "");
  const resolvedPeriod = resolvePeriod(startExpr, undefined, new Date(), tz);
  if (typeof resolvedPeriod === "string") {
    console.error(`Invalid period "${period}": ${resolvedPeriod}`);
    process.exit(1);
  }
  const { start, end, label } = resolvedPeriod;

  console.log(`\nHA: ${haConfig.locationName} (v${haConfig.version}, tz: ${tz})`);
  console.log(`Entities: ${entityIds.join(", ")}`);
  console.log(`Period: "${period}" → ${label}`);
  console.log(`  from: ${start.toISOString()}`);
  console.log(`  to:   ${end.toISOString()}`);

  // Fetch history
  console.log("\nFetching history...");
  const history = await fetchHistory(entityIds, start, end);
  if ("isError" in history) {
    console.error("fetchHistory failed:", history);
    process.exit(1);
  }

  // Summarise state counts per entity
  for (const [eid, states] of Object.entries(history)) {
    console.log(`  ${eid}: ${states.length} state entries`);
  }

  // Optionally fetch statistics (hourly)
  let statistics: Record<string, unknown> | undefined;
  if (captureStats) {
    console.log("\nFetching hourly statistics...");
    const statsResult = await fetchStatistics(
      entityIds,
      start,
      end,
      "hour",
      ["mean", "min", "max", "sum", "state", "change"]
    );
    if ("isError" in statsResult) {
      console.warn("fetchStatistics failed (continuing without stats):", statsResult);
    } else {
      statistics = statsResult as Record<string, unknown>;
      for (const [eid, rows] of Object.entries(statistics)) {
        console.log(`  ${eid}: ${(rows as unknown[]).length} statistic rows`);
      }
    }
  }

  // Build fixture
  const fixture = {
    meta: {
      description: `Captured from ${haConfig.locationName} — ${entityIds.join(", ")}`,
      ha_version: haConfig.version,
      ha_timezone: tz,
      entity_ids: entityIds,
      period_expression: period,
      period_label: label,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      captured_at: new Date().toISOString(),
    },
    history,
    ...(statistics ? { statistics } : {}),
  };

  // Determine output path
  const defaultName =
    entityIds.length === 1
      ? entityIds[0].replace(/\./g, "-").replace(/[^a-z0-9-_]/gi, "_") + ".json"
      : "fixture-" + Date.now() + ".json";

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputPath = resolve(
    __dirname,
    "..",
    outputArg ?? `src/__tests__/fixtures/${defaultName}`
  );

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(fixture, null, 2));
  console.log(`\nFixture saved → ${outputPath}`);

  // Print a quick state-value summary to help write expected test values
  console.log("\n--- State value sample (first 5 per entity) ---");
  for (const [eid, states] of Object.entries(history)) {
    console.log(`\n${eid}:`);
    const sample = states.slice(0, 5);
    for (const s of sample) {
      const state = s.s ?? s.state ?? "?";
      const ts = s.lc ?? s.last_changed ?? s.lu ?? s.last_updated ?? "?";
      console.log(`  t=${ts}  s="${state}"`);
    }
    if (states.length > 5) {
      console.log(`  ... (${states.length - 5} more)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (listMode || listQuery) {
    const query = listQuery ?? (entityIds[0] ?? "");
    if (!query) {
      console.error("ERROR: --list requires a search term, e.g. --list motion");
      process.exit(1);
    }
    await runList(query);
  } else {
    await runCapture();
  }

  // Close WebSocket and exit cleanly
  try {
    const conn = await getConnection();
    if (conn && "terminate" in conn) {
      (conn as { terminate(): void }).terminate();
    }
  } catch {
    // ignore
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
