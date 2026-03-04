import { z } from "zod";
import { getActivePage } from "../core/browser.js";
import { runDomql } from "../core/domql.js";
import { sniffPage } from "../core/schemasniff.js";
import { extractStructured } from "../core/extractor.js";

export const dataTools = {
  data_query: {
    description:
      "Run a SQL-like query against the current page's DOM using CSS selectors.\n" +
      "Returns: { rows, columns?, count? } depending on query type.\n" +
      "When to use: For structured extraction when you know the CSS selectors. Use `data_analyze_page` first to discover selectors.\n" +
      "Pitfalls: Check SQL syntax — the FROM clause takes CSS selectors, not table names. " +
      "Quote selectors with spaces. Fields: 'text' for textContent, '@attr' for attributes (e.g. @href), '.selector' for nested CSS.\n" +
      "Examples:\n" +
      "  SELECT text, @href FROM a WHERE text LIKE '%pricing%'\n" +
      '  SELECT .title, .price FROM ".product-card" ORDER BY .price LIMIT 10\n' +
      "  SELECT COUNT() FROM li",
    schema: z.object({
      sql: z
        .string()
        .describe(
          "SQL-like query. SELECT fields FROM css-selector [WHERE ...] [ORDER BY ...] [LIMIT n]. " +
            "Fields: 'text' for textContent, '@attr' for attributes (e.g. @href, @src), " +
            "'.selector' for nested CSS selectors. Quote the FROM selector if it contains spaces."
        ),
    }),
    handler: async ({ sql }: { sql: string }) => {
      const page = await getActivePage();
      const result = await runDomql(page, sql);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  },

  data_analyze_page: {
    description:
      "Auto-detect repeating data patterns on the current page and infer a structured schema.\n" +
      "Returns: { selector, fields: [{ name, type, selector }], item_count, confidence, sample? }\n" +
      "When to use: Before using `data_query`, to discover the right CSS selectors for product listings, search results, tables, etc.\n" +
      "Pitfalls: Works best on pages with 3+ repeated items. Set `prefer_table=true` for table-heavy pages. " +
      "Results may include navigation elements — set `ignore_nav=true` (default) to exclude them.",
    schema: z.object({
      container_selector: z
        .string()
        .optional()
        .describe(
          "Optional: manually specify the container CSS selector instead of auto-detecting."
        ),
      min_items: z
        .number()
        .optional()
        .default(3)
        .describe("Minimum number of repeated items to consider a valid pattern (default: 3)"),
      ignore_nav: z
        .boolean()
        .optional()
        .default(true)
        .describe("Exclude common navigation elements (nav, header, footer) from detection"),
      prefer_table: z
        .boolean()
        .optional()
        .default(false)
        .describe("Prioritize table-based patterns in scoring"),
      response_format: z
        .enum(["concise", "detailed"])
        .optional()
        .default("concise")
        .describe("'concise' strips sample data and per-field confidence scores. 'detailed' returns everything."),
    }),
    handler: async ({
      container_selector,
      min_items,
      ignore_nav,
      prefer_table,
      response_format,
    }: {
      container_selector?: string;
      min_items: number;
      ignore_nav: boolean;
      prefer_table: boolean;
      response_format: "concise" | "detailed";
    }) => {
      const page = await getActivePage();

      const schema = await sniffPage(page, {
        minItems: min_items,
        maxDepth: 15,
        confidenceThreshold: 0.3,
        includeEmpty: false,
        ignoreNav: ignore_nav,
        preferTable: prefer_table,
        containerSelector: container_selector,
      });

      let output = schema;
      if (response_format === "concise" && schema && typeof schema === "object") {
        output = stripAnalysisDetail(schema);
      }

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

  data_extract: {
    description:
      "Extract structured data from the current page matching a caller-defined schema.\n" +
      "Returns: { mode, data, item_count, confidence, container_selector?, field_mapping[] }\n" +
      "When to use: When you know what fields you want (e.g., product name, price, URL) and want structured output " +
      "without manually chaining `data_analyze_page` → `data_query`. Handles both single items and lists automatically.\n" +
      "Pitfalls: Works best on pages with clear data structure. For complex custom extraction, use `data_analyze_page` + `data_query` instead.\n" +
      "Examples:\n" +
      '  fields: [{name: "title", description: "product name", type: "text"}, {name: "price", description: "product price", type: "price"}]\n' +
      '  fields: [{name: "headline", description: "article headline", type: "text"}, {name: "date", description: "publish date", type: "date"}]',
    schema: z.object({
      fields: z
        .array(
          z.object({
            name: z.string().describe("Field name for the output key"),
            description: z.string().describe("Human-readable description to help match the right element"),
            type: z
              .enum(["text", "number", "url", "date", "price", "boolean"])
              .default("text")
              .describe("Expected data type — used for coercion and matching"),
          })
        )
        .describe("Fields to extract from the page"),
      container_selector: z
        .string()
        .optional()
        .describe("Optional CSS selector for the repeating container (auto-detected if omitted)"),
      mode: z
        .enum(["single", "list", "auto"])
        .default("auto")
        .describe("'single' for one item, 'list' for repeating items, 'auto' to detect (default)"),
      max_items: z
        .number()
        .default(50)
        .describe("Maximum number of items to extract in list mode (default: 50)"),
    }),
    handler: async ({
      fields,
      container_selector,
      mode,
      max_items,
    }: {
      fields: Array<{ name: string; description: string; type: "text" | "number" | "url" | "date" | "price" | "boolean" }>;
      container_selector?: string;
      mode: "single" | "list" | "auto";
      max_items: number;
    }) => {
      const page = await getActivePage();

      const result = await extractStructured(page, {
        fields,
        container_selector,
        mode,
        max_items,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  },
};

/**
 * Strip sample data and per-field confidence from analyze_page output.
 */
function stripAnalysisDetail(schema: any): any {
  if (Array.isArray(schema)) {
    return schema.map(stripAnalysisDetail);
  }
  if (schema && typeof schema === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "sample") continue;
      if (key === "fields" && Array.isArray(value)) {
        result[key] = (value as any[]).map((field: any) => {
          const { confidence, ...rest } = field;
          return rest;
        });
        continue;
      }
      result[key] = value;
    }
    return result;
  }
  return schema;
}
