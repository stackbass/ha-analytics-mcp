# How ha-analytics-mcp compares

*Surveyed August 2026. The Home Assistant MCP ecosystem moves quickly: star counts,
transports and install paths below were verified at that date and will drift. If
something here is out of date or wrong about your project, please open an issue. The
intent is an accurate map, not a scoreboard.*

Several of these projects are considerably larger and older than this one, and they
solve a problem this server deliberately does not touch: letting a model operate a home.
The comparison below is about fit, not ranking.

## The landscape

| Project | Focus | History & statistics | Where it runs | Install | Notes |
|---|---|---|---|---|---|
| [`mcp_server`](https://www.home-assistant.io/integrations/mcp_server/) (Home Assistant core) | Live context for a model, plus service calls | None. Exposes a live entity snapshot (`GetLiveContext`); no recorder history or long-term statistics | In-process inside Home Assistant | Built-in integration | Streamable HTTP at `/api/mcp` (2025.11+), legacy SSE. A [discussion requesting history access](https://github.com/orgs/home-assistant/discussions/2068) has been open since December 2025 |
| [homeassistant-ai/ha-mcp](https://github.com/homeassistant-ai/ha-mcp) (Python, ~4.4k★) | Broad control and configuration; the largest server in the space | The only other server offering raw history and statistics access | Five modes: HACS in-process, add-on, Docker, `uvx` HTTP, client-launched stdio | HACS in-process component (recommended) | Streamable HTTP by default; stdio not recommended; SSE removed. Auth is automatic in-process or via Supervisor token, LLAT otherwise |
| [voska/hass-mcp](https://github.com/voska/hass-mcp) (Python, ~316★) | General Home Assistant server | Not a focus | Client-launched (Docker/`uvx`) or standalone HTTP | Docker over stdio | stdio by default, `--http` available. Uses `HA_URL`/`HA_TOKEN`, the same convention as this server |
| [tevonsb/homeassistant-mcp](https://github.com/tevonsb/homeassistant-mcp) (TypeScript, ~575★) | General Home Assistant server | Not a focus | Client-launched stdio, or self-built Docker | Client stdio | stdio only. Last updated February 2025 |
| [jango-blockchained/advanced-homeassistant-mcp](https://github.com/jango-blockchained/advanced-homeassistant-mcp) (TypeScript/Bun, ~55★) | General Home Assistant server | Not a focus | Client (`bunx`), Docker, Smithery | `bunx` or Smithery | Widest transport coverage: stdio, Streamable HTTP and SSE |
| [robbrad/homeassistant-mcp](https://github.com/robbrad/homeassistant-mcp) (Python, ~102★) | General Home Assistant server | Not a focus | Client machine only | `uvx` | stdio only |
| [ganhammar/hass-mcp-server](https://github.com/ganhammar/hass-mcp-server) (Python, ~63★) | General Home Assistant server | Not a focus | In-process inside Home Assistant | HACS (default index) | Streamable HTTP only at `/api/mcp`; OAuth with dynamic client registration by default |
| [paulomac1000/ha-mcp-readonly](https://github.com/paulomac1000/ha-mcp-readonly) (Python, ~42★) | Read-only access, the closest neighbour in posture | Not a focus | Standalone Docker or client stdio | Docker Compose | stdio and Streamable HTTP, SSE removed in v2. Requires `MCP_AUTH_TOKEN` whenever the server is networked, the same rule this server enforces |
| **ha-analytics-mcp** (TypeScript) | Historical analytics, read-only | Derived analytics computed server-side: statistics, consumption, sessions, comparisons | Client-launched stdio or standalone HTTP (Docker) | npx or Docker; Home Assistant add-on planned | stdio by default, `--http` with mandatory bearer token off loopback |

Also relevant for context:
[allenporter/mcp-server-home-assistant](https://github.com/allenporter/mcp-server-home-assistant)
(~68★) is archived; its work was upstreamed into Home Assistant core as the built-in
`mcp_server` integration.

The "history & statistics" column reflects a verified finding: of the servers above,
only ha-mcp competes on raw history and statistics access, and none of them provides
*derived* analytics such as session detection, period-over-period comparison or
multi-entity comparison tables.

## What this server computes that others do not

The distinction is not "has a history tool" versus "does not". It is whether the server
returns records for the model to interpret, or an answer the model can relay. Everything
below is computed inside the server and returned as a compact table:

- **Session detection with gap bridging.** Turns a numeric power or flow sensor into
  discrete activity sessions above a threshold, with a minimum-duration filter to drop
  noise and a configurable tolerance that bridges short dropouts instead of splitting
  one charge into three. Returns count, total duration and per-session
  start/end/duration/peak, optionally summarised per day.
- **Multi-aggregation statistics in one call.** Mean, min, max and median for the whole
  period as a single scalar table, rather than four calls or four series.
- **Multi-entity comparison tables.** Several entities sharing a unit compared in one
  aligned table, whole-period or bucketed per day. The alternative pattern (one call per
  room, model compares the results) is exactly where small models produce confident,
  wrong answers.
- **Hour-of-day and day-of-week grouping.** Pattern analysis across a period without
  shipping the period.
- **Period-over-period consumption comparison.** `previous_period` and
  `same_period_last_year` resolve their own reference dates and return both totals plus
  absolute and percentage delta. Cumulative meters are always reported as consumption
  deltas, never as raw meter readings.
- **Timezone-aware natural periods.** `"last month"`, `"february"`, `"last winter"`,
  `"Q1"`, `"overnight"`, `"7d"` and ISO dates all resolve in the Home Assistant
  instance's timezone, with the resolved bounds echoed back in the response so the model
  can verify what it asked for.
- **Discrete-state analytics.** Time-in-state and transition timelines for binary
  sensors, `person`/`device_tracker` zone history and thermostat-style named-state
  entities.

## What this server deliberately does not do

It has no write path at all. There is no tool that calls a service, and therefore no
device control (nothing is turned on, off, dimmed, locked or set), no automation, script
or scene management, no dashboard or system configuration, and no write access of any
kind.

These are real needs, and other projects serve them well.
[homeassistant-ai/ha-mcp](https://github.com/homeassistant-ai/ha-mcp) is the most
complete option for control and configuration; Home Assistant's built-in `mcp_server`
integration is the zero-install choice for live state and service calls. Running one of
those alongside this server is the intended configuration: the two surfaces do not
overlap, and an MCP client routes by server name.

## Differences in approach

Most servers in this space are general-purpose: one server covering control,
configuration, diagnostics and discovery, with a tool surface running into the dozens
(the largest exposes 88 tools at the time of this survey). That is a reasonable design
when the client is a large model with a large context window, because more tools mean
fewer round trips. It is a poor design when the client is an 8B model with an 8k window,
where the tool list alone can consume a meaningful share of the context before the first
question is read. This server takes the opposite bet: ten read-only tools, one job, and
a fixed context budget the tool surface is designed to fit inside.

The second difference is where the work happens. Wrapping an API and returning its
response is the obvious way to build an MCP server, and it is what most history-capable
servers do: the model receives records and is expected to aggregate them. That pushes
arithmetic, date resolution and unit handling onto the component least equipped to do
them reliably. Here the server resolves the period, selects between long-term statistics
and raw state history, fetches the minimum rows, computes the result and returns the
result only.

The third is payload format. Responses are compact plain-text tables with a short header
naming the sensor, period, aggregation and unit, not nested JSON. Text costs fewer
tokens to represent the same table and, in our test sessions, small models read values
back out of it more accurately.

Finally, the gap this fills is structural rather than competitive. Home Assistant's own
MCP integration exposes no recorder history or statistics, and the request for it has
been open since December 2025. Years of recorded sensor history are the most data-rich
part of a Home Assistant installation, and this server's only job is to make them
reachable for a model in a form it can reason over.
