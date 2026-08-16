# Tool surface

The full reference for the ten tools: when the model should pick each one, parameters,
shared conventions and example outputs. The design rationale behind these choices is in
[DESIGN.md](DESIGN.md).

The guiding rule is that complexity belongs in the server, not in the model. Every tool
is designed so the model can express user intent directly, without intermediate
reasoning steps: the server handles entity resolution, period parsing, unit conversion
and API selection. A small model should be able to call any tool from the tool name and
the user's question alone.

In the schemas below, quoted **Description (from code)** blocks and example outputs are
reproduced verbatim from the server; their wording and formatting are part of the tool
surface itself.

## Overview

| Tool | The model uses it when... | Notes |
|---|---|---|
| `ha_history_get_current_time` | The user uses relative time and the date is unknown | Server-side date; skipped if an absolute range was already stated |
| `ha_history_list_areas` | The user mentions a room, location or place concept | First step in hierarchical discovery |
| `ha_history_list_devices` | An area or device concept needs analytics-ready entity_ids | Returns matched devices with ready entity_ids |
| `ha_history_list_device_entities` | One device needs deeper inspection than `list_devices` returned | Optional follow-up on one device |
| `ha_history_list_entities` | Direct entity search when the entity family is already known | Primary discovery tool; array filters `domains`/`areas`/`device_classes` |
| `ha_history_get_sensor_stats` | The user asks about numeric sensor values over time | Multi-entity, multi-aggregation, filtering, grouping |
| `ha_history_get_consumption` | The user asks how much energy/water/gas was used or produced | Delta-from-sum, interval breakdowns, comparisons |
| `ha_history_detect_sessions` | The user asks for sessions from a numeric threshold sensor | Numeric sensors only; hourly-statistics based |
| `ha_history_get_state` | The user asks for the current state of one entity | Fallback current-state reader |
| `ha_history_get_state_history` | The user asks about binary/discrete-state history or location timelines | Binary sensors, person/device_tracker, named-state entities |

## Discovery, then analytics

The server uses a two-phase design. Discovery tools (`list_areas`, `list_devices`,
`list_device_entities`, `list_entities`) narrow a room or appliance concept down to
exact entity ids. The analytics tools then take those exact ids (`entity_ids` array or
`entity_id`); they do not resolve free-text entity descriptions. This split avoids the
common failure mode of an analytics call silently matching an entity from an unrelated
device elsewhere in the house.

Use hierarchical discovery (`list_areas` → `list_devices` → `list_device_entities`)
when the user mentions a room or place ("kitchen temperature", "garage charger"), when
the user names an appliance ("EV charger", "washing machine"), or when `list_entities`
returned weak or cross-device matches. Use `list_entities` directly when the entity
family is already known ("bedroom temperature" →
`domains=["sensor"] search="bedroom" device_classes=["temperature"]`) or when the
entity id was already resolved earlier in the conversation.

Example flows:

**EV charger power query**
1. `ha_history_list_areas` → find "Garage"
2. `ha_history_list_devices area="Garage" search="charger"` → ready entity_ids
   `sensor.ev_charger_power` and `sensor.ev_charger_energy`
3. `ha_history_get_sensor_stats entity_ids=["sensor.ev_charger_power"] ...`

**Multi-room temperature comparison, one call**
1. `ha_history_list_entities areas=["Kitchen","Living Room","Bedroom","Outdoor"]
   device_classes=["temperature"]` → ready temperature entity_ids
2. `ha_history_get_sensor_stats entity_ids=[...] interval="day"` → one aligned table

One running server connects to exactly one Home Assistant instance; multi-home setups
register one MCP server per home and the client routes by name (rationale in
[DESIGN.md](DESIGN.md)).

## Period resolution (applies to all time parameters)

All `start_time`/`end_time` parameters accept any of these formats and the server
resolves all of them:

| Input | Resolved to |
|---|---|
| `"24h"`, `"7d"`, `"2w"`, `"1m"`, `"1y"` | Relative sliding window, e.g. `"7d"` = now − 7 days |
| `"2026-04-01"` | Start of that calendar day, local time |
| `"2026-04-01T00:00:00Z"` | Explicit ISO datetime, used directly |
| `"yesterday"` | Previous calendar day |
| `"this week"` / `"last week"` | Current / previous ISO week |
| `"this month"` / `"last month"` | Current month so far / previous complete month |
| `"this year"` / `"last year"` | Current year so far / previous complete year |
| `"last winter"` | Dec–Feb of the most recent completed winter (northern hemisphere) |
| `"last summer"` | Jun–Aug of the most recent completed summer (northern hemisphere) |
| `"Q1"` … `"Q4"` | Calendar quarter (end auto-computed when `end_time` is omitted) |
| `"february"`, `"march"`, … | Most recent complete occurrence of that month |
| `"overnight"` | 22:00 yesterday → 06:00 today (`detect_sessions` and `get_state_history` only) |

