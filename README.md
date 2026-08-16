# ha-analytics-mcp

Historical data analytics for Home Assistant: statistics, trends and session detection
computed server-side, sized for small local models.

This is a read-only [MCP](https://modelcontextprotocol.io) server that answers questions
about your own home's recorded sensor history: how much energy the car charger used last
month, which room is coldest at 6am, how many times the washing machine ran last week.
No tool in it can turn anything on, change a setting or write to Home Assistant.
It is unrelated to `analytics.home-assistant.io`, Home Assistant's opt-in
installation-statistics service; this server only reads your own instance's recorder
database.

## What it looks like in use

> **"How many times did I charge the car in February, and is that more than usual?"**
>
> The server resolves "February" to the last complete February in local time, reads
> hourly statistics for the charger's power sensor, groups readings above a threshold
> into sessions (bridging short dropouts), then runs the same detection over the
> reference period. One tool call returns the session count, total duration, the session
> list and the delta versus last year.

> **"Which rooms were coldest last week, and by how much?"**
>
> One call with four temperature entity_ids and `aggregations: ["mean","min","max"]`
> returns a single four-row comparison table. The model does not fetch four series and
> compare them; it reads a table that is already sorted, aligned and unit-checked.

> **"Did we use more electricity this month than last month?"**
>
> The server reads the meter's cumulative statistic, computes end minus start for both
> periods, resolves the reference dates itself and returns both totals plus the absolute
> and percentage delta. The model never sees a meter reading and never subtracts dates.

## Why this server exists

Home Assistant's built-in MCP integration exposes live entity states and service calls,
but no recorder history and no long-term statistics. The established community servers
are built around device control and configuration, and the ones that do expose history
return raw records for the model to interpret. Handing a model a JSON array of 8,760
hourly readings and asking for the average costs tens of thousands of tokens, and the
arithmetic still comes back wrong often enough to be useless.

This server keeps the data out of the model entirely. It resolves the period, picks the
right recorder API, fetches the minimum rows, does the arithmetic itself and returns a
compact table holding the answer. In our test sessions, typical responses stay in the
low hundreds of tokens regardless of how much history was scanned.

## Get started

You need a Home Assistant **long-lived access token**: open your HA profile page
(`/profile`), scroll to *Long-Lived Access Tokens*, click *Create Token* and copy it
(it is shown only once). A dedicated HA user account keeps the audit trail clean.

### npx (Claude Desktop, Claude Code, any stdio MCP client)

```bash
claude mcp add ha-analytics \
  -e HA_URL=https://homeassistant.local:8123 \
  -e HA_TOKEN=<your-long-lived-token> \
  -- npx -y ha-analytics-mcp
```

Or as client configuration JSON:

```json
{
  "mcpServers": {
    "ha-analytics": {
      "command": "npx",
      "args": ["-y", "ha-analytics-mcp"],
      "env": {
        "HA_URL": "https://homeassistant.local:8123",
        "HA_TOKEN": "<your-long-lived-token>"
      }
    }
  }
}
```

Requires Node.js 22 or newer. With no arguments the server speaks stdio, which is what
MCP clients launch.

### Docker

```json
{
  "mcpServers": {
    "ha-analytics": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "HA_URL", "-e", "HA_TOKEN",
        "ghcr.io/ffleurey/ha-analytics-mcp"
      ],
      "env": {
        "HA_URL": "https://homeassistant.local:8123",
        "HA_TOKEN": "<your-long-lived-token>"
      }
    }
  }
}
```

`-i` is required: the container talks MCP over stdin/stdout.

### HTTP mode (LAN, or several clients against one instance)

```bash
docker run --rm -p 3000:3000 \
  -e HA_URL=https://homeassistant.local:8123 \
  -e HA_TOKEN=<your-long-lived-token> \
  -e HOST=0.0.0.0 \
  -e MCP_HTTP_TOKEN=$(openssl rand -hex 32) \
  ghcr.io/ffleurey/ha-analytics-mcp --http
```

The MCP endpoint is `POST /mcp` (Streamable HTTP); `/health` reports liveness without
revealing your instance. The security contract is enforced at startup, not documented as
advice:

- The default bind address is `127.0.0.1`, reachable only from the machine running the
  server.
- Binding anywhere else (`HOST=0.0.0.0`, a LAN address) requires `MCP_HTTP_TOKEN`. The
  server refuses to start otherwise, with a message explaining why.
- When `MCP_HTTP_TOKEN` is set, every `/mcp` request must carry
  `Authorization: Bearer <token>`, or the token as a `?token=<token>` query parameter
  for clients that cannot set a custom header (such as Home Assistant's built-in MCP
  integration, see below). Comparison is constant-time either way.

One server process talks to exactly one Home Assistant instance. For two homes, register
two MCP servers with different names: the client routes by name, and no tool needs a
"which home" argument.

A Home Assistant add-on with zero-token setup (the Supervisor provides credentials, so
there is no long-lived token to create or paste) is the next planned packaging step.

## Use with Home Assistant Assist

Home Assistant's built-in stack, the `Model Context Protocol` integration plus a
conversation agent, can talk to this server directly, without any extra chat UI. This
path needs nothing beyond HA itself and a local or remote LLM connection. It works, with
a few rough edges listed at the end of this section.

1. **Deploy the server in HTTP mode** (see above) somewhere reachable from your Home
   Assistant instance, with `MCP_HTTP_TOKEN` set.
2. **Settings → Devices & services → Add Integration → "Model Context Protocol"**, and
   enter the server URL with the token as a query parameter, e.g.
   `http://<server-host>:3000/mcp?token=<your-MCP_HTTP_TOKEN>`. HA's MCP client has no
   token field, so the query parameter is the only way to authenticate. Requires Home
   Assistant 2026.2 or later for Streamable HTTP support; older versions only speak the
   deprecated SSE transport, which this server does not implement. Home Assistant logs
   full request URLs (including the token) at `INFO` level, so use a dedicated,
   low-privilege token for this integration rather than reusing one from another client.
3. **Add a conversation agent** that supports tool calling. With the **Ollama**
   integration, raise `num_ctx` to at least 16k: this server's tool definitions alone
   are about 4.2k tokens, and Ollama's default `num_ctx` (8192) leaves too little room
   for the conversation once they are loaded. The **llama.cpp** integration pointed at
   an OpenAI-compatible endpoint (LM Studio, for example `http://<lan-ip>:1234/v1`)
   works as well.
4. **In the agent's options, enable this server's MCP API.** Enable Assist's own API too
   if you want device control from the same agent; tool names get a namespace prefix
   when both are selected.
5. **Paste the agent instructions below into the agent's prompt field.** Home
   Assistant's MCP client discards this server's own instructions (it never reads
   them), so without this step the model gets no guidance on entity discovery, tool
   choice or time formats.
6. **Settings → Voice assistants → Add assistant**, and create a pipeline using that
   conversation agent.
7. Chat in Assist.

**Agent instructions**, to paste verbatim into the conversation agent's prompt field:

```
You are a data analyst for this Home Assistant instance's history and statistics.
Answer from tool results only. State the sensor, period, and aggregation. Keep answers short and factual.
Never guess entity_ids — resolve them first with ha_history_list_entities, preferring areas/device/device_classes filters over free-text search.
For multi-area climate comparisons, one call with areas=[...] and device_classes=["temperature","humidity"] usually finds what you need.
For people or phone location history, use ha_history_list_entities with domains=["person"], domains=["device_tracker"], or both in one call.
Use ha_history_list_devices only when the device or area is still unclear, ha_history_list_device_entities only for one-device inspection, and ha_history_list_areas only when the exact area name is unknown.
If discovery returns weak or ambiguous matches, retry with a tighter filter before asking the user.
If a discovery call returns no matches, read the inventory included in its response: when the thing you look for is not listed there, it does not exist — report that to the user instead of retrying other search words.
Tool choice: ha_history_get_sensor_stats for instantaneous measurements, ha_history_get_consumption for cumulative meters, ha_history_detect_sessions for threshold-based activity, ha_history_get_state_history for discrete-state timelines, ha_history_get_state for current state.
Time formats: relative ("7d", "30d", "24h"), named ("last month", "yesterday", "Q1"), or ISO date. Default period: last 30 days.
If GetLiveContext and device-control (Hass*) tools are also available: prefer GetLiveContext for current values of exposed entities, use the ha_history_* tools for history, statistics, and entities GetLiveContext cannot see, and pass plain names and areas (never entity_ids) to the control tools.
Tool results may contain fenced (triple-backtick) code blocks holding compact tables — keep them fenced verbatim in your answer instead of reflowing them into prose.
```

Known limitations of this path, all on Home Assistant's side rather than this server's:
tool calls have a 10-second timeout, hardcoded by HA's MCP client (very wide analytics
queries can hit it; narrow the period if that happens). Assist's chat history expires
after 5 minutes of inactivity. The agent instructions must be pasted manually every
time you create or edit the agent, because Home Assistant has no mechanism to fetch
them from the server.

