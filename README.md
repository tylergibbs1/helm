# Helm

Semantic browser automation MCP server. Tell it what to do in plain English — it figures out the selectors.

Helm gives AI agents a full browser through 24 tools: navigate pages, fill forms, click buttons, extract structured data, capture network traffic, and profile performance. No CSS selectors or XPaths required.

## Quick Start

```bash
bun install
bun run src/server.ts
```

### Connect to Claude Code

```bash
claude mcp add --transport stdio helm -- bun run /path/to/helm/src/server.ts
```

### Connect to Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "helm": {
      "command": "bun",
      "args": ["run", "/path/to/helm/src/server.ts"]
    }
  }
}
```

### Connect to any MCP client

Helm uses stdio transport. Point your client at:

```
command: bun
args: ["run", "/path/to/helm/src/server.ts"]
```

## Tools

### Navigation

| Tool | Description |
|------|-------------|
| `nav_goto` | Navigate to a URL and wait for the page to be ready |
| `nav_back` | Navigate back in browser history |
| `nav_forward` | Navigate forward in browser history |
| `nav_reload` | Reload the current page |

### Observation

| Tool | Description |
|------|-------------|
| `obs_observe` | Get a filtered, task-relevant snapshot of interactive elements on the page |
| `obs_screenshot` | Take a screenshot, optionally with numbered Set-of-Mark overlays |
| `obs_extract` | Extract a specific piece of information by natural language description |

### Interaction

| Tool | Description |
|------|-------------|
| `act_click` | Click an element by its visible label or Set-of-Mark ID |
| `act_fill` | Fill a single input field by its label |
| `act_fill_form` | Fill multiple form fields at once |
| `act_select` | Select a dropdown option by the dropdown's label and option text |
| `act_press` | Press a keyboard key or shortcut |

### Composite

| Tool | Description |
|------|-------------|
| `act_login` | Complete a full login flow in one call |
| `act_submit_form` | Find and click the primary submit button |
| `page_wait_for` | Wait until a condition is true on the page |

### Session

| Tool | Description |
|------|-------------|
| `page_new_tab` | Open a new browser tab |
| `page_close_tab` | Close a browser tab |
| `page_switch_tab` | Switch to a different tab by ID |
| `page_get_cookies` | Get cookies for the current page or domain |
| `page_set_cookie` | Set a cookie for a domain |

### Data

| Tool | Description |
|------|-------------|
| `data_query` | Run a SQL-like query against the page DOM |
| `data_analyze_page` | Auto-detect repeating data patterns and infer a schema |
| `data_extract` | Extract structured data matching a caller-defined schema |

### DevTools (CDP)

| Tool | Description |
|------|-------------|
| `cdp_evaluate` | Evaluate JavaScript via Chrome DevTools Protocol |
| `cdp_performance` | Snapshot browser performance metrics (DOM nodes, heap, layout count) |
| `cdp_network_start` | Start capturing network requests |
| `cdp_network_stop` | Stop capture and return requests with optional URL filter |

## Examples

**Navigate and extract structured data:**

```
Navigate to https://books.toscrape.com and extract the book titles, prices,
and availability from the listing page.
```

Helm auto-detects the repeating pattern, maps your requested fields to DOM elements, and returns typed data (prices as floats, not strings).

**Document a website for scraper development:**

```
Navigate to the court case search page. Dump all forms and their fields.
Search for "Smith", capture network traffic during the search, then extract
the results into a structured table. Write the full spec to a markdown file.
```

**Profile a web app:**

```
Start network capture, navigate to localhost:3000, log in, then stop capture.
Show me all API calls made during login. Also grab performance metrics —
I want to know DOM node count and JS heap usage.
```

**Fill forms by label, not selector:**

```
Fill the form: {"Email": "test@example.com", "Password": "secret123"}
and click "Sign In".
```

## Architecture

```
src/
  server.ts              MCP server entrypoint (stdio)
  types.ts               Shared type definitions
  core/
    browser.ts           Playwright browser/tab management
    resolver.ts          Label -> element resolution (role, text, fuzzy, memory)
    observer.ts          Page observation and element filtering
    som.ts               Set-of-Mark screenshot annotation
    memory.ts            SQLite site memory (bun:sqlite)
    fingerprint.ts       DOM fingerprinting for stale selector detection
    recovery.ts          Auto-retry with backoff, overlay dismissal
    schemasniff.ts       Automatic DOM pattern detection
    extractor.ts         Structured data extraction engine
    domql.ts             SQL-like DOM query engine
    cdp.ts               Chrome DevTools Protocol wrapper
  tools/
    navigation.ts        nav_goto, nav_back, nav_forward, nav_reload
    observation.ts       obs_observe, obs_screenshot, obs_extract
    interaction.ts       act_click, act_fill, act_fill_form, act_select, act_press
    composite.ts         act_login, act_submit_form, page_wait_for
    session.ts           page_new_tab, page_close_tab, page_switch_tab, cookies
    data.ts              data_query, data_analyze_page, data_extract
    devtools.ts          cdp_evaluate, cdp_performance, cdp_network_start/stop
