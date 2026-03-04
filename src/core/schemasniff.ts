/**
 * SchemaSniff — automatic DOM pattern detection and field inference.
 * Adapted from https://github.com/tylergibbs1/schemasniff to run against
 * an existing Playwright Page instead of launching its own browser.
 */

import type { Page } from "playwright";

// ============================================================================
// Types
// ============================================================================

export interface SniffOptions {
  minItems: number;
  maxDepth: number;
  confidenceThreshold: number;
  includeEmpty: boolean;
  excludeSelectors?: string[];
  ignoreNav: boolean;
  preferTable: boolean;
  containerSelector?: string;
  minChildren?: number;
  minTextLength?: number;
}

export type FieldType = "text" | "href" | "url" | "number" | "date" | "price";

export interface SniffField {
  name: string;
  selector: string;
  type: FieldType;
  confidence: number;
  sample?: string;
}

export interface SniffSchema {
  containerSelector: string;
  fields: SniffField[];
  itemCount: number;
  confidence: number;
}

interface DOMPattern {
  selector: string;
  count: number;
  depth: number;
  samples: PatternSample[];
}

interface PatternSample {
  html: string;
  text: string | undefined;
  childCount: number;
  textLength: number;
}

interface ScoredPattern {
  pattern: DOMPattern;
  score: number;
  diversityScore: number;
}

const CONTAINER_TAGS = ["article", "div", "li", "tr", "section", "a"] as const;
const SAMPLE_COUNT = 5;
const MAX_HTML_PREVIEW = 200;
const MAX_TEXT_PREVIEW = 100;
const MAX_FIELD_NAME_LENGTH = 30;
const IDEAL_DOM_DEPTH = 4;

const NAV_SELECTORS = [
  "nav", "header", "footer", ".nav", ".navbar", ".navigation",
  ".menu", ".sidebar", ".footer", ".header", '[role="navigation"]',
  '[role="banner"]', '[role="contentinfo"]',
];

// ============================================================================
// Utility class detection — injectable into page.evaluate()
// ============================================================================

const UTILITY_CLASSES = [
  "flex", "grid", "block", "inline", "inline-block", "inline-flex", "inline-grid",
  "hidden", "visible", "invisible", "contents", "flow-root",
  "relative", "absolute", "fixed", "sticky", "static",
  "items-center", "items-start", "items-end", "items-stretch", "items-baseline",
  "justify-center", "justify-start", "justify-end", "justify-between", "justify-around",
  "flex-row", "flex-col", "flex-wrap", "flex-nowrap", "flex-1", "grow", "shrink",
  "w-full", "w-auto", "w-screen", "h-full", "h-auto", "h-screen",
  "text-left", "text-center", "text-right", "text-justify",
  "font-normal", "font-medium", "font-semibold", "font-bold",
  "truncate", "overflow-hidden", "overflow-auto", "overflow-scroll",
  "bg-white", "bg-black", "bg-transparent", "text-white", "text-black",
  "border", "border-0", "border-2", "rounded", "rounded-md", "rounded-lg", "rounded-full",
  "shadow", "shadow-sm", "shadow-md", "shadow-lg", "opacity-0", "opacity-50", "opacity-100",
  "transition", "transition-all", "duration-150", "duration-200", "duration-300",
  "container", "row", "col", "d-flex", "d-block", "d-none", "d-inline",
  "align-items-center", "justify-content-center",
  "clearfix", "wrapper", "inner", "outer", "content", "main",
] as const;

function getInjectableUtilityLogic(): string {
  return `
    const utilityClassSet = new Set(${JSON.stringify(UTILITY_CLASSES)});

    function isUtilityClass(cls) {
      if (utilityClassSet.has(cls)) return true;
      if (/[:\\[\\]*@#>~+]/.test(cls)) return true;
      if (/^(sm|md|lg|xl|2xl|hover|focus|active|disabled|dark|light):/.test(cls)) return true;
      if (/^-?(m|p)(t|r|b|l|x|y)?-\\[?.+\\]?$/.test(cls)) return true;
      if (/^(w|h|min-w|min-h|max-w|max-h)-\\[?.+\\]?$/.test(cls)) return true;
      if (/^(text|bg|border|ring)-(gray|slate|zinc|neutral|red|blue|green|yellow|purple|pink|orange|indigo|teal|cyan)-\\d+/.test(cls)) return true;
      if (/^grid-(cols|rows)-\\d+$/.test(cls) || /^(col|row)-span-\\d+$/.test(cls)) return true;
      if (/^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)$/.test(cls)) return true;
      if (/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.test(cls)) return true;
      return false;
    }

    function getSemanticClasses(el) {
      const className = el.className?.toString?.()?.trim?.() || '';
      if (!className) return [];
      return className.split(/\\s+/).filter(cls => !isUtilityClass(cls));
    }

    function getSemanticClassSelector(el) {
      const semantic = getSemanticClasses(el);
      return semantic.length > 0 ? '.' + semantic[0] : '';
    }
  `;
}