## Tools

Ten tools, all read-only. The discovery tools narrow a room or appliance concept down
to exact `entity_id`s; the analytics tools then take those ids and return computed
answers.

| Tool | What it does |
|---|---|
| `ha_history_list_areas` | Lists areas (rooms and locations) defined in the instance. |
| `ha_history_list_devices` | Lists devices, filtered by area or name, with analytics-ready entity_ids. |
| `ha_history_list_device_entities` | Lists one device's entities with metric kind and analytics capability. |
| `ha_history_list_entities` | Primary entity search: filter by domains, areas, device, device_classes, free text. |
| `ha_history_get_state` | Current state, unit, timestamps and key attributes of one entity. |
| `ha_history_get_current_time` | The instance's current date, time and UTC offset; anchors relative periods. |
| `ha_history_get_sensor_stats` | Statistics over instantaneous sensors: mean/min/max/median/count, multi-entity comparison, `interval` time series, `group_by` hour-of-day or day-of-week, threshold filters. |
| `ha_history_get_consumption` | Consumption or production of cumulative meters (energy, water, gas): period totals, day/week/month breakdowns, previous-period or same-period-last-year comparison. |
| `ha_history_detect_sessions` | Threshold-based activity sessions from a numeric sensor: count, durations, peaks, gap bridging, per-day summary, period comparison. |
| `ha_history_get_state_history` | Discrete-state history: transition timelines, or time-in-state sessions for binary sensors, `person`/`device_tracker`, thermostat modes. |