Defaults: `start_time` = `"30d"`, `end_time` = now.

The model passes exactly what the user said. The server resolves it, and the response's
`Period:` label always echoes the resolved absolute date range so the model can verify
and cite the dates the server actually computed, e.g.
`Period: last 7d (2026-08-09 → 2026-08-16)` or
`Period: February 2026 (2026-02-01 → 2026-02-28)`.

## Shared response and error conventions

- **Strict parameters.** Every tool schema declares `additionalProperties: false`, and
  the dispatcher validates arguments before any handler runs: an unknown or misspelled
  parameter is rejected with
  `ERROR: Unknown parameter "..." for <tool> — the call was NOT executed.` followed by
  the list of valid parameters. Missing required parameters and out-of-enum values are
  rejected the same way. A hallucinated parameter or value can never be silently
  ignored.
- **Closed-world zero results.** An empty discovery result (`list_entities`,
  `list_devices`) is terminal evidence, not an invitation to retry: it includes a
  complete inventory of what does exist in the searched scope (per-class device lists,
  full domain listings or all device names) and ends with a stop rule: if the thing is
  not in the inventory, it does not exist; do not try more search words; tell the user
  or ask for the exact name. The inventory also warns that listed devices may belong to
  other rooms and must not be silently substituted for the requested one.
- **Wrong-tool routing.** Calling `detect_sessions` on a discrete-state entity
  (binary_sensor, person, ...) returns a routing error pointing to
  `ha_history_get_state_history` instead of a failed catalog lookup, and `group_by`
  values a tool does not support are rejected with a pointer to the tool that does.
  When session mode of `get_state_history` matches zero sessions, the payload lists the
  states that were observed (with counts), so a never-occurring `state_value` is
  provably wrong rather than an invitation to improvise.
- **Error strings.** All validation and API errors start with `ERROR:` and state when
  the call was not executed.
- **Tables.** All tabular output is rendered as unpadded ` | `-separated rows (no
  column-alignment whitespace, no dashed separator lines) inside a fenced code block,
  so markdown-rendering chat UIs show them monospace. Surrounding prose (headers,
  notes, hints) stays outside the fence.
- **Row caps.** Tools with a `max_results` parameter accept a positive number or the
  string `"all"`; anything else is an `ERROR` and the call is not executed. When a
  result is capped, the response says how many rows were shown out of how many exist,
  and summary figures always cover the full dataset, never just the visible rows.
- **Comparisons.** A requested comparison that cannot be computed is reported as
  `Comparison … unavailable — …` (reference-period fetch failed, or too few readings).
  It is never silently dropped and never rendered as a fake `-100%`.

---

## Tool 1: `ha_history_get_current_time`

**Description (from code):** Returns the current date and time from the Home Assistant
server. Call this before time-based queries that use relative or named periods such as
"last month", "this winter", "yesterday", or "recently". Do not rely on your training
data to infer the current date — it will often be wrong. Skip only if an absolute ISO
date range has already been stated in this conversation.

```typescript
{
  name: "ha_history_get_current_time",
  inputSchema: {
    type: "object",
    properties: {},   // no parameters
    required: [],
    additionalProperties: false
  }
}
```

**Example output:**
````
Current time: 2026-08-16T09:41:00+02:00
Date: Sunday 16 August 2026
UTC offset: +02:00
Week: 33 of 2026
Home: Home
````

---

## Tool 2: `ha_history_list_areas`

**Description (from code):** Lists the areas (rooms and locations) defined in the home.
Use when the user wants to explore areas or when you need the exact area name for
`ha_history_list_devices`. Narrow by name with `search`. Returns area names to reuse
with `area="<name>"` in `ha_history_list_devices`, which also surfaces ready
entity_ids.

```typescript
{
  name: "ha_history_list_areas",
  inputSchema: {
    search?: string,       // substring match on area names, case-insensitive
    max_results?: number   // default: all areas
  }
  // required: [], additionalProperties: false
}
```

**Example output:**
````
5 areas found in Home:

  Bathroom
  Bedroom
  Kitchen
  Living Room
  Outdoor

