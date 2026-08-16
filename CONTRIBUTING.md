# Contributing

This document describes the workflow for making changes to the server. The goal is to
keep the project in a consistently working state and to catch regressions before they
reach users.

## Prerequisites

- Node.js 22 or newer
- A Home Assistant instance to test against, with a long-lived access token
- `git clone`, then `npm install`

Copy `.env.example` to `.env` and fill in `HA_URL` and `HA_TOKEN`. `.env` is gitignored
and must never be committed.

## Change workflow

Every change, however small, follows these steps.

1. **Make the change.** Edit source files in `src/`. Keep changes focused: one logical
   thing per commit.

2. **Lint.**
   ```bash
   npm run lint
   ```
   Fix errors before continuing.

3. **Run the tests.**
   ```bash
   npm test
   ```
   All tests must pass. If a test is wrong (a wrong expected value, for example), fix
   the test and say why in the commit message. If the production code is wrong, fix the
   code and keep the test.

4. **Smoke-test against a live instance.**
   ```bash
   npm run dev
   ```
   This starts the server in HTTP mode. Verify that the log shows
   `Entity list cached: N entities with statistics` and that
   `http://127.0.0.1:3000/health` returns `"status":"ok"`. For stdio-mode testing (the
   mode MCP clients launch), use `npm start` instead.

   This step is required when a tool handler changed, when config or imports changed,
   or for any change to `src/index.ts`, `src/config.ts`, `src/ha-client.ts` or
   `src/cache.ts`. Skip it only for changes confined to pure utility functions already
   covered by tests.

5. **Commit** with a message in the format below.

## Commit message format

```
<type>: <short summary (50 chars max)>

<optional body: what and why, not how>
```

| Type | When to use |
|---|---|
| `feat` | New tool, new parameter, new capability |
| `fix` | Bug fix |
| `refactor` | Restructuring without behavior change |
| `test` | Adding or fixing tests |
| `docs` | Documentation only |
| `chore` | Config, deps, tooling |

## Test philosophy

Tests cover logic that has caused or could cause silent regressions: period parsing and
timezone handling (`period-resolver.ts`), filter operators, rounding and timestamp
formatting (`tool-utils.ts`), and the tool handlers' output formats (via mocked Home
Assistant responses).

Tests do not cover boilerplate (schema definitions, HTTP routing, WebSocket protocol) or
anything that would need an elaborate mock framework to test trivially. When manual
testing reveals a bug, add a regression test for it before merging the fix.

```bash
npm run test:coverage   # see which lines are covered
npm run test:watch      # re-run on file save during development
```

## Testing with a local model

The intended clients of this server are small local models, and that is where
tool-selection and payload-design bugs surface. The project uses
[mcpscope](https://github.com/ffleurey/mcpscope) for this: it drives conversations
against the server through a local (LM Studio, Ollama) or remote model and scores
per-tool reliability and token cost. Start the server with `npm run dev` and point
mcpscope at `http://127.0.0.1:3000/mcp`.

## Adding a new tool

1. Create `src/tools/my-tool.ts` exporting the tool schema object and handler function.
2. Register it in `src/index.ts`: add it to the `TOOLS` array and the `callTool()`
   switch.
3. Document it in `TOOLS.md`, and update `DESIGN.md` if the tool changes the project's
   scope.
4. Write at least one test for any pure logic extracted to helpers.
5. Follow the change workflow above.

Before proposing a new tool, state which question a small model should be able to answer
with it in one call. The tool surface is deliberately small: every added tool costs
fixed context in every session, so a new tool must earn its place.