Every time parameter accepts what the user actually said: `"7d"`, `"last month"`,
`"february"`, `"last winter"`, `"Q1"` or an ISO date. The server resolves it in the
instance's timezone and echoes the resolved bounds back. Full parameter reference:
[TOOLS.md](TOOLS.md).

## Designed for small models

The constraint this server is built against is an 8B model with an 8k context window,
not a frontier model with a million. That constraint shapes the design rather than the
tuning. Tool payloads are compact plain-text tables with a header stating sensor, period,
aggregation and unit: cheaper to tokenize than nested JSON, and in our test sessions
small models read values back out of them more accurately. All arithmetic happens in the
server (date math, unit handling, deltas, percentages, session boundaries), because
every reasoning step removed from the model is a step that cannot go wrong.

Errors teach recovery instead of reporting failure. Each error is a sentence saying what
happened, why and what to do next, so the model corrects itself instead of hallucinating
a plausible number. Empty discovery results include the complete inventory of what does
exist plus an explicit stop rule, so asking about equipment your home does not have gets
"that isn't monitored" within two or three tool calls instead of minutes of
synonym-guessing before the same answer.

The design follows the MCP-server recommendations in
[mcpscope-chat-template](https://github.com/ffleurey/mcpscope-chat-template)
(`docs/MCP-DESIGN.md`), and the server is developed and evaluated against local models
with [mcpscope](https://github.com/ffleurey/mcpscope), a workbench for benchmarking MCP
servers against local (LM Studio, Ollama) or remote models with per-tool reliability and
token-cost scoring. [DESIGN.md](DESIGN.md) records the design decisions in detail.

## How it compares

Home Assistant's built-in
[`mcp_server`](https://www.home-assistant.io/integrations/mcp_server/) integration gives
a model live state and service calls, with no access to the recorder's history or
long-term statistics. The large community servers, led by
[homeassistant-ai/ha-mcp](https://github.com/homeassistant-ai/ha-mcp), are broad
control-and-configuration surfaces, and the ones that expose history return raw records
for the model to interpret. This server goes the other way: a small, read-only,
single-purpose surface where every tool returns a computed answer rather than the data
behind it, and nothing can change the state of your home.

It is meant to sit alongside a control server, not to replace one. If what you need is
device control, automation management or a general-purpose assistant, one of the servers
above will serve you better; [COMPARISON.md](COMPARISON.md) maps the whole landscape,
with links, so you can pick what fits.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `HA_URL` | yes | (none) | Base URL of your instance, e.g. `https://homeassistant.local:8123`. |
| `HA_TOKEN` | yes | (none) | Home Assistant long-lived access token. |
| `HA_NAME` | no | `Home` | Display name used in tool descriptions and responses. |
| `HA_TIMEZONE` | no | from HA | Overrides the timezone reported by Home Assistant. |
| `HA_INSECURE_TLS` | no | `0` | Set to `1` to accept self-signed certificates. Certificates are verified by default. |
| `HOST` | no | `127.0.0.1` | HTTP mode only. Non-loopback values require `MCP_HTTP_TOKEN`. |
| `PORT` | no | `3000` | HTTP mode only. |
| `MCP_HTTP_TOKEN` | no | unset | HTTP mode only. Bearer token required on every `/mcp` request when set. |
| `MAX_RESULTS` | no | `100` | Default row cap for time-series responses. |
| `CACHE_MAX_ENTRIES` | no | `500` | In-memory cache size (LRU eviction). |

See [.env.example](.env.example) for the same list in file form.

## Security

The server is read-only: it exposes no tool that calls a Home Assistant service, writes
state or modifies configuration. The HA token is still a full-access token, so treat it
accordingly: use a dedicated account and keep it in the environment, never in a
committed file. TLS is verified by default; `HA_INSECURE_TLS=1` exists for local
instances with a private CA and should be a last resort, since the token travels in
every request header. HTTP mode defaults to loopback and refuses to bind elsewhere
without a bearer token, and the `/health` endpoint returns only status and uptime.
Historical statistics are cached in memory only and cleared when the process exits.

## Documentation

- [TOOLS.md](TOOLS.md): full tool surface: parameters, period formats, discovery flows, example outputs
- [DESIGN.md](DESIGN.md): design rationale: server-side computation, caching, error handling, API strategy
- [COMPARISON.md](COMPARISON.md): how this server relates to the other Home Assistant MCP servers
- [CACHE.md](CACHE.md): current cache behavior, its limits near "now" and the planned redesign
- [CONTRIBUTING.md](CONTRIBUTING.md): development workflow: lint, tests, smoke-testing

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it
describes the change workflow the project expects. If you are proposing a new tool, say
which question a small model should be able to answer with it in one call.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