// ============================================================================
// Main Entry — runs analysis against an existing Playwright Page
// ============================================================================

export async function sniffPage(
  page: Page,
  options: SniffOptions
): Promise<SniffSchema> {
  let bestPattern: DOMPattern | null;

  if (options.containerSelector) {
    bestPattern = await getManualPattern(page, options.containerSelector);
    if (!bestPattern) {
      throw new Error(
        `No elements found for container selector: ${options.containerSelector}`
      );
    }
  } else {
    const patterns = await findRepeatedPatterns(page, options);
    bestPattern = selectBestPattern(patterns, options);
    if (!bestPattern) {
      throw new Error(
        `No repeated patterns found with at least ${options.minItems} items`
      );
    }
  }

  let fields = await inferFields(page, bestPattern, options);

  // Deduplicate field names
  fields = deduplicateFields(fields);

  const confidence = calculateConfidence(bestPattern, fields, options);

  return {
    containerSelector: bestPattern.selector,
    fields,
    itemCount: bestPattern.count,
    confidence,
  };
}

// ============================================================================
// Manual Container
// ============================================================================

async function getManualPattern(
  page: Page,
  selector: string
): Promise<DOMPattern | null> {
  return page.evaluate(
    ({ selector, maxHtmlPreview, maxTextPreview }) => {
      const elements = Array.from(document.querySelectorAll(selector));
      if (elements.length === 0) return null;

      function getDepth(el: Element): number {
        let depth = 0;
        let current: Element | null = el;
        while (current?.parentElement) {
          depth++;
          current = current.parentElement;
        }
        return depth;
      }

      const samples = elements.slice(0, 5).map((el) => ({
        html: el.outerHTML.substring(0, maxHtmlPreview),
        text: el.textContent?.substring(0, maxTextPreview),
        childCount: el.children.length,
        textLength: (el.textContent || "").trim().length,
      }));

      return {
        selector,
        count: elements.length,
        depth: getDepth(elements[0]!),
        samples,
      };
    },
    { selector, maxHtmlPreview: MAX_HTML_PREVIEW, maxTextPreview: MAX_TEXT_PREVIEW }
  );
}

// ============================================================================
// Pattern Detection
// ============================================================================

async function findRepeatedPatterns(
  page: Page,
  options: SniffOptions
): Promise<DOMPattern[]> {
  const utilityLogic = getInjectableUtilityLogic();

  let excludeSelectors = options.excludeSelectors || [];
  if (options.ignoreNav) {
    excludeSelectors = [...excludeSelectors, ...NAV_SELECTORS];
  }

  return page.evaluate(
    ({
      minItems,
      maxHtmlPreview,
      maxTextPreview,
      containerTags,
      utilityLogic,
      excludeSelectors,
      minChildren,
      minTextLength,
    }) => {
      // Inject utility class detection logic
      eval(utilityLogic);
      // @ts-expect-error - getSemanticClasses is injected via eval
      const _getSemanticClasses = getSemanticClasses;

      const results: any[] = [];

      const excludedElements = new Set<Element>();
      excludeSelectors.forEach((sel: string) => {
        try {
          document.querySelectorAll(sel).forEach((el) => {
            excludedElements.add(el);
            el.querySelectorAll("*").forEach((desc) =>
              excludedElements.add(desc)
            );
          });
        } catch {
          /* invalid selector */
        }
      });

      function isExcluded(el: Element): boolean {
        return excludedElements.has(el);
      }

      function classIntersection(
        classes1: string[],
        classes2: string[]
      ): string[] {
        const set2 = new Set(classes2);
        return classes1.filter((cls) => set2.has(cls));
      }

      function getDepth(el: Element): number {
        let depth = 0;
        let current: Element | null = el;
        while (current?.parentElement) {
          depth++;
          current = current.parentElement;
        }
        return depth;
      }

      containerTags.forEach((tag: string) => {
        const elements = Array.from(
          document.querySelectorAll(tag)
        ).filter((el) => !isExcluded(el));
        if (elements.length < minItems) return;

        const groups: { classes: string[]; elements: Element[] }[] = [];

        elements.forEach((el) => {
          if (
            minChildren !== undefined &&
            el.children.length < minChildren
          )
            return;
          if (minTextLength !== undefined) {
            const textLen = (el.textContent || "").trim().length;
            if (textLen < minTextLength) return;
          }

          const semanticClasses = _getSemanticClasses(el);
          if (semanticClasses.length === 0) return;

          let bestGroup: { classes: string[]; elements: Element[] } | null =
            null;
          let bestIntersection: string[] = [];

          for (const group of groups) {
            const intersection = classIntersection(
              semanticClasses,
              group.classes
            );
            if (
              intersection.length >= 1 &&
              intersection.length > bestIntersection.length
            ) {
              bestGroup = group;
              bestIntersection = intersection;
            }
          }

          if (bestGroup && bestIntersection.length >= 1) {
            bestGroup.classes = bestIntersection;
            bestGroup.elements.push(el);
          } else {
            groups.push({ classes: semanticClasses, elements: [el] });
          }
        });

        groups.forEach((group) => {
          if (
            group.elements.length >= minItems &&
            group.classes.length >= 1
          ) {
            const selector = `${tag}.${group.classes.join(".")}`;
            const samples = group.elements.slice(0, 10).map((el) => ({
              html: el.outerHTML.substring(0, maxHtmlPreview),
              text: el.textContent?.substring(0, maxTextPreview),
              childCount: el.children.length,
              textLength: (el.textContent || "").trim().length,
            }));

            results.push({
              selector,
              count: group.elements.length,
              depth: getDepth(group.elements[0]!),
              samples,
            });
          }
        });
      });

      return results;
    },
    {
      minItems: options.minItems,
      maxHtmlPreview: MAX_HTML_PREVIEW,
      maxTextPreview: MAX_TEXT_PREVIEW,
      containerTags: [...CONTAINER_TAGS],
      utilityLogic,
      excludeSelectors,
      minChildren: options.minChildren,
      minTextLength: options.minTextLength,
    }
  );
}

