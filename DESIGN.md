# Design and scope

This document records the design decisions behind ha-analytics-mcp and the reasoning
for them. The tool-by-tool reference is [TOOLS.md](TOOLS.md); the cache design has its
own document, [CACHE.md](CACHE.md).

## Problem statement

Most Home Assistant MCP servers treat historical data as a pass-through: they fetch raw
state arrays or recorder statistics from HA and return them directly to the model. The
results, reported repeatedly in the community, are history queries costing 30,000 to
40,000 tokens, models hallucinating averages and counts they cannot reliably compute
from long JSON arrays, and users hitting daily token limits within half an hour of
asking history questions. Even servers that target the right API (the recorder's
pre-aggregated `statistics_during_period` endpoint) deliver raw arrays instead of
computed answers.

## Core principle: complexity belongs in the server, not in the model

The model's job is to understand what the user wants and present the result. Every
reasoning step removed from the model (date arithmetic, entity lookup, unit conversion,
choosing the right aggregation) is a reasoning step that cannot go wrong. Small models
have a limited reasoning budget; they should spend it on the user, not on
infrastructure.

This principle drives every design decision:

- The server resolves natural-language periods; the model does not compute dates.
- The server provides search-assisted entity discovery; the model does not guess
  entity ids.
- The server chooses the right HA API; the model does not reason about recorder versus
  history endpoints.
- The server handles wrong-tool calls gracefully: a misdirected call returns a redirect
  to the right tool, not an opaque error that triggers retry loops.
- When in doubt, do more work in the server. Server complexity is always cheaper than a
  model reasoning step.

