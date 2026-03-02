#!/usr/bin/env node
/**
 * generate-agents.mjs — Bridge between openteams templates and Claude Code AGENT.md files
 *
 * Thin wrapper: delegates to src/agent-generator.mjs.
 *
 * Usage: node generate-agents.mjs <template-dir> [output-dir]
 */

import path from "path";
import { generateAllAgents } from "../src/agent-generator.mjs";

const templateDir = process.argv[2];
const outputDir = process.argv[3] || path.join(process.cwd(), "agents");

if (!templateDir) {
  console.error("Usage: generate-agents.mjs <template-dir> [output-dir]");
  process.exit(1);
}

const result = await generateAllAgents(templateDir, outputDir);

if (!result.success) {
  console.error(result.error);
  process.exit(1);
}

console.log(`Generated ${result.roles.length} agent definitions:`);
for (const role of result.roles) {
  console.log(`  agents/${role}/AGENT.md`);
}
console.log(`\nDone. Agent definitions written to: ${path.resolve(outputDir)}`);