Next step: call ha_history_list_devices with area="<name>" to see devices and ready entity_ids in that area.
````

---

## Tool 3: `ha_history_list_devices`

**Description (from code):** Lists devices in the home, filtered by area or search. Use
`area` for room-based discovery and `search` for device or appliance lookup. Returns
matched devices together with analytics-ready entity_ids on each device. Use the
returned entity_ids directly with the analytics tools; call
`ha_history_list_device_entities` only when you need deeper per-device inspection.

```typescript
{
  name: "ha_history_list_devices",
  inputSchema: {
    area?: string,               // area name from ha_history_list_areas, case-insensitive
    search?: string,             // substring/word match on device names
    include_disabled?: boolean,  // default: false
    max_results?: number         // default: unlimited when search or area is provided
  }
  // required: [], additionalProperties: false
}
```

Behavior notes: an unfiltered call (neither `area` nor `search`) is deliberately
blocked; it returns the device count, the list of available areas and an example call
instead of an unusably long list. Each matched device carries up to 4 "Ready entities"
pre-selected for analytics, labeled `measurement` (use `ha_history_get_sensor_stats`),
`cumulative` (use `ha_history_get_consumption`) or `no-stats`.

**Example output:**
````
2 devices found in area "Outdoor" (search=charger) in Home:

  Car Charging Plug [ExampleCorp]
    Metrics: energy, power
    Ready entities:
      - sensor.car_charging_plug_power (power, measurement)
      - sensor.car_charging_plug_energy (energy, cumulative)
  Outdoor Smart Plug
    Metrics: power
    Ready entities:
      - sensor.outdoor_plug_power (power, measurement)

Next: pass a Ready entity_id to ha_history_get_sensor_stats (measurement) or ha_history_get_consumption (cumulative); ha_history_list_device_entities only for more entities from one device.
````

---

## Tool 4: `ha_history_list_device_entities`

**Description (from code):** Lists entities (sensors and controls) on a specific
device. Use when `ha_history_list_devices` did not already surface the needed
entity_ids or when you need a deeper per-device inspection. Returns entity_ids with
their metric kind and analytics capability. Use measurement sensors with
`ha_history_get_sensor_stats` and cumulative counters with
`ha_history_get_consumption`.

```typescript
{
  name: "ha_history_list_device_entities",
  inputSchema: {
    device: string,                // required — device name, partial match supported
    device_class?: "power" | "energy" | "temperature" | "humidity" | "motion" | "presence",
    include_diagnostics?: boolean, // default: false
    max_results?: number           // default: 20
  }
  // required: ["device"], additionalProperties: false
}
```

**Example output:**
````
4 entities on device "Car Charging Plug" in Home:

```
entity_id | friendly_name | kind | analytics
sensor.car_charging_plug_power | Car Charging Plug Power | power | measurement
sensor.car_charging_plug_energy | Car Charging Plug Energy | energy | cumulative
sensor.car_charging_plug_current | Car Charging Plug Current | other | measurement
sensor.car_charging_plug_voltage | Car Charging Plug Voltage | other | measurement
```

Next: use the entity_id with ha_history_get_sensor_stats (measurement) or ha_history_get_consumption (cumulative).
````

Behavior notes:

- Diagnostic and config entities are hidden by default; `include_diagnostics=true`
  shows them. Hidden, disabled and diagnostic entities carry a
  `[hidden]`/`[disabled]`/`[diagnostic]` flag in the `analytics` column.
- `no-stats` entities have no long-term statistics; `ha_history_get_state` reads their
  current value.
- If nothing on the device matches `device_class`, the tool relaxes the filter and
  shows all the device's entities, with an explicit note that the filter did not hold.
- Partial device names are resolved by scoring, and other plausible matches are listed
  (`Resolved "..." to "...". Other matching devices: ...`) so a wrong resolution can be
  corrected.

---

## Tool 5: `ha_history_list_entities`

**Description (from code):** Primary discovery tool for the exact entity_ids that the
`ha_history_*` analytics tools require. Filter by area, device, device_class, and
search. Results are grouped by area and device and include entity_id, name, unit, and
type. For one entity's live state, use `ha_history_get_state` after discovery. Not
needed before device-control (Hass*) tools — those take plain names and areas, never
entity_ids.

