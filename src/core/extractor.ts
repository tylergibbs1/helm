import type { Page } from "playwright";
import { sniffPage, type SniffSchema, type SniffField } from "./schemasniff.js";

// ============================================================================
// Types
// ============================================================================

export interface ExtractField {
  name: string;
  description: string;
  type: "text" | "number" | "url" | "date" | "price" | "boolean";
}

export interface ExtractOptions {
  fields: ExtractField[];
  container_selector?: string;
  mode: "single" | "list" | "auto";
  max_items: number;
}

interface FieldMapping {
  requested: string;
  matched: string | null;
  selector: string | null;
  score: number;
}

export interface ExtractResult {
  mode: "single" | "list";
  data: Record<string, any> | Record<string, any>[];
  item_count: number;
  confidence: number;
  container_selector?: string;
  field_mapping: FieldMapping[];
}

const MAX_EXTRACT_BYTES = 15_000;

// ============================================================================
// Main Entry
// ============================================================================

export async function extractStructured(
  page: Page,
  options: ExtractOptions
): Promise<ExtractResult> {
  const { fields, container_selector, mode, max_items } = options;

  // Try list extraction if mode is "list" or "auto"
  if (mode === "list" || mode === "auto") {
    try {
      const schema = await sniffPage(page, {
        minItems: 2,
        maxDepth: 15,
        confidenceThreshold: 0.2,
        includeEmpty: false,
        ignoreNav: true,
        preferTable: false,
        containerSelector: container_selector,
      });

      if (schema && schema.itemCount >= 2 && schema.fields.length > 0) {
        return await extractList(page, fields, schema, max_items);
      }
    } catch {
      // No repeating pattern found
    }

    if (mode === "list") {
      throw new Error(
        "No repeating pattern found on page. Try mode='auto' or mode='single'."
      );
    }
  }

  // Single-item extraction
  return await extractSingle(page, fields);
}

// ============================================================================
// Field Mapping — score caller fields against sniffed fields
// ============================================================================

function mapFields(
  requested: ExtractField[],
  sniffed: SniffField[]
): FieldMapping[] {
  return requested.map((req) => {
    let bestMatch: SniffField | null = null;
    let bestScore = 0;

    for (const sf of sniffed) {
      const score = scoreFieldMatch(req, sf);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = sf;
      }
    }

    if (bestScore < 0.15 || !bestMatch) {
      return { requested: req.name, matched: null, selector: null, score: 0 };
    }

    return {
      requested: req.name,
      matched: bestMatch.name,
      selector: bestMatch.selector,
      score: Math.round(bestScore * 100) / 100,
    };
  });
}

