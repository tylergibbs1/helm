import type { Locator } from "playwright";
import type { DomFingerprint } from "../types.js";

/**
 * Compute a fingerprint for the DOM element matched by the given locator.
 * Captures tag, role, text, attributes, and sibling context, then hashes.
 */
export async function computeFingerprint(
  locator: Locator
): Promise<DomFingerprint | null> {
  try {
    // Quick existence check — avoid waiting for default timeout on missing elements
    if ((await locator.count()) === 0) return null;

    const raw = await locator.evaluate((el: Element) => {
      const htmlEl = el as HTMLElement;

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || tag;

      // First 50 chars of direct (non-child) text
      let ownText = "";
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          ownText += node.textContent || "";
        }
      }
      ownText = ownText.trim().substring(0, 50);

      // Sorted key=value of id, class, name, type, aria-label
      const attrKeys = ["id", "class", "name", "type", "aria-label"];
      const attrs = attrKeys
        .map((k) => {
          const v = el.getAttribute(k);
          return v ? `${k}=${v}` : null;
        })
        .filter(Boolean)
        .sort()
        .join(";");

      const parent = el.parentElement;
      const parentTag = parent ? parent.tagName.toLowerCase() : "";
      const parentClass = parent ? (parent.className?.toString?.() || "").trim().substring(0, 50) : "";

      // Previous + next sibling text (30 chars each)
      const prevText = (htmlEl.previousElementSibling?.textContent || "").trim().substring(0, 30);
      const nextText = (htmlEl.nextElementSibling?.textContent || "").trim().substring(0, 30);
      const siblingText = `${prevText}|${nextText}`;

      return { tag, role, ownText, attributes: attrs, parentTag, parentClass, siblingText };
    });

    // Hash all fields together using Bun.hash
    const concat = [
      raw.tag,
      raw.role,
      raw.ownText,
      raw.attributes,
      raw.parentTag,
      raw.parentClass,
      raw.siblingText,
    ].join("\n");

    const hash = Bun.hash(concat).toString(36);

    return { ...raw, hash };
  } catch {
    return null;
  }
}

/**
 * Compare a stored fingerprint against a freshly computed one.
 * Simple hash comparison — if hashes match, the element context is unchanged.
 */
export function matchesFingerprint(
  stored: DomFingerprint,
  current: DomFingerprint
): boolean {
  return stored.hash === current.hash;
}