```

### Key design decisions

- **Semantic resolution.** Tools take human-readable labels ("Sign In", "Email"), not CSS selectors. The resolver tries `getByRole`, `getByLabel`, `getByText`, fuzzy matching, and site memory — in parallel.
- **Site memory.** Successful actions are recorded in SQLite keyed by domain. On revisit, known selectors are tried first. DOM fingerprinting detects when cached selectors are stale.
- **DOM fingerprinting.** Each resolved element gets a hash of its tag, role, text, attributes, parent, and siblings. If the hash changes, the cached selector is discarded and re-resolved.
- **Set-of-Mark fallback.** For sites with poor ARIA, `obs_screenshot(overlay=true)` annotates every interactive element with a number. Then `act_click(mark_id=7)` clicks element 7 by coordinates.
- **Structured extraction.** `data_extract` takes a field schema (name, description, type), auto-detects repeating containers via `sniffPage`, maps fields by token overlap + type compatibility, and returns typed data.
- **CDP layer.** Direct Chrome DevTools Protocol access for network capture, performance profiling, and raw JS eval — things that are awkward through Playwright's abstraction.
- **Error recovery.** Automatic retry with exponential backoff. Cookie banners and modal overlays are dismissed between retries.
- **Token efficiency.** `obs_observe` returns only task-relevant elements, not the full accessibility tree. Extraction results are capped at 15KB.

## Helm vs Playwright MCP

[Playwright MCP](https://github.com/microsoft/playwright-mcp) is Microsoft's official MCP server for Playwright. Both give AI agents a browser — here's why they exist and when to pick each.

### Philosophy

**Playwright MCP** exposes Playwright's API almost directly. Tools like `browser_click(selector)` and `browser_type(selector, text)` require the caller to figure out the right CSS selector or `ref` attribute. It's a thin wrapper — powerful if you already know the page structure.

**Helm** is semantic-first. You say `act_click("Sign In")` or `act_fill("Email", "test@example.com")` and the resolver figures out the selector through role matching, label association, text search, fuzzy matching, and site memory. The agent never needs to inspect the DOM.

### Feature comparison

| Capability | Helm | Playwright MCP |
|------------|------|----------------|
| **Element targeting** | By visible label, auto-resolved | By CSS selector or `ref` attribute |
| **Structured extraction** | `data_extract` with field schema + auto-detection | Manual — read page, write selectors yourself |
| **DOM query language** | SQL-like `data_query` against the page | Not included |
| **Pattern detection** | `data_analyze_page` finds repeating structures | Not included |
| **Site memory** | SQLite — remembers working selectors per domain | None |
| **DOM fingerprinting** | Detects stale cached selectors automatically | N/A |
| **CDP access** | `cdp_evaluate`, `cdp_performance`, network capture | Not exposed |
| **Set-of-Mark** | Screenshot overlay with numbered elements | Snapshot with `ref` attributes |
| **Error recovery** | Auto-retry, cookie/modal dismissal between retries | Basic error messages |
| **Login flows** | `act_login` handles navigate + fill + submit + wait | Manual multi-step |
| **Screenshot** | PNG with optional SoM overlay | PNG |
| **Multi-tab** | Yes — open, close, switch tabs | Yes |
| **Headless** | No — runs headed for visual debugging | Headless by default |
| **Browser engine** | Chromium (via Playwright) | Chromium (via Playwright) |

### When to use Playwright MCP

- You want a minimal, official tool with stable API surface
- Your agent is good at constructing CSS selectors from page snapshots
- You need headless operation in CI/CD
- You're already building on Playwright and want consistent abstractions

### When to use Helm

- Your agent should describe *what* to interact with, not *how* to find it
- You're extracting structured data from pages (products, listings, records, tables)
- You need network capture or performance profiling alongside automation
- You want the server to learn from past visits and get faster over time
- You're building scrapers and need the site documented automatically

### Can I use both?

Yes. They're independent MCP servers. Some teams use Playwright MCP for simple navigation and Helm for extraction and form-heavy workflows.

## Development

```bash
bun test                 # Run tests
bunx tsc --noEmit        # Typecheck
bun run --watch src/server.ts  # Dev mode with auto-reload
```

## License

[MIT](LICENSE)