```typescript
{
  name: "ha_history_list_entities",
  inputSchema: {
    domains?: string[],          // e.g. ["sensor"], ["binary_sensor"], or ["person","device_tracker"].
                                 // Leave empty for statistics-ready entities.
    search?: string,             // matched against entity_id, friendly name, and device name.
                                 // Multiple words use AND semantics. Use for name words, not type words.
    areas?: string[],            // e.g. ["Kitchen"] or ["Kitchen","Living Room","Bedroom"]
    device?: string,             // device-name filter for one appliance/device
    device_classes?: ("temperature" | "humidity" | "power" | "energy"
                      | "motion" | "occupancy" | "presence")[],
    include_state?: boolean,     // default: false — adds current state to each row
                                 // (costs one extra full state-machine fetch)
    max_results?: number | string // default: 100; "all" for the complete list
  }
  // required: [], additionalProperties: false
}
```

Behavior notes:

- The singular parameters `domain`, `area`, `device_class` and the legacy `metric`
  parameter no longer exist; only the array forms above. Calls using them are rejected
  at dispatch as unknown parameters.
- Multiple `domains` are only supported when all of them are live-state discovery
  domains (`binary_sensor`, `device_tracker`, `zone`, `person`, `input_boolean`,
  `input_select`, `input_text`), e.g. `domains=["person","device_tracker"]` for person
  tracking. For statistics entities, pass at most one domain.
- Live-only domains are served from the live state machine and rendered as a fenced
  table (`entity_id | friendly_name | state | device_class`, the last column varying by
  domain). Statistics entities are rendered as an area/device-grouped list.
- When filtering `device_classes` for temperature or humidity without a `device`
  filter, an ambient heuristic excludes device-internal readings (battery, target,
  setpoint, ...); exclusions are counted and confessed in a note, never applied
  silently.
- A plain `search` also sweeps live-state-only sensors (e.g.
  `device_class=timestamp`) and appends them after the statistics results; if no
  statistics entity matches, it falls back to a full live-state search.

**Example output (statistics path):**
````
3 entities found in Home (domains=sensor) (search=kitchen):

Area: Kitchen
  Device: Kitchen Climate Sensor
    - sensor.kitchen_temperature | Kitchen Temperature | device_class=temperature | unit=°C | type=measurement
    - sensor.kitchen_humidity | Kitchen Humidity | device_class=humidity | unit=% | type=measurement
  Device: Kitchen Smart Plug
    - sensor.kitchen_plug_energy | Kitchen Plug Energy | device_class=energy | unit=kWh | type=cumulative

Next: pass the exact entity_id to an analytics tool, e.g. ha_history_get_sensor_stats with entity_ids=["sensor.kitchen_temperature"] (measurements), ha_history_get_consumption with entity_id="..." (cumulative meters), or ha_history_get_state_history with entity_id="..." (binary/discrete states).
````

**Example output (live-only domain):**
````
2 person entities found in Home:

```
entity_id | friendly_name | state | domain
person.alex | Alex | home | person
person.sam | Sam | not_home | person
```

Note: person and device_tracker entities show location zones (e.g. "home", "not_home", zone name).
Use ha_history_get_state_history for zone/session history and ha_history_get_state for current coordinates or attributes.
History comes from recorder state history, so retention is typically about 10 days.

Next: pass the exact entity_id to an analytics tool, e.g. ha_history_get_sensor_stats with entity_ids=["person.alex"] (measurements), ha_history_get_consumption with entity_id="..." (cumulative meters), or ha_history_get_state_history with entity_id="..." (binary/discrete states).
````

When a result is capped, the response adds a per-area breakdown
(`Showing 100 of 240 statistics entities. By area: Kitchen 32, Living Room 28, …
Narrow with areas=, device_classes=, or search=, or pass max_results="all".`) so a
capped list stays navigable.

---

## Tool 6: `ha_history_get_sensor_stats`

**Description (from code):** Computes statistics for one or more instantaneous-value
sensors such as temperature, humidity, CO₂, pressure, illuminance, or power in W.
Always pass `entity_ids` as an array. Prefer one multi-entity call over repeated
single-entity calls when units match. Use `aggregations` for several whole-period stats
in one call. Use `interval` for time series and `group_by` for repeating patterns. Do
not use for cumulative consumption in kWh; use `ha_history_get_consumption`. Do not use
for event counting; use `ha_history_detect_sessions`.

