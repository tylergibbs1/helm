export interface RelevantElement {
  id: string;
  type: string;
  label: string;
  value?: string;
  filled?: boolean;
  enabled?: boolean;
  checked?: boolean;
  options?: string[];
}

export interface Observation {
  page: string;
  url: string;
  relevant_elements: RelevantElement[];
  notices: string[];
  prior_context?: SiteMemoryEntry;
}

export interface SiteMemoryEntry {
  domain: string;
  pages: PageMemory[];
  last_visited: number;
}

export interface PageMemory {
  url: string;
  title: string;
  reliable_labels: string[];
  actions_taken: ActionRecord[];
  last_visited: number;
}

export interface DomFingerprint {
  tag: string;
  role: string;
  ownText: string;
  attributes: string;
  parentTag: string;
  parentClass: string;
  siblingText: string;
  hash: string;
}

export interface ActionRecord {
  action: string;
  label: string;
  selector: string;
  success: boolean;
  timestamp: number;
  fingerprint?: DomFingerprint;
}

export interface SomMark {
  id: number;
  rect: { x: number; y: number; width: number; height: number };
  tag: string;
  label: string;
  role?: string;
}

export interface SomResult {
  screenshot: Buffer;
  marks: SomMark[];
}

export interface ResolveResult {
  selector: string;
  confidence: number;
  method: "role" | "label" | "text" | "placeholder" | "title" | "fuzzy" | "memory";
}

export interface WaitUntilOption {
  type: "content" | "network-idle";
}

/**
 * Shared interactive element selectors used by observer, SoM annotator, and fuzzy matcher.
 * Single source of truth — update here to affect all collectors.
 */
export const INTERACTIVE_SELECTORS = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[contenteditable="true"]',
] as const;

/** Raw element data collected from a single page.evaluate() call. */
export interface CollectedElement {
  tag: string;
  role: string;
  label: string;
  type: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  checked: boolean;
  options: string[];
  text: string;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Single page.evaluate() that collects all interactive elements with full metadata.
 * Used by observer, SoM, and fuzzy matcher to avoid redundant DOM walks.
 */
export function collectElementsScript(selectors: readonly string[]) {
  return (sels: string[]) => {
    const results: any[] = [];
    const seen = new Set<Element>();

    for (const selector of sels) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;

        const htmlEl = el as HTMLElement;
        const inputEl = el as HTMLInputElement;
        const selectEl = el as HTMLSelectElement;

        // Build label from multiple sources
        const ariaLabel = el.getAttribute("aria-label") || "";
        const ariaLabelledBy = el.getAttribute("aria-labelledby");
        let labelText = "";
        if (ariaLabelledBy) {
          const labelEl = document.getElementById(ariaLabelledBy);
          if (labelEl) labelText = labelEl.textContent?.trim() || "";
        }
        const id = el.id;
        if (id) {
          const assocLabel = document.querySelector(`label[for="${id}"]`);
          if (assocLabel) labelText = assocLabel.textContent?.trim() || "";
        }
        const parentLabel = el.closest("label");
        if (parentLabel && !labelText) {
          labelText = parentLabel.textContent?.trim() || "";
        }

        const text = htmlEl.innerText?.trim().substring(0, 100) || "";

        let options: string[] = [];
        if (el.tagName === "SELECT") {
          options = Array.from(selectEl.options).map((o) => o.text || o.value);
        }

        results.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || el.tagName.toLowerCase(),
          label: ariaLabel || labelText || el.getAttribute("title") || inputEl.placeholder || text || "",
          type: inputEl.type || "",
          value: inputEl.value || "",
          placeholder: inputEl.placeholder || "",
          disabled: inputEl.disabled || el.getAttribute("aria-disabled") === "true",
          checked: inputEl.checked || el.getAttribute("aria-checked") === "true",
          options,
          text,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      }
    }

    return results;
  };
}