function scoreFieldMatch(req: ExtractField, sniff: SniffField): number {
  // Token overlap (weight 0.4)
  const reqTokens = tokenize(`${req.name} ${req.description}`);
  const sniffTokens = tokenize(sniff.name);
  const overlap = reqTokens.filter((t) => sniffTokens.includes(t)).length;
  const tokenScore = reqTokens.length > 0 ? overlap / reqTokens.length : 0;

  // Type compatibility (weight 0.3)
  const typeScore = typeCompatibility(req.type, sniff.type);

  // Sniff confidence (weight 0.3)
  const confScore = sniff.confidence;

  return tokenScore * 0.4 + typeScore * 0.3 + confScore * 0.3;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function typeCompatibility(
  reqType: ExtractField["type"],
  sniffType: string
): number {
  if (reqType === sniffType) return 1.0;

  const compatible: Record<string, string[]> = {
    text: ["href", "text"],
    url: ["href", "url"],
    price: ["number", "price", "text"],
    number: ["price", "number", "text"],
    date: ["text", "date"],
    boolean: ["text"],
  };

  if (compatible[reqType]?.includes(sniffType)) return 0.5;
  return 0.1;
}

// ============================================================================
// List Extraction
// ============================================================================

async function extractList(
  page: Page,
  fields: ExtractField[],
  schema: SniffSchema,
  maxItems: number
): Promise<ExtractResult> {
  const mapping = mapFields(fields, schema.fields);

  // Build selector map for page.evaluate: { requestedName -> relativeSelector }
  const selectorMap: Record<string, string> = {};
  for (const m of mapping) {
    if (m.selector) {
      // Extract relative selector from the full selector (remove container prefix)
      const prefix = schema.containerSelector + " ";
      const relative = m.selector.startsWith(prefix)
        ? m.selector.slice(prefix.length)
        : m.selector;
      selectorMap[m.requested] = relative;
    }
  }

  // Build type map for coercion
  const typeMap: Record<string, string> = {};
  for (const f of fields) {
    typeMap[f.name] = f.type;
  }

  const data = await page.evaluate(
    ({ containerSelector, selectorMap, typeMap, maxItems }) => {
      function coerce(value: string, type: string): any {
        if (!value) return null;
        switch (type) {
          case "number":
            return parseFloat(value.replace(/[^0-9.\-]/g, "")) || null;
          case "price": {
            const cleaned = value.replace(/[^0-9.\-]/g, "");
            return cleaned ? parseFloat(cleaned) : null;
          }
          case "boolean":
            return /^(true|yes|1)$/i.test(value.trim());
          case "url":
            return value;
          case "date":
            return value;
          default:
            return value.trim();
        }
      }

      const containers = Array.from(
        document.querySelectorAll(containerSelector)
      ).slice(0, maxItems);

      return containers.map((container) => {
        const row: Record<string, any> = {};
        for (const [name, selector] of Object.entries(selectorMap)) {
          const el = container.querySelector(selector);
          if (el) {
            const type = typeMap[name] || "text";
            if (type === "url") {
              row[name] = coerce(
                el.getAttribute("href") || el.getAttribute("src") || el.textContent?.trim() || "",
                type
              );
            } else {
              row[name] = coerce(el.textContent?.trim() || "", type);
            }
          } else {
            row[name] = null;
          }
        }
        return row;
      });
    },
    {
      containerSelector: schema.containerSelector,
      selectorMap,
      typeMap,
      maxItems,
    }
  );

  // Cap response size
  let result = data;
  const totalItems = result.length;
  let serialized = JSON.stringify(result);
  while (serialized.length > MAX_EXTRACT_BYTES && result.length > 1) {
    result = result.slice(0, Math.ceil(result.length * 0.8));
    serialized = JSON.stringify(result);
  }
  const wasTruncated = result.length < totalItems;

  const avgScore = mapping.reduce((s, m) => s + m.score, 0) / mapping.length;

  return {
    mode: "list",
    data: result,
    item_count: result.length,
    ...(wasTruncated ? { _truncated: true, _total_items: totalItems } : {}),
    confidence: Math.round(avgScore * 100) / 100,
    container_selector: schema.containerSelector,
    field_mapping: mapping,
  };
}

// ============================================================================
// Single-Item Extraction
// ============================================================================

async function extractSingle(
  page: Page,
  fields: ExtractField[]
): Promise<ExtractResult> {
  const fieldSpecs = fields.map((f) => ({
    name: f.name,
    description: f.description,
    type: f.type,
    keywords: tokenize(`${f.name} ${f.description}`),
  }));

  const data = await page.evaluate(
    (specs) => {
      function coerce(value: string, type: string): any {
        if (!value) return null;
        switch (type) {
          case "number":
            return parseFloat(value.replace(/[^0-9.\-]/g, "")) || null;
          case "price": {
            const cleaned = value.replace(/[^0-9.\-]/g, "");
            return cleaned ? parseFloat(cleaned) : null;
          }
          case "boolean":
            return /^(true|yes|1)$/i.test(value.trim());
          case "url":
            return value;
          case "date":
            return value;
          default:
            return value.trim();
        }
      }

      // Score all text-bearing elements
      const candidates = document.querySelectorAll(
        "h1, h2, h3, h4, h5, h6, p, span, td, th, label, div, a, time, [itemprop]"
      );

      const result: Record<string, any> = {};

      for (const spec of specs) {
        let bestEl: Element | null = null;
        let bestScore = 0;

        for (const el of candidates) {
          const text = (el.textContent?.trim() || "").toLowerCase();
          if (!text || text.length > 500) continue;

          let score = 0;

          // Keyword match
          for (const kw of spec.keywords) {
            // Check element text, tag, class, id, aria-label, itemprop
            const attrs = [
              el.tagName.toLowerCase(),
              el.className?.toString?.() || "",
              el.id || "",
              el.getAttribute("aria-label") || "",
              el.getAttribute("itemprop") || "",
              el.getAttribute("name") || "",
            ]
              .join(" ")
              .toLowerCase();

            if (attrs.includes(kw)) score += 2;
            if (text.includes(kw)) score += 1;
          }

          // Boost headings for text fields
          if (spec.type === "text" && /^h[1-3]$/i.test(el.tagName)) {
            score += 1;
          }

          // Boost elements with matching itemprop
          const itemprop = (el.getAttribute("itemprop") || "").toLowerCase();
          if (itemprop && spec.keywords.some((kw) => itemprop.includes(kw))) {
            score += 3;
          }

          // Boost price-looking text for price fields
          if (
            spec.type === "price" &&
            /[$£€¥]\s*[\d,]+\.?\d*/.test(el.textContent || "")
          ) {
            score += 2;
          }

          // Boost links for url fields
          if (spec.type === "url" && el.tagName === "A" && el.hasAttribute("href")) {
            score += 2;
          }

          if (score > bestScore) {
            bestScore = score;
            bestEl = el;
          }
        }

        if (bestEl) {
          if (spec.type === "url" && bestEl.tagName === "A") {
            result[spec.name] = coerce(
              bestEl.getAttribute("href") || bestEl.textContent?.trim() || "",
              spec.type
            );
          } else {
            result[spec.name] = coerce(
              bestEl.textContent?.trim() || "",
              spec.type
            );
          }
        } else {
          result[spec.name] = null;
        }
      }

      return result;
    },
    fieldSpecs
  );

  // Confidence based on how many fields found values
  const foundCount = Object.values(data).filter((v) => v !== null).length;
  const confidence = fields.length > 0 ? Math.round((foundCount / fields.length) * 100) / 100 : 0;

  return {
    mode: "single",
    data,
    item_count: 1,
    confidence,
    field_mapping: fields.map((f) => ({
      requested: f.name,
      matched: data[f.name] !== null ? f.name : null,
      selector: null,
      score: data[f.name] !== null ? 1 : 0,
    })),
  };
}
