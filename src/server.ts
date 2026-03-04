import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { navigationTools } from "./tools/navigation.js";
import { observationTools } from "./tools/observation.js";
import { interactionTools } from "./tools/interaction.js";
import { compositeTools } from "./tools/composite.js";
import { sessionTools } from "./tools/session.js";
import { dataTools } from "./tools/data.js";
import { devtoolsTools } from "./tools/devtools.js";
import { shutdown } from "./core/browser.js";
import { closeDb } from "./core/memory.js";
import { formatError } from "./core/recovery.js";

const server = new McpServer({
  name: "helm",
  version: "0.1.0",
});

// Register all tools
function registerTools() {
  const toolGroups = [
    navigationTools,
    observationTools,
    interactionTools,
    compositeTools,
    sessionTools,
    dataTools,
    devtoolsTools,
  ];

  for (const group of toolGroups) {
    for (const [name, tool] of Object.entries(group)) {
      const { description, schema, handler } = tool as {
        description: string;
        schema: any;
        handler: (args: any) => Promise<any>;
      };

      server.tool(name, description, schema.shape, async (args: any) => {
        try {
          return await handler(args);
        } catch (err) {
          const formatted = formatError(err, name);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(formatted) }],
            isError: true,
          };
        }
      });
    }
  }
}

registerTools();

// Graceful shutdown
async function cleanup() {
  closeDb();
  await shutdown();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