```typescript
{
  name: "ha_history_get_sensor_stats",
  inputSchema: {
    entity_ids: string[],        // required — exact entity_ids; one item for a single sensor,
                                 // multiple for homogeneous comparisons (same unit)
    start_time?: string,         // default: "30d"
    end_time?: string,           // default: now
    aggregations?: ("mean" | "min" | "max" | "median" | "count")[],
                                 // default: ["mean"]
    interval?: "none" | "hour" | "day" | "week" | "month",
                                 // "none" = whole-period summary (default behavior);
                                 // cannot be used with group_by
    group_by?: "hour_of_day" | "day_of_week",
                                 // pattern analysis across the full period;
                                 // cannot be used with interval
    filter_operator?: "<" | "<=" | ">" | ">=" | "=",
                                 // keep only buckets/slots whose aggregated value satisfies the
                                 // threshold; requires interval (not "none") or group_by
    filter_value?: number,       // required when filter_operator is set
    max_results?: number | string // interval time series only; caps rows, not columns.
                                 // Default: 100 (MAX_RESULTS env). "all" for the full series.
  }
  // required: ["entity_ids"], additionalProperties: false
}
```

Aggregation rules, enforced by the server and rejected with `ERROR:` otherwise:

- There is no singular `aggregation` parameter (it was removed); use `aggregations`.
- `"median"` is whole-period only (`interval="none"`, no `group_by`), because a
  per-bucket median is not computable from hourly statistics.
- `"count"` must be alone (`aggregations=["count"]`) and requires `group_by` plus
  `filter_operator`/`filter_value`. It counts readings per slot that satisfy the
  filter, rendered `matched/total` ("how many days per hour exceeded 21°C?").
- `filter_operator` with multiple aggregations is rejected as ambiguous; filter with a
  single aggregation.
- Multi-entity calls require all sensors to share the same unit.

**Example outputs:**

Single-entity mean (scalar):
````
Sensors: Kitchen Temperature (sensor.kitchen_temperature)
Period: last 7d (2026-08-09 → 2026-08-16)
Aggregation: mean
Unit: °C

```
value
21.4
```
````

Single-entity min/max carries the bucket where the extreme occurred:
````
Sensors: Bedroom Temperature (sensor.bedroom_temperature)
Period: yesterday (2026-08-15 → 2026-08-15)
Aggregation: min
Unit: °C

```
value | time_bucket
14.3 | 2026-08-15 04:00
```
````

Whole-period multi-entity multi-stat comparison (`interval="none"`,
`aggregations=["mean","min","max"]`):
````
Sensors: Basement Temperature (sensor.basement_temperature) | Kitchen Temperature (sensor.kitchen_temperature) | Living Room Temperature (sensor.living_room_temperature)
Period: last 7d (2026-08-09 → 2026-08-16)
Aggregations: mean | min | max
Unit: °C
Rows: 3

```
sensor | mean | min | max
Basement Temperature | 21.3 | 19.9 | 22.6
Kitchen Temperature | 23.7 | 21.3 | 26.9
Living Room Temperature | 23.4 | 20.9 | 28
```
````

Multi-entity daily time series (`interval="day"`). `Rows:` is the total bucket count
before the row cap, and the `Whole period:` line always covers the full period so a
truncated table can never mislead:
````
Sensors: Kitchen Temperature (sensor.kitchen_temperature) | Living Room Temperature (sensor.living_room_temperature)
Period: last 7d (2026-08-09 → 2026-08-16)
Aggregation: mean per day
Unit: °C
Rows: 7
Whole period: kitchen: mean 21.1, min 19.6, max 26.9 | living room: mean 21.9, min 20.2, max 28

```
time | kitchen | living room
2026-08-09 | 21.4 | 22.1
2026-08-10 | 20.8 | 21.6
2026-08-11 | 21 | 21.9
2026-08-12 | 21.2 | 22
2026-08-13 | 20.9 | 21.7
2026-08-14 | 21.3 | 22.2
2026-08-15 | 21.1 | 21.8
```
````

A filtered interval query adds a `Filter:` header line, e.g.
`Filter: Mean > 25 °C — 3 of 31 buckets matched (28 excluded)`. When capped, a footer
notice reads `Showing 100 of 240 day buckets (oldest first); the whole-period line
above covers the full period. Pass max_results="all" for the complete series.`

Group-by pattern (`group_by="hour_of_day"`):
````
Sensors: Kitchen Temperature (sensor.kitchen_temperature)
Period: last 30d (2026-07-17 → 2026-08-16)
Aggregation: mean by hour_of_day
Unit: °C
Slots: 24 of 24 with data

```
bucket | kitchen temperature
00:00 | 20.1
01:00 | 19.8
02:00 | 19.6
```
````

