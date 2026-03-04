import { z } from "zod";
import { getActivePage } from "../core/browser.js";
import { observe } from "../core/observer.js";
import { annotate } from "../core/som.js";
import type { Observation } from "../types.js";

const MAX_EXTRACT_BYTES = 15_000;

export const observationTools = {
  obs_observe: {
    description:
      "Get a filtered, task-relevant snapshot of interactive elements on the current page.\n" +
      "Returns: { page, url, relevant_elements: [{ type, label, value?, options? }], notices }\n" +
      "When to use: ALWAYS call before clicking or filling. This is the primary way to discover what's on the page.\n" +
      "Pitfalls: Do NOT pass CSS selectors as the task — describe your goal in plain English. " +
      "If labels are poor or missing, fall back to `obs_screenshot(overlay=true)` + `act_click(mark_id)`.",
    schema: z.object({
      task: z
        .string()
        .describe(
          "What you're trying to accomplish on this page (e.g., 'log in', 'fill out shipping form'). " +
            "The observation is filtered based on this."
        ),
      response_format: z
        .enum(["concise", "detailed"])
        .optional()
        .default("concise")
        .describe("'concise' strips element IDs and default flags to save tokens. 'detailed' returns everything."),
    }),
    handler: async ({ task, response_format }: { task: string; response_format: "concise" | "detailed" }) => {
      const page = await getActivePage();
      const observation = await observe(page, task);

      const output = response_format === "concise"
        ? conciseObservation(observation)
        : observation;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output),
          },
        ],
      };
    },
  },

  obs_screenshot: {
    description:
      "Take a screenshot of the current page, optionally with numbered Set-of-Mark overlays on every interactive element.\n" +
      "Returns: PNG image (overlay=false) or JPEG with colored bounding boxes + mark index JSON (overlay=true).\n" +
      "When to use: For visual confirmation of page state. Set `overlay=true` when accessibility markup is poor and `obs_observe` returns unhelpful labels — then use `act_click(mark_id)` to interact by number.\n" +
      "Pitfalls: For finding clickable elements, prefer `obs_observe` first — it's faster and cheaper. Only use screenshots when you need visual context.",
    schema: z.object({
      full_page: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, capture the full scrollable page, not just the viewport"),
      overlay: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, draw numbered bounding boxes over interactive elements (Set-of-Mark). Use with act_click(mark_id)."),
    }),
    handler: async ({ full_page, overlay }: { full_page: boolean; overlay: boolean }) => {
      const page = await getActivePage();

      if (overlay) {
        const result = await annotate(page);
        return {
          content: [
            {
              type: "image" as const,
              data: result.screenshot.toString("base64"),
              mimeType: "image/jpeg",
            },
            {
              type: "text" as const,
              text: JSON.stringify({
                marks: result.marks.map((m) => ({
                  id: m.id,
                  tag: m.tag,
                  label: m.label,
                  role: m.role,
                })),
                hint: "Use act_click(mark_id) to click any numbered element",
              }),
            },
          ],
        };
      }

      const screenshot = await page.screenshot({
        type: "png",
        fullPage: full_page,
      });

      return {
        content: [
          {
            type: "image" as const,
            data: Buffer.from(screenshot).toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    },
  },

  obs_extract: {
    description:
      "Extract a specific piece of information from the current page by natural language description.\n" +
      "Returns: { type: 'table'|'errors'|'links'|'headings'|'content'|'search', data: ... }\n" +
      "When to use: For quick, keyword-driven extraction — tables, links, headings, error messages, or page text. " +
      "Just describe what you want in plain English. " +
      "For typed, schema-driven extraction (specific named fields with types like price/date/url), use `data_extract` instead. " +
      "For repeating patterns with CSS selectors, prefer `data_analyze_page` → `data_query`.\n" +
      "Pitfalls: Large tables are auto-truncated (default 50 rows). Pass `max_rows` to override.",
    schema: z.object({
      what: z
        .string()
        .describe(
          'Natural language description of what to extract (e.g., "order confirmation number", "table of prices", "error messages")'
        ),
      max_rows: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum table rows to return (default 50)"),
      response_format: z
        .enum(["concise", "detailed"])
        .optional()
        .default("concise")
        .describe("'concise' limits tables to 20 rows, links to 20, content to 1500 chars, search to 5 results. 'detailed' uses max_rows limit."),
    }),
    handler: async ({ what, max_rows, response_format }: { what: string; max_rows: number; response_format: "concise" | "detailed" }) => {
      const page = await getActivePage();
      const whatLower = what.toLowerCase();

      const effectiveMaxRows = response_format === "concise" ? Math.min(max_rows, 20) : max_rows;
      const maxCols = 20;
      const maxHeadings = 50;
      const maxErrors = 20;
      const maxLinks = response_format === "concise" ? 20 : 50;
      const maxContent = response_format === "concise" ? 1_500 : 3_000;
      const maxSearchResults = response_format === "concise" ? 5 : 10;

      let data = await page.evaluate(
        ({ query, maxRows, maxCols, maxHeadings, maxErrors, maxLinks, maxContent, maxSearchResults }: {
          query: string;
          maxRows: number;
          maxCols: number;
          maxHeadings: number;
          maxErrors: number;
          maxLinks: number;
          maxContent: number;
          maxSearchResults: number;
        }) => {
          const q = query.toLowerCase();

          // Table extraction
          if (q.includes("table")) {
            const tables = document.querySelectorAll("table");
            const results: any[] = [];
            for (const table of tables) {
              let headers = Array.from(table.querySelectorAll("th")).map(
                (th) => th.textContent?.trim() || ""
              );
              if (headers.length > maxCols) headers = headers.slice(0, maxCols);

              const rows: string[][] = [];
              let rowCount = 0;
              for (const tr of table.querySelectorAll("tbody tr, tr:not(:has(th))")) {
                if (rowCount >= maxRows) break;
                let cells = Array.from(tr.querySelectorAll("td")).map(
                  (td) => td.textContent?.trim() || ""
                );
                if (cells.length > maxCols) cells = cells.slice(0, maxCols);
                if (cells.length > 0) {
                  rows.push(cells);
                  rowCount++;
                }
              }
              const truncated = table.querySelectorAll("tbody tr, tr:not(:has(th))").length > maxRows;
              results.push({ headers, rows, ...(truncated ? { _truncated: true, _total_rows: table.querySelectorAll("tbody tr, tr:not(:has(th))").length } : {}) });
            }
            return { type: "table", data: results };
          }

          // Error/alert extraction
          if (q.includes("error") || q.includes("alert") || q.includes("warning")) {
            const selectors = [
              '[role="alert"]', '[role="status"]',
              ".error", ".alert", ".warning", ".notice",
              '[class*="error"]', '[class*="alert"]', '[class*="warning"]',
            ];
            const messages: string[] = [];
            for (const sel of selectors) {
              for (const el of document.querySelectorAll(sel)) {
                if (messages.length >= maxErrors) break;
                const text = (el as HTMLElement).innerText?.trim();
                if (text) messages.push(text);
              }
              if (messages.length >= maxErrors) break;
            }
            return { type: "errors", data: messages };
          }

          // Link extraction
          if (q.includes("link") || q.includes("url")) {
            const links = Array.from(document.querySelectorAll("a[href]"))
              .slice(0, maxLinks)
              .map((a) => ({
                text: (a as HTMLElement).innerText?.trim() || "",
                href: (a as HTMLAnchorElement).href,
              }));
            return { type: "links", data: links };
          }

          // Heading extraction
          if (q.includes("heading") || q.includes("title") || q.includes("section")) {
            const headings = Array.from(
              document.querySelectorAll("h1, h2, h3, h4, h5, h6")
            )
              .slice(0, maxHeadings)
              .map((h) => ({
                level: h.tagName,
                text: (h as HTMLElement).innerText?.trim() || "",
              }));
            return { type: "headings", data: headings };
          }

          // Main content / article extraction
          if (q.includes("article") || q.includes("content") || q.includes("text") || q.includes("body")) {
            const article =
              document.querySelector("article") ||
              document.querySelector("main") ||
              document.querySelector('[role="main"]');
            if (article) {
              return {
                type: "content",
                data: (article as HTMLElement).innerText?.trim().substring(0, maxContent),
              };
            }
          }

          // Generic: try to find text matching the query
          const body = document.body.innerText || "";
          const lines = body.split("\n").filter((l: string) => l.trim().length > 0);

          const queryWords = q.split(/\s+/).filter((w: string) => w.length > 2);
          const scored = lines.map((line: string) => {
            let score = 0;
            const lineLower = line.toLowerCase();
            for (const word of queryWords) {
              if (lineLower.includes(word)) score++;
            }
            return { line: line.trim(), score };
          });

          scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
          const topLines = scored
            .filter((s: { score: number }) => s.score > 0)
            .slice(0, maxSearchResults)
            .map((s: { line: string }) => s.line);

          return {
            type: "search",
            data: topLines.length > 0 ? topLines : lines.slice(0, maxSearchResults),
          };
        },
        { query: whatLower, maxRows: effectiveMaxRows, maxCols, maxHeadings, maxErrors, maxLinks, maxContent, maxSearchResults }
      );

      // Post-evaluate safety net: if result exceeds 15KB, halve table rows iteratively
      let serialized = JSON.stringify(data);
      if (serialized.length > MAX_EXTRACT_BYTES && data.type === "table") {
        const tableData = data.data as Array<{ headers: string[]; rows: string[][]; _truncated?: boolean }>;
        for (const table of tableData) {
          while (JSON.stringify(data).length > MAX_EXTRACT_BYTES && table.rows.length > 1) {
            table.rows = table.rows.slice(0, Math.ceil(table.rows.length / 2));
            table._truncated = true;
          }
        }
        serialized = JSON.stringify(data);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: serialized,
          },
        ],
      };
    },
  },
};

/**
 * Strip default-valued fields from observation for concise output.
 */
function conciseObservation(obs: Observation) {
  return {
    page: obs.page,
    url: obs.url,
    relevant_elements: obs.relevant_elements.map((el) => {
      const slim: Record<string, any> = {
        type: el.type,
        label: el.label,
      };
      if (el.value) slim.value = el.value;
      if (el.filled) slim.filled = el.filled;
      if (el.enabled === false) slim.enabled = false;
      if (el.checked !== undefined) slim.checked = el.checked;
      if (el.options) slim.options = el.options;
      return slim;
    }),
    notices: obs.notices,
  };
}
