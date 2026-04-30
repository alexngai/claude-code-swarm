/**
 * End-to-end integration test against the openteams loadout-demo template.
 *
 * Exercises the full loadout consumer path:
 *   cacheLoadoutArtifacts — writes loadouts/, scope/, mcp-providers.json, mcp-health.json
 *   generateAllAgents      — writes AGENT.md with enriched frontmatter
 *
 * Requires openteams >= 0.3 installed (or symlinked) under node_modules.
 * The test skips gracefully if openteams is unavailable at runtime.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import yaml from "js-yaml";

// Test file is at <root>/references/claude-code-swarm/src/__tests__/*.test.mjs
// openteams demo is at <root>/references/openteams/examples/loadout-demo
const LOADOUT_DEMO = path.resolve(
  new URL("..", import.meta.url).pathname, // -> src/
  "..", // -> claude-code-swarm/
  "..", // -> references/
  "openteams",
  "examples",
  "loadout-demo"
);

function openteamsAvailable() {
  try {
    const resolved = require.resolve
      ? require.resolve("openteams", {
          paths: [path.resolve(new URL("..", import.meta.url).pathname, "..")],
        })
      : null;
    return !!resolved;
  } catch {
    return false;
  }
}

const SKIP = !fs.existsSync(LOADOUT_DEMO);

describe.skipIf(SKIP)("E2E — loadout-demo", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-e2e-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cacheLoadoutArtifacts writes per-role scope + team providers + health", async () => {
    const { cacheLoadoutArtifacts } = await import("../template.mjs");
    const outputDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(outputDir, { recursive: true });

    cacheLoadoutArtifacts({
      templatePath: LOADOUT_DEMO,
      outputDir,
      templateName: "loadout-demo",
      teamName: "loadout-demo",
    });

    // Per-role artifacts written for roles that have loadouts
    expect(fs.existsSync(path.join(outputDir, "loadouts", "implementer.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "loadouts", "reviewer.json"))).toBe(true);
    // Planner in loadout-demo has no loadout — skipped
    expect(fs.existsSync(path.join(outputDir, "loadouts", "planner.json"))).toBe(false);

    // Scope files written for loadout-bearing roles
    expect(fs.existsSync(path.join(outputDir, "scope", "implementer.json"))).toBe(true);
    const reviewerScope = JSON.parse(
      fs.readFileSync(path.join(outputDir, "scope", "reviewer.json"), "utf-8")
    );
    expect(reviewerScope.role).toBe("reviewer");
    expect(reviewerScope.team).toBe("loadout-demo");
    // Reviewer inline-extends security-auditor → should have chrome-devtools in scope
    expect(reviewerScope.scope.some((s) => s.server === "chrome-devtools")).toBe(true);
    // Deny list should accumulate through the inheritance chain
    expect(reviewerScope.permissions.deny).toContain("Bash(git push:*)");

    // Team providers cached
    const providers = JSON.parse(
      fs.readFileSync(path.join(outputDir, "mcp-providers.json"), "utf-8")
    );
    expect(Object.keys(providers)).toContain("ast-grep");
    expect(Object.keys(providers)).toContain("chrome-devtools");
    expect(providers["secrets-scanner"]?.ref).toBe("@openhive/secrets-scanner");

    // Health report present
    expect(fs.existsSync(path.join(outputDir, "mcp-health.json"))).toBe(true);
    const health = JSON.parse(
      fs.readFileSync(path.join(outputDir, "mcp-health.json"), "utf-8")
    );
    expect(Array.isArray(health.missing)).toBe(true);
    expect(Array.isArray(health.ok)).toBe(true);
    // secrets-scanner is a ref — should land in refs[]
    expect(health.refs.some((r) => r.name === "secrets-scanner")).toBe(true);
  });

  it("generateAllAgents writes AGENT.md files with loadout-enriched frontmatter", async () => {
    const { generateAllAgents } = await import("../agent-generator.mjs");
    const outputDir = path.join(tmpDir, "agents");

    const result = await generateAllAgents(LOADOUT_DEMO, outputDir, {
      projectPath: tmpDir,
    });
    expect(result.success).toBe(true);
    expect(result.roles.sort()).toEqual(
      ["implementer", "planner", "reviewer"].sort()
    );

    // Reviewer — inline-extends security-auditor → rich frontmatter
    const reviewerMd = fs.readFileSync(
      path.join(outputDir, "reviewer", "AGENT.md"),
      "utf-8"
    );
    const frontmatter = extractFrontmatter(reviewerMd);
    expect(frontmatter.name).toBe("loadout-demo-reviewer");
    expect(frontmatter.generated_by).toBe("claude-code-swarm");
    expect(frontmatter.team_name).toBe("loadout-demo");
    expect(frontmatter.role).toBe("reviewer");
    expect(Array.isArray(frontmatter.mcpServers)).toBe(true);
    expect(frontmatter.mcpServers).toContain("ast-grep");
    expect(frontmatter.mcpServers).toContain("chrome-devtools");
    // Hooks block should exist (chrome-devtools has a tools allowlist)
    expect(frontmatter.hooks?.PreToolUse).toBeDefined();
    expect(frontmatter.hooks.PreToolUse[0].matcher).toBe("mcp__.*");
    // Capabilities flow through
    expect(frontmatter.capabilities).toContain("task.update");

    // Planner — no loadout → legacy minimal frontmatter
    const plannerMd = fs.readFileSync(
      path.join(outputDir, "planner", "AGENT.md"),
      "utf-8"
    );
    expect(plannerMd).toContain("name: loadout-demo-planner");
    // No mcpServers section since planner has no loadout
    expect(plannerMd).not.toContain("mcpServers:");
  });
});

function extractFrontmatter(agentMd) {
  const match = agentMd.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return yaml.load(match[1]);
}