Count mode (`group_by="day_of_week"`, `aggregations=["count"]`, `filter_operator=">"`,
`filter_value=21`): the header gains a `Counting:` line and cells are `matched/total`:
````
Sensors: Living Room Temperature (sensor.living_room_temperature)
Period: last 30d (2026-07-17 → 2026-08-16)
Aggregation: count by day_of_week
Unit: °C
Slots: 7 of 7 with data
Counting: mean > 21 °C

```
bucket | living room temperature
Mon | 3/5
Tue | 4/4
Wed | 2/4
```
````

Footer notes appear when relevant: `Note: no data in this period for: <names>`, and a
low-sample warning when some group-by slots have fewer than 5 readings.

---

## Tool 7: `ha_history_get_consumption`

**Description (from code):** Calculates how much energy, water, gas, or other resource
was consumed or produced in the home over a time period. Use for totals, interval
breakdowns, and period-over-period comparisons of cumulative meters. Always returns
consumption (the change over the period), never raw meter readings. Do NOT use for
instantaneous sensors (temperature, power in Watts) → use `ha_history_get_sensor_stats`.

```typescript
{
  name: "ha_history_get_consumption",
  inputSchema: {
    entity_id: string,           // required — exact entity_id of a cumulative meter. Do not guess.
    start_time?: string,         // default: "30d"
    end_time?: string,           // default: now
    interval?: "none" | "day" | "week" | "month",
                                 // default: "none" (whole-period total).
                                 // Required when using filter_operator/filter_value.
    filter_operator?: "<" | "<=" | ">" | ">=" | "=",
                                 // filter buckets by consumption; requires interval
    filter_value?: number,       // required when filter_operator is set
    max_results?: number | string // interval breakdown only. Default: 100 (MAX_RESULTS env);
                                 // "all" for the complete series
    comparison?: "previous_period" | "same_period_last_year"
                                 // only with interval="none"; server computes reference dates
  }
  // required: ["entity_id"], additionalProperties: false
}
```

The parameter is `entity_id`; the old `entity` name no longer exists and is rejected at
dispatch. The entity must have cumulative (`sum`) statistics; measurement-only sensors
are rejected with a pointer to `ha_history_get_sensor_stats`.

**Example outputs:**

Single total (`interval="none"`):
````
Sensor: EV Charger Energy · Garage (sensor.ev_charger_energy)
Period: February 2026 (2026-02-01 → 2026-02-28) (28 daily readings)
Total: 87.3 kWh
````

With comparison:
````
Sensor: Grid Import · Utility (sensor.grid_import_energy)
Period: last month (2026-07-01 → 2026-07-31) (31 daily readings)
Total: 312.4 kWh
Comparison (same period last year): 287.1 kWh  Δ +25.3 kWh (+9%)
````
An uncomputable comparison is reported, never dropped:
`Comparison (previous period): unavailable — reference period has 1 readings (2+ needed)`.

Interval breakdown (`interval="day"`), value-only rows with no header row; the summary
covers all buckets:
````
Sensor: EV Charger Energy · Garage (sensor.ev_charger_energy)
Period: last week (2026-08-03 → 2026-08-09)
7 day buckets — Total: 46.9 kWh, Avg: 6.7 kWh/day

```
2026-08-03 | 12.4 kWh
2026-08-04 | 0 kWh
2026-08-05 | 11.8 kWh
2026-08-06 | 0 kWh
2026-08-07 | 14.1 kWh
2026-08-08 | 8.6 kWh
2026-08-09 | 0 kWh
```
````

With a filter, the summary line gains
`— 3/7 matched: Consumption > 10 kWh (4 excluded)`. Negative deltas (meter reset or
replacement) are excluded but confessed:
`(1 bucket with negative delta excluded — meter reset?)`. When capped:
`Showing 100 of 365 day buckets (oldest first); Total/Avg above cover all 365. Pass
max_results="all" to retrieve the complete series, or narrow the period.`

---

## Tool 8: `ha_history_detect_sessions`

**Description (from code):** Detects activity sessions from a numeric sensor using a
power/value threshold. Use for threshold-based activity questions such as charging
sessions, appliance runs, or heating cycles. Uses long-term hourly statistics → full
date range, no retention limit, ±1h precision. For binary sensors or person/zone state
history, use `ha_history_get_state_history` instead. Returns event count, total
duration, a compact session list, or a daily summary with `group_by="day"`.