// ============================================================================
// Pattern Scoring & Selection
// ============================================================================

function scorePatterns(
  patterns: DOMPattern[],
  options: SniffOptions
): ScoredPattern[] {
  const filtered = patterns.filter((p) => p.depth <= options.maxDepth);
  if (filtered.length === 0) return [];

  const scored = filtered.map((p) => {
    const diversityScore = calculateDiversity(p.samples);

    if (diversityScore < 0.2) {
      return { pattern: p, score: -100, diversityScore };
    }

    const countScore = Math.log(p.count) * 10;
    const depthScore = Math.max(
      0,
      10 - Math.abs(p.depth - IDEAL_DOM_DEPTH) * 2
    );
    const diversityBonusScore = diversityScore * 15;

    const avgChildCount =
      p.samples.reduce((sum, s) => sum + s.childCount, 0) / p.samples.length;
    const childScore = Math.min(avgChildCount / 3, 1) * 20;

    let tableBonusScore = 0;
    if (options.preferTable) {
      if (p.selector.startsWith("tr.") || p.selector.startsWith("tr ")) {
        tableBonusScore = 25;
      } else if (
        p.selector.includes("table") ||
        p.selector.includes("tbody")
      ) {
        tableBonusScore = 15;
      }
    }

    let anchorPenalty = 0;
    if (p.selector.startsWith("a.")) {
      anchorPenalty = -15;
    }

    const score =
      countScore +
      depthScore +
      diversityBonusScore +
      childScore +
      tableBonusScore +
      anchorPenalty;

    return { pattern: p, score, diversityScore };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function selectBestPattern(
  patterns: DOMPattern[],
  options: SniffOptions
): DOMPattern | null {
  const scored = scorePatterns(patterns, options);
  return scored.length > 0 ? scored[0]!.pattern : null;
}

function calculateDiversity(samples: PatternSample[]): number {
  if (samples.length <= 1) return samples.length;

  const texts = samples
    .map((s) =>
      (s.text || "")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 50)
        .toLowerCase()
    )
    .filter((t) => t.length > 0);

  if (texts.length === 0) return 0.5;

  const uniqueTexts = new Set(texts);
  return uniqueTexts.size / texts.length;
}

// ============================================================================
// Field Inference
// ============================================================================

async function inferFields(
  page: Page,
  pattern: DOMPattern,
  options: SniffOptions
): Promise<SniffField[]> {
  const utilityLogic = getInjectableUtilityLogic();

  return page.evaluate(
    ({
      selector,
      includeEmpty,
      confidenceThreshold,
      sampleCount,
      maxFieldNameLength,
      utilityLogic,
    }) => {
      eval(utilityLogic);
      // @ts-expect-error - functions are injected via eval
      const _getSemanticClassSelector = getSemanticClassSelector;

      const containers = Array.from(document.querySelectorAll(selector));
      if (containers.length === 0) return [];

      const fieldMap = new Map<
        string,
        { name: string; type: string; selector: string; samples: string[] }
      >();

      function addToMap(
        key: string,
        name: string,
        type: string,
        el: Element,
        sample: string
      ) {
        if (!fieldMap.has(key)) {
          fieldMap.set(key, {
            name,
            type,
            selector: getRelativeSelector(el, selector),
            samples: [],
          });
        }
        fieldMap.get(key)!.samples.push(sample);
      }

      function getElementPath(el: Element, root: Element): string {
        const path: string[] = [];
        let current: Element | null = el;
        while (current && current !== root) {
          const tag = current.tagName.toLowerCase();
          const semClass = _getSemanticClassSelector(current);
          path.unshift(`${tag}${semClass}`);
          current = current.parentElement;
        }
        return path.join(">");
      }

      function getRelativeSelector(el: Element, containerSel: string): string {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const semClass = _getSemanticClassSelector(el);
        return `${containerSel} ${tag}${id}${semClass}`.trim();
      }

      function inferType(text: string): string {
        if (!text) return "text";
        if (
          /^[$£€¥]\s*[\d,]+\.?\d*$/.test(text) ||
          /^\d+\.?\d*\s*[$£€¥]$/.test(text)
        )
          return "price";
        if (/^\d+\.?\d*$/.test(text)) return "number";
        if (
          /\d{1,4}[-\/]\d{1,2}[-\/]\d{1,4}/.test(text) ||
          /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(text)
        )
          return "date";
        return "text";
      }

      function sanitizeName(text: string): string {
        return text
          .toLowerCase()
          .substring(0, maxFieldNameLength)
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");
      }

      containers.slice(0, sampleCount).forEach((container) => {
        const walker = document.createTreeWalker(
          container,
          NodeFilter.SHOW_ELEMENT,
          null
        );

        let node: Node | null;
        while ((node = walker.nextNode())) {
          const el = node as Element;
          const tagName = el.tagName.toLowerCase();

          if (tagName === "script" || tagName === "style") continue;

          if (tagName === "a" && el.hasAttribute("href")) {
            const href = el.getAttribute("href") || "";
            const text = el.textContent?.trim() || "";
            if (text || includeEmpty) {
              const key = `link_${getElementPath(el, container)}`;
              addToMap(key, text ? sanitizeName(text) : "link", "href", el, href);
            }
          }

          if (tagName === "img" && el.hasAttribute("src")) {
            const src = el.getAttribute("src") || "";
            const alt = el.getAttribute("alt") || "image";
            const key = `img_${getElementPath(el, container)}`;
            addToMap(key, sanitizeName(alt), "url", el, src);
          }

          if (el.children.length === 0) {
            const text = el.textContent?.trim() || "";
            if (text || includeEmpty) {
              const type = inferType(text);
              const key = `${type}_${getElementPath(el, container)}`;
              const name = text ? sanitizeName(text) : tagName;
              addToMap(key, name, type, el, text);
            }
          }
        }
      });

      const fields: any[] = [];
      fieldMap.forEach((data) => {
        const uniqueSamples = new Set(data.samples).size;
        const confidence = uniqueSamples / data.samples.length;

        if (confidence >= confidenceThreshold) {
          fields.push({
            name: data.name,
            selector: data.selector,
            type: data.type,
            confidence: Math.round(confidence * 100) / 100,
            sample: data.samples[0],
          });
        }
      });

      return fields;
    },
    {
      selector: pattern.selector,
      includeEmpty: options.includeEmpty,
      confidenceThreshold: options.confidenceThreshold,
      sampleCount: SAMPLE_COUNT,
      maxFieldNameLength: MAX_FIELD_NAME_LENGTH,
      utilityLogic,
    }
  );
}

// ============================================================================
// Confidence & Deduplication
// ============================================================================

function calculateConfidence(
  pattern: DOMPattern,
  fields: SniffField[],
  options: SniffOptions
): number {
  if (fields.length === 0) return 0;

  const countRatio = Math.min(pattern.count / options.minItems / 2, 1);
  const avgFieldConf =
    fields.reduce((sum, f) => sum + f.confidence, 0) / fields.length;
  const fieldScore = Math.min(fields.length / 5, 1);

  return Math.round((countRatio * 0.3 + avgFieldConf * 0.4 + fieldScore * 0.3) * 100) / 100;
}

function deduplicateFields(fields: SniffField[]): SniffField[] {
  const seen = new Map<string, number>();
  return fields.map((field) => {
    const count = seen.get(field.name) || 0;
    seen.set(field.name, count + 1);
    return count > 0 ? { ...field, name: `${field.name}_${count}` } : field;
  });
}