Concretely, the server receives a narrow analytical question ("average temperature last
7 days"), resolves the period and entity, fetches the minimum required rows from the HA
recorder, computes the answer server-side and returns a compact table. Fetched data and
computed results are cached in the running process, so follow-up questions about the
same entity and period often cost zero additional HA queries.

## Scope

The server complements the official HA MCP integration and the established community
control servers; it does not compete with them. Its center of gravity is historical
analysis and statistical reasoning over sensor data, plus a small set of read-only
helpers for current state and discrete-state history so the model can answer common
questions without bouncing between servers.

Out of scope, permanently: device control (services, actions), automation, script and
scene management, dashboard management, add-on and integration management, system
configuration, and WebSocket subscriptions or live event streams. Other servers cover
these well; see [COMPARISON.md](COMPARISON.md).

## The questions the server is designed to answer

The tool surface was derived from question patterns per sensor family, not from the HA
API's shape.

**Continuous numeric sensors** (temperature, humidity, CO₂, pressure, illuminance,
battery level). The recorder stores pre-aggregated hourly statistics (min, mean, max)
for these.

| Pattern | Example question |
|---|---|
| Period aggregate | "What was the average humidity in the bedroom last week?" |
| Period min/max | "What was the lowest temperature last night?" |
| Named-period comparison | "Compare living room humidity in April this year vs last year" |
| Threshold duration | "How many hours was the CO₂ above 1000 ppm last week?" |
| Threshold day count | "How many days had freezing temperatures this winter?" |
| Time-of-day pattern | "How does the kitchen temperature vary over the day?" |

**Energy and resource meters** (smart plugs, EV charger, solar inverter, grid, gas and
water meters). The recorder stores cumulative sums for these.

| Pattern | Example question |
|---|---|
| Period total | "How much energy did the EV charger use in February?" |
| Session count | "How many times was the car charged in February?" |
| Period comparison | "Is February's charging more or less than usual?" |
| Daily/weekly breakdown | "Show me daily energy consumption for last week" |
| Threshold day count | "How many days did solar produce more than 20 kWh?" |

**Binary and event sensors** (motion, door/window, occupancy, rain). The recorder
stores state-change history.

| Pattern | Example question |
|---|---|
| Event count | "How many times was the front door opened last week?" |
| Duration in state | "How long was the house unoccupied last month?" |
| Overnight check | "Was there any motion in the garage overnight?" |
| Time-of-day distribution | "What times does hallway motion usually trigger?" |

**Named-state entities** (thermostat modes, `person`/`device_tracker` zones).

| Pattern | Example question |
|---|---|
| Operating hours | "How many hours did the heating run last month?" |
| Zone history | "When did I leave home yesterday?" |
| Mode breakdown | "What share of time was the AC cooling vs fan-only last week?" |

The server-side computations behind these are period aggregation, delta computation
from cumulative sums, threshold counting, session detection (value above threshold for
a minimum duration, with gap bridging), cross-period comparison, hour-of-day and
day-of-week binning, and state-duration summation. Each is a small amount of plain
TypeScript (a session detector is a `for` loop with a threshold state machine), which
is one reason no statistics framework is needed; see the technology section.

## API strategy

The HA recorder exposes two distinct data stores:

| Store | Endpoint | Contents | Used for |
|---|---|---|---|
| Long-term statistics | WebSocket `recorder/statistics_during_period` | Hourly min/mean/max/sum, pre-aggregated, unlimited retention | All numeric-sensor analytics |
| Short-term history | WebSocket `history/history_during_period` | Raw state changes, ~10-day default retention | Discrete-state timelines, duration-in-state, binary/person history |
| Statistic ids | WebSocket `recorder/list_statistic_ids` | Which entities have long-term statistics | Entity discovery |

The long-term statistics endpoint is WebSocket-only; there is no REST equivalent
(`POST /api/recorder/statistics_during_period` returns 404).

The rule: use long-term statistics by default, because they are pre-aggregated,
retention-unlimited and cheap for the recorder to serve. Fall back to raw state history
only for entities that have no statistics: binary and discrete-state entities,
`person`/`device_tracker` timelines, and duration-in-state or transition questions.

## Caching

Historical data queries are the most expensive operations in HA's recorder, and a
conversation naturally generates follow-up questions about the same entity and period
("how many sessions?", then "is that normal?", then "how much energy total?"). The
server keeps a process-level in-memory cache with LRU eviction (`CACHE_MAX_ENTRIES`).
The key insight making this safe: HA never backfills or amends statistics older than
about 48 hours, so past data is immutable and can be cached without expiry, while
recent windows get short TTLs. There is no persistent cache layer; everything clears on
restart.

The current design caches rendered answers keyed by exact request parameters, which is
good at exact replay and poor at incremental refresh near "now".
[CACHE.md](CACHE.md) documents this limitation and the planned two-layer redesign (raw
coverage plus incremental tail fetch).

## Time parameter design

All `start_time`/`end_time` parameters accept, in one string field: relative windows
(`"7d"`, `"30d"`, `"2w"`), named periods (`"yesterday"`, `"last month"`, `"february"`,
`"last winter"`, `"Q1"`) and ISO dates (`"2026-02-01"`). The server resolves all of
them in the HA instance's timezone.

Strict-ISO-only parameters were rejected because they move date arithmetic onto the
model: published benchmarks (DateAugBench, across 8 model families) show small models
failing multi-step date arithmetic 20 to 30% of the time. Relative strings let the
model skip arithmetic entirely for the common case. The same hybrid format is used by
the official Grafana MCP server and by ha-mcp. Dates are always hyphenated
(`"2026-02-01"`, never `"20260201"`): BPE tokenizers fragment compact dates, which has
been measured to cost up to 10 points of accuracy on small models.

Models also have no internal clock, so "last month" is unresolvable without knowing
today's date. Three defences apply together: the client's system prompt should carry
the current date (most reliable); `start_time` defaults to `now - 30d` and `end_time`
to now, so the most common queries need no dates at all; and a
`ha_history_get_current_time` tool exists as an explicit anchor for clients without
system-prompt control. Interval granularities are a strict enum
(`"hour" | "day" | "week" | "month"`), which eliminates the `"daily"`/`"1d"`/`"DAILY"`
hallucination class entirely.

Cross-period comparison is a parameter
(`comparison: "previous_period" | "same_period_last_year"`), resolved entirely
server-side. Asking the model to compute "the same calendar dates one year prior" is
exactly the multi-step arithmetic that fails.

## One process per Home Assistant instance

Each running server connects to exactly one HA installation. Multi-home setups register
two MCP servers in the client configuration; the client routes by server name. The
alternative, a `home` parameter on every tool, would force the model to resolve which
home the user means on every query: one more reasoning step, and one that small models
get wrong. Authentication is a long-lived access token in the environment
(`HA_URL`/`HA_TOKEN`); setup is described in the [README](README.md).

## Error handling

When a tool fails opaquely, the model fills the void: a model that receives a 500 or
`null` from a temperature query will often respond with a fabricated temperature rather
than admit it does not know. For an analytics server this is the most dangerous failure
mode, so no tool ever throws an exception for the SDK to wrap. Every handler catches
errors internally and returns text the model can read, stating what went wrong, why it
probably happened and what to do next.

```
// Opaque: model guesses or loops
throw new Error("ECONNREFUSED");

// Readable: model can relay and recover
"ERROR: Cannot connect to Home Assistant at https://ha.example.com.
Check that HA_URL is correct and the instance is reachable."
```

Each error category has a designed message and an intended model action:

| Category | Message states | Intended model action |
|---|---|---|
| HA unreachable | URL, likely cause | Tell the user, suggest checking HA |
| Auth failure | 401, token invalid, how to regenerate | Tell the user |
| Entity not found | Candidate list with match reasons | Retry a candidate or run discovery |
| No statistics | Entity exists, why stats may be missing | Tell the user |
| Empty discovery | Complete inventory of what exists, stop rule | Conclude nonexistence |
| Empty data | Denominator ("0 sessions in 672 data points") | Tell the user honestly |
| Invalid period | The accepted formats | Retry with a valid format |
| Unknown parameter | "call was NOT executed", valid parameter list | Retry correctly |

### Empty results are closed-world statements

An empty search result on its own is only a local negative: it proves one search string
matched nothing, not that the thing does not exist. Left there, a model reasonably
tries another synonym, then another. Measured live against this server, proving "no EV
charger exists" took 13 to 17 tool calls of car/charger/EV/wallbox searches before this
was fixed. The fix is to make every zero-result payload a closed-world statement: it
includes the complete inventory of what does exist in the searched scope, plus an
explicit stop rule ("if it is not in this list, it does not exist; do not try more
search words; tell the user, or ask for the exact name"). Measured effect: dead-end
declines dropped to 2 to 8 calls, with honesty preserved.

Two guard rails come with it, both prompted by observed model behavior. First, a listed
candidate reads as permission: the inventory that proves "no heater in this room" also
surfaces heaters in other rooms, and models will substitute one silently, so the stop
rule carries an anti-substitution clause. Second, data-rich dead ends invite
fabrication: when a query's premise is wrong but the tool still returns rich adjacent
data, models answer anyway, so zero-match session queries enumerate the states that
were observed, making the honest answer easier to produce than the fabricated one.

### Startup behavior

At startup the server fetches the HA config (timezone, location name) and the statistic
id list for the discovery cache, and it starts regardless of whether this succeeds. The
HA instance may be temporarily unreachable or the token may need updating; tool calls
should fail with clear messages rather than the whole process being dead. Startup
status is logged to stderr (stdout stays clean for stdio JSON-RPC), and if the initial
fetch fails the entity resolver falls back to live lookups on the first tool call.

There is deliberately no `check_connection` MCP tool: it would consume a tool slot and
a reasoning step that serves the developer, not the user, and `list_entities` already
acts as a connection test in practice. Operational monitoring uses the HTTP `/health`
endpoint instead, which returns only `{ status, uptime_s }` and identifies nothing.

## Technology

TypeScript on Node.js, with `@modelcontextprotocol/sdk` for the protocol, stdio as the
default transport and Express serving the opt-in Streamable HTTP mode. Two runtime
libraries do the numeric and calendar work: `simple-statistics` (mean, stddev,
quantiles, regression) and `date-fns` with `date-fns-tz` (period parsing, timezone
handling).

Python with pandas was considered and rejected. Its advantage is vectorized operations
over millions of rows; this server's data is HA's pre-aggregated hourly statistics,
where a typical query is 720 rows (one month) and a worst case is about 8,760 (one
year). Every computation in scope is basic array work, and the session detector and
streak analysis are 30 to 50 lines each written directly.

## Evaluation

The server is evaluated by driving real conversations through small local models
(Gemma, Llama 8B class, via LM Studio or Ollama) with
[mcpscope](https://github.com/ffleurey/mcpscope), against prompts of the kind listed in
the question tables above ("How many times was the car charged in February?", "Is that
more than usual?", "What was the warmest day last summer?"). The bar the server is held
to: a small model answers correctly without performing arithmetic on raw data, typical
tool payloads stay under 500 tokens, one benchmark prompt needs one analytics call, and
a cross-period comparison returns one compact diff rather than two data dumps. The
design guidance this follows is written up in
[mcpscope-chat-template](https://github.com/ffleurey/mcpscope-chat-template)
(`docs/MCP-DESIGN.md`).