```typescript
{
  name: "ha_history_detect_sessions",
  inputSchema: {
    entity_id: string,           // required — exact entity_id, e.g. "sensor.car_charger_power"
    start_time?: string,         // default: "30d". Special: "overnight" = 22:00 yesterday → 06:00 today
    end_time?: string,           // default: now
    threshold: number,           // required — minimum value to count as "active",
                                 // in the sensor's own unit (e.g. 100 for a Watt sensor)
    min_duration_minutes?: number, // >= 0, default: 1. Hourly statistics → values below 60
                                 // have no additional effect
    max_gap_minutes?: number,    // >= 0, default: 0 (no merging). Bridge inactive gaps shorter
                                 // than this into one session; use multiples of 60
    group_by?: "day",            // one row per day (date | count | first | last | total active)
    day_start_hour?: number,     // 0-23, default: 0. Only with group_by="day"; shifts the
                                 // day boundary from midnight
    max_results?: number | string, // default: 20; "all" to list all.
                                 // Summary stats always cover the full dataset
    comparison?: "previous_period" | "same_period_last_year"
  }
  // required: ["entity_id", "threshold"], additionalProperties: false
}
```

The parameter is `entity_id` (the old `entity` is rejected at dispatch), and
`threshold` is formally required; a call without it is rejected before execution.

**Example outputs:**

Session list. The header always prints the full detection config, including the
`Gap tolerance` even at its 0 default, because it materially changes session counts:
````
Sensor: EV Charger Power · Garage (sensor.ev_charger_power)
Period: February 2026 (2026-02-01 → 2026-02-28) | Condition: ≥ 100 W | Min duration: 5 min | Gap tolerance: 0 min
Source: Hourly statistics (±1h precision, full retention)

14 sessions — Total active: 47h 23m (7% of period) | Avg: 3h 23m | Longest: 6h 47m on 2026-02-03

```
2026-02-01 18:00 → 2026-02-01 22:00 | 4h | peak 7350 W
2026-02-03 07:00 → 2026-02-03 14:00 | 7h | peak 7400 W
2026-02-05 19:00 → 2026-02-05 23:00 | 4h | peak 7380 W
```

Showing 3 of 14 sessions (oldest first); the summary above covers all 14. Pass max_results="all" to see all.
````

Daily summary (`group_by="day"`):
````
Sensor: EV Charger Power · Garage (sensor.ev_charger_power)
Period: February 2026 (2026-02-01 → 2026-02-28) | Condition: ≥ 100 W | Min duration: 5 min | Gap tolerance: 0 min
Source: Hourly statistics (±1h precision, full retention)

14 sessions across 11 active days (avg 1.3/day)

```
Date | Sessions | First | Last | Active
2026-02-01 | 1 | 18:00 | 22:00 | 4h
2026-02-03 | 2 | 07:00 | 23:00 | 9h
2026-02-05 | 1 | 19:00 | 23:00 | 4h
```
````
With `day_start_hour=6` the summary line adds
`| Day boundary: 06:00 (+1 = next calendar day)` and post-boundary times carry a `+1`
suffix.

Comparison appends one line:
`Comparison to prev period: 11 sessions, 39h 10m → +3 sessions (+27%), +8h 13m (+21%)`,
or `Comparison to prev period: unavailable — reference-period fetch failed (…)` when it
cannot be computed.

Zero results always state their denominator:
`0 sessions detected (672 data points examined in this period). If sessions were
expected, loosen the condition (threshold / state_value), lower min_duration_minutes,
or widen the period.`

---

## Tool 9: `ha_history_get_state`

**Description (from code):** Returns the current state of one entity by exact
entity_id. Works for all entity domains, including entities not exposed to the voice
assistant. Returns the state value, unit, last_changed/last_updated timestamps, and key
attributes. If a GetLiveContext tool is available, prefer it for current values of
exposed entities; use this tool for entities it cannot see, for staleness checks via
timestamps, or when the entity_id is already resolved.

```typescript
{
  name: "ha_history_get_state",
  inputSchema: {
    entity_id: string   // required — exact entity_id resolved earlier. Do not guess.
  }
  // required: ["entity_id"], additionalProperties: false
}
```

**Example output:**
````
Kitchen Temperature [temperature]
entity_id: sensor.kitchen_temperature
state: 21.4 °C
last_changed: 2026-08-16 09:38
````
Domain-specific attributes follow when present (`current_temperature`/`hvac_action` for
climate, `latitude`/`longitude`/`battery_level` for device_tracker, `brightness` for
light, ...). Timestamps are rendered in the HA timezone.

---

