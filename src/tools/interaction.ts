import { z } from "zod";
import { getActivePage } from "../core/browser.js";
import { resolve } from "../core/resolver.js";
import { clickMark } from "../core/som.js";
import { withRecovery } from "../core/recovery.js";
import { recordAction } from "../core/memory.js";
import { computeFingerprint } from "../core/fingerprint.js";

export const interactionTools = {
  act_click: {
    description:
      "Click an element by its visible label OR by a Set-of-Mark ID number.\n" +
      "Returns: { clicked, resolved_via?, url } or { clicked_mark, url }\n" +
      "When to use: Pass `label` for text-based clicking (most common). Pass `mark_id` when labels are unhelpful — " +
      "call `obs_screenshot(overlay=true)` first, then click by number. Provide exactly one of `label` or `mark_id`.\n" +
      "Pitfalls: Call `obs_observe` first to confirm the label exists. Do NOT pass CSS selectors as the label.",
    schema: z.object({
      label: z
        .string()
        .optional()
        .describe(
          'The visible text, button label, or aria-label of the element to click (e.g., "Submit", "Sign in")'
        ),
      mark_id: z
        .number()
        .optional()
        .describe("The mark ID number from an obs_screenshot(overlay=true) result"),
    }),
    handler: async ({ label, mark_id }: { label?: string; mark_id?: number }) => {
      if ((label === undefined) === (mark_id === undefined)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Provide exactly one of `label` or `mark_id`, not both or neither.",
              }),
            },
          ],
          isError: true,
        };
      }

      const page = await getActivePage();

      if (mark_id !== undefined) {
        await withRecovery(
          page,
          async () => {
            await clickMark(page, mark_id);
          },
          `click mark ${mark_id}`
        );

        await page.waitForTimeout(500);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                clicked_mark: mark_id,
                url: page.url(),
              }),
            },
          ],
        };
      }

      return withRecovery(
        page,
        async () => {
          const { locator, result } = await resolve(page, label!);
          await locator.click({ timeout: 5_000 });

          const fingerprint = await computeFingerprint(locator).catch(() => undefined);
          recordAction(page.url(), await page.title(), {
            action: "click",
            label: label!,
            selector: result.selector,
            success: true,
            timestamp: Date.now(),
            fingerprint: fingerprint ?? undefined,
          });

          await page.waitForTimeout(500);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  clicked: label,
                  resolved_via: result.method,
                  url: page.url(),
                }),
              },
            ],
          };
        },
        `click "${label}"`
      );
    },
  },

  act_fill: {
    description:
      "Fill a single input field by its label, clearing any existing value first.\n" +
      "Returns: { filled, resolved_via }\n" +
      "When to use: For filling one field. Use `act_fill_form` for multiple fields at once.\n" +
      "Pitfalls: Call `obs_observe` first to confirm the field label. If the field isn't found, check for placeholder text or aria-label.",
    schema: z.object({
      field: z
        .string()
        .describe('The label, placeholder, or name of the field (e.g., "Email", "Password", "Search")'),
      value: z.string().describe("The value to type into the field"),
    }),
    handler: async ({ field, value }: { field: string; value: string }) => {
      const page = await getActivePage();

      return withRecovery(
        page,
        async () => {
          const { locator, result } = await resolve(page, field);
          await locator.click({ timeout: 5_000 });
          await locator.fill(value);

          const fingerprint = await computeFingerprint(locator).catch(() => undefined);
          recordAction(page.url(), await page.title(), {
            action: "fill",
            label: field,
            selector: result.selector,
            success: true,
            timestamp: Date.now(),
            fingerprint: fingerprint ?? undefined,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  filled: field,
                  resolved_via: result.method,
                }),
              },
            ],
          };
        },
        `fill "${field}"`
      );
    },
  },

  act_fill_form: {
    description:
      "Fill multiple form fields at once. Each key is the field label, each value is what to type.\n" +
      "Returns: { results: [{ field, status, method? }] }\n" +
      "When to use: More efficient than calling `act_fill` multiple times. Use for login forms, signup forms, etc.\n" +
      "Pitfalls: Fields are filled sequentially. If one fails, the rest still proceed.",
    schema: z.object({
      fields: z
        .record(z.string(), z.string())
        .describe(
          'Map of field label to value, e.g., {"Email": "user@example.com", "Password": "secret"}'
        ),
    }),
    handler: async ({ fields }: { fields: Record<string, string> }) => {
      const page = await getActivePage();
      const results: Array<{ field: string; status: string; method?: string }> = [];

      for (const [field, value] of Object.entries(fields)) {
        try {
          const { locator, result } = await resolve(page, field);
          await locator.click({ timeout: 5_000 });
          await locator.fill(value);

          const fingerprint = await computeFingerprint(locator).catch(() => undefined);
          recordAction(page.url(), await page.title(), {
            action: "fill",
            label: field,
            selector: result.selector,
            success: true,
            timestamp: Date.now(),
            fingerprint: fingerprint ?? undefined,
          });

          results.push({ field, status: "filled", method: result.method });
        } catch (err) {
          results.push({
            field,
            status: `failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ results }),
          },
        ],
      };
    },
  },

  act_select: {
    description:
      "Select an option from a dropdown by the dropdown's label and the desired option text.\n" +
      "Returns: { selected, in, resolved_via }\n" +
      "When to use: For <select> dropdowns. Tries matching by option label first, then by value attribute.\n" +
      "Pitfalls: For custom dropdown components (non-native), use `act_click` on the dropdown, then `act_click` on the option.",
    schema: z.object({
      field: z.string().describe("The label of the dropdown/select element"),
      value: z.string().describe("The option text or value to select"),
    }),
    handler: async ({ field, value }: { field: string; value: string }) => {
      const page = await getActivePage();

      return withRecovery(
        page,
        async () => {
          const { locator, result } = await resolve(page, field);

          try {
            await locator.selectOption({ label: value }, { timeout: 5_000 });
          } catch {
            await locator.selectOption({ value }, { timeout: 5_000 });
          }

          const fingerprint = await computeFingerprint(locator).catch(() => undefined);
          recordAction(page.url(), await page.title(), {
            action: "select",
            label: field,
            selector: result.selector,
            success: true,
            timestamp: Date.now(),
            fingerprint: fingerprint ?? undefined,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  selected: value,
                  in: field,
                  resolved_via: result.method,
                }),
              },
            ],
          };
        },
        `select "${value}" in "${field}"`
      );
    },
  },

  act_press: {
    description:
      "Press a keyboard key or shortcut.\n" +
      "Returns: { pressed }\n" +
      'When to use: For Enter, Escape, Tab, arrow keys, or shortcuts like "Control+a". Use after filling a search field to submit.\n' +
      "Pitfalls: Key names are case-sensitive. Use Playwright key names (e.g., 'ArrowDown', not 'Down').",
    schema: z.object({
      key: z
        .string()
        .describe('The key to press (e.g., "Enter", "Escape", "Tab", "Control+a", "ArrowDown")'),
    }),
    handler: async ({ key }: { key: string }) => {
      const page = await getActivePage();
      await page.keyboard.press(key);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ pressed: key }),
          },
        ],
      };
    },
  },
};
