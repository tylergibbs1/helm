/**
 * Smoke test: verify the server boots and lists tools.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/server.ts"],
});

const client = new Client({ name: "boot-test", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Server booted. ${tools.length} tools registered:`);
for (const tool of tools) {
  console.log(`  - ${tool.name}: ${tool.description?.substring(0, 60)}...`);
}

await client.close();
process.exit(0);
