import { z } from "zod";
import { newTab, closeTab, getTabIds, setActiveTab, getActivePage } from "../core/browser.js";

export const sessionTools = {
  page_new_tab: {
    description:
      "Open a new browser tab and make it the active tab.\n" +
      "Returns: { tabId, tabs }\n" +
      "When to use: When you need to open a new page without losing the current one, or after a tab was closed.\n" +
      "Pitfalls: The new tab is blank — call `nav_goto` to navigate somewhere.",
    schema: z.object({}),
    handler: async () => {
      const { tabId } = await newTab();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ tabId, tabs: getTabIds() }),
          },
        ],
      };
    },
  },

  page_close_tab: {
    description:
      "Close a browser tab. Closes the active tab if no ID specified.\n" +
      "Returns: { closed, tabs }\n" +
      "When to use: To clean up tabs you no longer need.\n" +
      "Pitfalls: If you close the last tab, you'll need `page_new_tab` before doing anything else.",
    schema: z.object({
      tab_id: z.string().optional().describe("The tab ID to close. Closes active tab if omitted."),
    }),
    handler: async ({ tab_id }: { tab_id?: string }) => {
      await closeTab(tab_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ closed: tab_id ?? "active", tabs: getTabIds() }),
          },
        ],
      };
    },
  },

  page_switch_tab: {
    description:
      "Switch to a different browser tab by its ID.\n" +
      "Returns: { active, url, title }\n" +
      "When to use: To switch between open tabs. Use after `page_new_tab` or when working with multiple pages.\n" +
      "Pitfalls: Tab IDs come from `page_new_tab` or `page_close_tab` responses.",
    schema: z.object({
      tab_id: z.string().describe("The tab ID to switch to"),
    }),
    handler: async ({ tab_id }: { tab_id: string }) => {
      setActiveTab(tab_id);
      const page = await getActivePage();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              active: tab_id,
              url: page.url(),
              title: await page.title(),
            }),
          },
        ],
      };
    },
  },

  page_get_cookies: {
    description:
      "Get cookies for the current page or a specific domain. Values are redacted (first 6 chars only).\n" +
      "Returns: { count, cookies: [{ name, domain, path, value, secure, httpOnly, expires }] }\n" +
      "When to use: To inspect auth state, check if login succeeded, or debug cookie-related issues.\n" +
      "Pitfalls: Cookie values are truncated for security. Use `page_set_cookie` to set new cookies.",
    schema: z.object({
      domain: z.string().optional().describe("Filter cookies by domain. Returns all if omitted."),
    }),
    handler: async ({ domain }: { domain?: string }) => {
      const page = await getActivePage();
      const context = page.context();
      const cookies = await context.cookies();

      const filtered = domain
        ? cookies.filter((c) => c.domain.includes(domain))
        : cookies;

      const safe = filtered.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        value: c.value.length > 6 ? c.value.substring(0, 6) + "..." : c.value,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expires: c.expires,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: safe.length, cookies: safe }),
          },
        ],
      };
    },
  },

  page_set_cookie: {
    description:
      "Set a cookie for a specific domain.\n" +
      "Returns: { set, domain }\n" +
      "When to use: To inject auth tokens, set preferences, or configure session state before navigating.\n" +
      "Pitfalls: The cookie applies to the browser context, not just the active tab. Reload the page to see effects.",
    schema: z.object({
      name: z.string().describe("Cookie name"),
      value: z.string().describe("Cookie value"),
      domain: z.string().describe("Domain for the cookie"),
      path: z.string().optional().default("/").describe("Cookie path"),
    }),
    handler: async ({
      name,
      value,
      domain,
      path,
    }: {
      name: string;
      value: string;
      domain: string;
      path: string;
    }) => {
      const page = await getActivePage();
      const context = page.context();

      await context.addCookies([
        {
          name,
          value,
          domain,
          path,
        },
      ]);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ set: name, domain }),
          },
        ],
      };
    },
  },
};