## Tool 10: `ha_history_get_state_history`

**Description (from code):** Gets the state-change history for any discrete-state
entity. Use for binary sensors (motion, door, window, presence), person/device_tracker
(zone and location history), and any entity with named states. Two modes: session mode
when `state_value` is set, timeline mode when it is omitted. Source: HA recorder state
history — limited to ~10 days by default. Returns a timeline of transitions, or session
counts and durations when `state_value` is set.

```typescript
{
  name: "ha_history_get_state_history",
  inputSchema: {
    entity_id: string,           // required — e.g. "binary_sensor.entrance_motion". Do not guess.
    state_value?: string,        // target state for session mode, case-insensitive.
                                 // Binary sensors: "on"/"off". Person/device_tracker: zone name.
                                 // Prefix ! for "any state except", e.g. "!home".
                                 // Omit for a full timeline of all transitions.
    start_time?: string,         // default: "30d". Special: "overnight" = 22:00 yesterday → 06:00 today
    end_time?: string,           // default: now
    min_duration_minutes?: number, // session mode only. >= 0, default: 0
    max_gap_minutes?: number,    // session mode only. >= 0, default: 0 (no merging)
    group_by?: "day",            // session mode only — one row per day
    day_start_hour?: number,     // 0-23, default: 0. Only with group_by="day"
    max_results?: number | string, // default: 20; "all" to list all.
                                 // Timeline: caps transitions. Session mode: caps sessions or days
    comparison?: "previous_period" | "same_period_last_year"  // session mode only
  }
  // required: ["entity_id"], additionalProperties: false
}
```

Behavior notes:

- The parameter is `entity_id` (the old `entity` is rejected at dispatch).
- `state_value` negation: a leading `!` means "any state except", e.g.
  `state_value="!home"` measures time spent outside the Home zone. The condition is
  echoed in the header as `Condition: state != "home"`.
- Session-only parameters (`min_duration_minutes`, `max_gap_minutes`, `group_by`,
  `day_start_hour`, `comparison`) passed in timeline mode are rejected with an `ERROR`,
  never silently discarded.

**Example outputs:**

Timeline mode (no `state_value`); each row shows the transition from the previous
state:
````
Entity: binary_sensor.entrance_motion
Period: last 24h (2026-08-15 → 2026-08-16) | Mode: all transitions
Source: State history (~10 day retention)

12 transitions

```
2026-08-15 07:12 | on
2026-08-15 07:15 | on → off
2026-08-15 12:40 | off → on
2026-08-15 12:44 | on → off
```

Showing 4 of 12 transitions (oldest first). Pass max_results="all" to see all.
````

Session mode (`state_value="on"`); same shape as `ha_history_detect_sessions`, without
peak values:
````
Entity: binary_sensor.entrance_motion
Period: last 7d (2026-08-09 → 2026-08-16) | Condition: state = "on" | Min duration: 0 min | Gap tolerance: 0 min
Source: State history (~10 day retention)

23 sessions — Total active: 1h 52m (1% of period) | Avg: 5 min | Longest: 18 min on 2026-08-12

```
2026-08-09 07:12 → 2026-08-09 07:15 | 3 min
2026-08-09 12:40 → 2026-08-09 12:44 | 4 min
2026-08-10 08:03 → 2026-08-10 08:21 | 18 min
```

Showing 3 of 23 sessions (oldest first); the summary above covers all 23. Pass max_results="all" to see all.
````

`group_by="day"`, `day_start_hour`, comparison lines and zero-session reporting all
behave exactly as in `ha_history_detect_sessions`.

---

## Cross-tool paved paths

Discovery responses end in a copy-pastable next step so the model can chain into
analytics without guessing:

````
# After list_areas:
Next step: call ha_history_list_devices with area="<name>" to see devices and ready entity_ids in that area.

# After list_devices:
Next: pass a Ready entity_id to ha_history_get_sensor_stats (measurement) or ha_history_get_consumption (cumulative); ...

# After list_entities / list_device_entities:
Next: pass the exact entity_id to an analytics tool, e.g. ha_history_get_sensor_stats with entity_ids=["sensor.example"] ...
````

The analytics tools themselves are terminal answers and carry no hint; instead their
headers echo everything needed to verify or refine the call (entity_ids, resolved
period, aggregation, filter/condition, gap tolerance, whole-period aggregates).

## Agent instructions

The recommended agent-instructions block for models using this server lives in the
[README](README.md) (in the Home Assistant Assist setup guide). It is the single
maintained copy.
