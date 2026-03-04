
# Helm — Semantic Browser Automation MCP Server

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.

## Project Structure

- `src/server.ts` — MCP server entrypoint (stdio transport)
- `src/tools/` — Tool definitions (navigation, observation, interaction, composite, session)
- `src/core/` — Internal modules (browser, resolver, observer, som, memory, recovery)
- `src/types.ts` — Shared type definitions
- `tests/` — Unit and e2e tests using `bun test` + Playwright

## Running

```sh
bun run src/server.ts        # Start MCP server (stdio)
bun test                     # Run tests
bunx tsc --noEmit            # Typecheck
```

## MCP Config

```json
{
  "mcpServers": {
    "helm": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/path/to/src/server.ts"]
    }
  }
}
```

## Key Design Decisions

- Tools are semantic (click by label, not selector). The resolver handles label→element mapping.
- `observe(task)` returns filtered elements, not full a11y tree. Keeps token cost low.
- Set-of-Mark (SoM) fallback: `screenshot_som()` + `click_mark(id)` for sites with poor ARIA.
- Site memory: SQLite in `data/memory.sqlite`, keyed by domain. Records successful actions.
- Error recovery: auto-retry with backoff, auto-dismiss cookie/modal overlays.
- Zod schemas define tool inputs. MCP SDK wires them to JSON-RPC.
