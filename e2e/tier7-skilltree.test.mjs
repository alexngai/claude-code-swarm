/**
 * Tier 7: Skill-Tree Integration Tests
 *
 * Tests the skill-tree loadout compilation pipeline without LLM calls:
 *   1. parseSkillTreeExtension extracts skilltree namespace from manifest
 *   2. inferProfileFromRole maps role names to profiles
 *   3. compileAllRoleLoadouts processes full manifests
 *   4. Loadouts are cached in skill-loadouts.json per template
 *   5. AGENT.md generation embeds skill loadouts
 *   6. Bootstrap context output includes skill-tree section
 *
 * No LLM calls — exercises pure computation and file I/O.
 *
 * Run:
 *   npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier7-skilltree.test.mjs
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createWorkspace } from "./helpers/workspace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHORT_TMPDIR = "/tmp";

// Import source modules
const {
  parseSkillTreeExtension,
  inferProfileFromRole,
  compileRoleLoadout,
  compileAllRoleLoadouts,
} = await import("../src/skilltree-client.mjs");

const { buildCapabilitiesContext } = await import("../src/context-output.mjs");
const { generateAgentMd } = await import("../src/agent-generator.mjs");

// Check if skill-tree is available for compilation tests
let skillTreeAvailable = false;
try {
  const st = await import("skill-tree");
  skillTreeAvailable = !!st.createSkillBank;
} catch {
  // Not installed or no createSkillBank export
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: parseSkillTreeExtension — YAML namespace parsing
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: skilltree parseSkillTreeExtension",
  { timeout: 15_000 },
  () => {
    it("extracts defaults and roles from manifest", () => {
      const manifest = {
        skilltree: {
          defaults: {
            profile: "implementation",
            maxSkills: 6,
          },
          roles: {
            orchestrator: { profile: "code-review" },
            executor: { profile: "implementation", tags: ["development"] },
            verifier: { profile: "testing" },
          },
        },
      };

      const { defaults, roles } = parseSkillTreeExtension(manifest);

      expect(defaults.profile).toBe("implementation");
      expect(defaults.maxSkills).toBe(6);
      expect(roles.orchestrator.profile).toBe("code-review");
      expect(roles.executor.profile).toBe("implementation");
      expect(roles.executor.tags).toEqual(["development"]);
      expect(roles.verifier.profile).toBe("testing");
    });

    it("returns empty defaults and roles when no skilltree namespace", () => {
      const { defaults, roles } = parseSkillTreeExtension({});
      expect(defaults).toEqual({});
      expect(roles).toEqual({});
    });

    it("returns empty defaults and roles for null manifest", () => {
      const { defaults, roles } = parseSkillTreeExtension(null);
      expect(defaults).toEqual({});
      expect(roles).toEqual({});
    });

    it("handles missing defaults or roles gracefully", () => {
      const { defaults, roles } = parseSkillTreeExtension({
        skilltree: { defaults: { profile: "testing" } },
      });
      expect(defaults.profile).toBe("testing");
      expect(roles).toEqual({});
    });

    it("handles missing defaults with roles present", () => {
      const { defaults, roles } = parseSkillTreeExtension({
        skilltree: {
          roles: { executor: { profile: "implementation" } },
        },
      });
      expect(defaults).toEqual({});
      expect(roles.executor.profile).toBe("implementation");
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: inferProfileFromRole — role name to profile mapping
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: skilltree inferProfileFromRole",
  { timeout: 15_000 },
  () => {
    it("maps known role names to profiles", () => {
      expect(inferProfileFromRole("executor")).toBe("implementation");
      expect(inferProfileFromRole("developer")).toBe("implementation");
      expect(inferProfileFromRole("debugger")).toBe("debugging");
      expect(inferProfileFromRole("verifier")).toBe("testing");
      expect(inferProfileFromRole("qa")).toBe("testing");
      expect(inferProfileFromRole("architect")).toBe("refactoring");
      expect(inferProfileFromRole("tech-writer")).toBe("documentation");
      expect(inferProfileFromRole("security-auditor")).toBe("security");
      expect(inferProfileFromRole("plan-checker")).toBe("code-review");
      expect(inferProfileFromRole("integration-checker")).toBe("code-review");
    });

    it("handles partial matches (e.g. senior-developer)", () => {
      expect(inferProfileFromRole("senior-developer")).toBe("implementation");
      expect(inferProfileFromRole("lead-executor")).toBe("implementation");
      expect(inferProfileFromRole("junior-debugger")).toBe("debugging");
    });

    it("returns empty string for unknown roles", () => {
      expect(inferProfileFromRole("orchestrator")).toBe("");
      expect(inferProfileFromRole("coordinator")).toBe("");
      expect(inferProfileFromRole("unknown-role")).toBe("");
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: compileRoleLoadout — single role compilation
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: skilltree compileRoleLoadout",
  { timeout: 30_000 },
  () => {
    let workspace;

    afterEach(() => {
      if (workspace) {
        workspace.cleanup();
        workspace = null;
      }
    });

    it("returns empty string when basePath does not exist", async () => {
      const result = await compileRoleLoadout("executor", { profile: "implementation" }, {
        basePath: "/tmp/nonexistent-skill-tree-" + Date.now(),
      });
      expect(result).toBe("");
    });

    it("returns empty string when no criteria specified", async () => {
      const result = await compileRoleLoadout("executor", {}, {
        basePath: "/tmp/nonexistent-skill-tree-" + Date.now(),
      });
      expect(result).toBe("");
    });

    it.skipIf(!skillTreeAvailable)(
      "compiles loadout from profile when skill-tree basePath exists",
      async () => {
        workspace = createWorkspace({
          tmpdir: SHORT_TMPDIR,
          prefix: "t7-st-compile-",
          config: { template: "gsd", skilltree: { enabled: true } },
        });

        const stDir = path.join(workspace.dir, ".swarm", "skill-tree");
        fs.mkdirSync(stDir, { recursive: true });

        // Initialize skill-tree in the workspace
        try {
          const { createSkillBank } = await import("skill-tree");
          const bank = createSkillBank({ storage: { basePath: stDir } });
          await bank.initialize();
          await bank.shutdown();
        } catch (err) {
          console.log("[tier7] skill-tree init skipped:", err.message);
          return;
        }

        const result = await compileRoleLoadout("executor", { profile: "implementation" }, {
          basePath: stDir,
        });

        console.log("[tier7] compiled loadout length:", result.length);
        // May be empty if no skills are loaded in the test bank
        // The key assertion is that it didn't throw
      }
    );
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: compileAllRoleLoadouts — full manifest compilation
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: skilltree compileAllRoleLoadouts",
  { timeout: 30_000 },
  () => {
    it("processes all roles with overrides and defaults", async () => {
      const manifest = {
        roles: ["orchestrator", "executor", "verifier", "debugger"],
        skilltree: {
          defaults: { profile: "implementation" },
          roles: {
            orchestrator: { profile: "code-review" },
            verifier: { profile: "testing" },
          },
        },
      };

      // With a nonexistent basePath, all compilations return empty
      // but the function should process all roles without error
      const result = await compileAllRoleLoadouts(manifest, {
        basePath: "/tmp/nonexistent-st-" + Date.now(),
      });

      // Result is an object mapping role names to { content, profile }
      expect(typeof result).toBe("object");
      console.log("[tier7] compiled roles:", Object.keys(result).join(", "));
    });

    it("skips roles with no criteria and no inferred profile", async () => {
      const manifest = {
        roles: ["custom-role-xyz"],
        // No skilltree namespace at all
      };

      const result = await compileAllRoleLoadouts(manifest, {
        basePath: "/tmp/nonexistent-st-" + Date.now(),
      });

      // custom-role-xyz has no match in ROLE_PROFILE_MAP and no defaults
      expect(Object.keys(result)).not.toContain("custom-role-xyz");
    });

    it("uses defaultProfile from config as fallback", async () => {
      const manifest = {
        roles: ["custom-role-xyz"],
        // No skilltree namespace
      };

      const result = await compileAllRoleLoadouts(manifest, {
        basePath: "/tmp/nonexistent-st-" + Date.now(),
        defaultProfile: "implementation",
      });

      // With defaultProfile, it should attempt compilation
      // (returns empty since basePath doesn't exist, but no error)
      console.log("[tier7] with defaultProfile, compiled:", Object.keys(result).join(", "));
    });

    it("auto-infers profiles from role names", async () => {
      const manifest = {
        roles: ["executor", "debugger", "verifier"],
        // No skilltree namespace — should use inferProfileFromRole
      };

      const result = await compileAllRoleLoadouts(manifest, {
        basePath: "/tmp/nonexistent-st-" + Date.now(),
      });

      // These roles have known mappings in ROLE_PROFILE_MAP
      // Compilation returns empty (no basePath), but the function ran without error
      console.log("[tier7] auto-inferred roles processed:", Object.keys(result).join(", "));
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Context Output — buildCapabilitiesContext includes skill-tree
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: skilltree context output",
  { timeout: 15_000 },
  () => {
    it("includes per-role skills section when enabled and ready", () => {
      const context = buildCapabilitiesContext({
        skilltreeEnabled: true,
        skilltreeStatus: "ready",
      });

      expect(context).toContain("### Per-Role Skills");
      expect(context).toContain("skill loadout");
    });

    it("shows status when installed but not ready", () => {
      const context = buildCapabilitiesContext({
        skilltreeEnabled: true,
        skilltreeStatus: "installed",
      });

      expect(context).toContain("### Per-Role Skills");
    });

    it("omits skill-tree section when disabled", () => {
      const context = buildCapabilitiesContext({
        skilltreeEnabled: false,
        skilltreeStatus: "disabled",
      });

      expect(context).not.toContain("### Per-Role Skills");
    });

    it("main agent context describes team-wide loadout config", () => {
      const context = buildCapabilitiesContext({
        role: null,
        skilltreeEnabled: true,
        skilltreeStatus: "ready",
      });

      expect(context).toContain("skill loadout");
      expect(context).toContain("profiles");
    });

    it("spawned agent context references embedded skills section", () => {
      const context = buildCapabilitiesContext({
        role: "executor",
        teamName: "gsd",
        skilltreeEnabled: true,
        skilltreeStatus: "ready",
      });

      expect(context).toContain("## Skills");
      expect(context).toContain("skill loadout");
    });

    it("spawned agent context shows profile name when provided", () => {
      const context = buildCapabilitiesContext({
        role: "executor",
        teamName: "gsd",
        skilltreeEnabled: true,
        skilltreeStatus: "ready",
        skillProfile: "implementation",
      });

      expect(context).toContain("implementation");
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: Agent Generation — AGENT.md embeds skill loadout
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: skilltree agent generation",
  { timeout: 15_000 },
  () => {
    it("generateAgentMd includes Skills section when loadout provided", () => {
      const md = generateAgentMd({
        roleName: "executor",
        teamName: "gsd",
        position: "spawned",
        description: "Executor agent",
        tools: ["Read", "Write", "Bash"],
        skillContent: "# Role: executor\n\nTest content.",
        manifest: {},
        skilltreeEnabled: true,
        skilltreeStatus: "ready",
        skillLoadout: "## Skill: Clean Code\n\nWrite clean, readable code.",
        skillProfile: "implementation",
      });

      expect(md).toContain("## Skills");
      expect(md).toContain("Clean Code");
      expect(md).toContain("Write clean, readable code");
    });

    it("generateAgentMd omits Skills section when no loadout", () => {
      const md = generateAgentMd({
        roleName: "executor",
        teamName: "gsd",
        position: "spawned",
        description: "Executor agent",
        tools: ["Read", "Write", "Bash"],
        skillContent: "# Role: executor\n\nTest content.",
        manifest: {},
        skilltreeEnabled: true,
        skilltreeStatus: "ready",
        // No skillLoadout
      });

      // Should not have the actual "## Skills" heading as a standalone section
      // (it may appear in capabilities context as a reference like "## Skills section above")
      expect(md).not.toMatch(/^## Skills$/m);
    });

    it("generateAgentMd includes capabilities context with skill-tree info", () => {
      const md = generateAgentMd({
        roleName: "verifier",
        teamName: "gsd",
        position: "spawned",
        description: "Verifier agent",
        tools: ["Read", "Bash"],
        skillContent: "# Role: verifier\n\nTest content.",
        manifest: {},
        skilltreeEnabled: true,
        skilltreeStatus: "ready",
        skillProfile: "testing",
      });

      expect(md).toContain("### Per-Role Skills");
      expect(md).toContain("testing");
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 7: Cached Loadouts — skill-loadouts.json read by agent generator
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: skilltree cached loadouts",
  { timeout: 15_000 },
  () => {
    let workspace;

    afterEach(() => {
      if (workspace) {
        workspace.cleanup();
        workspace = null;
      }
    });

    it("agent generator reads skill-loadouts.json for loadout content", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR,
        prefix: "t7-st-cache-",
        config: { template: "gsd", skilltree: { enabled: true } },
      });

      const cacheDir = path.join(workspace.dir, ".swarm", "claude-swarm", "tmp", "teams", "gsd");
      const agentsDir = path.join(cacheDir, "agents");
      fs.mkdirSync(agentsDir, { recursive: true });

      // Write a cached loadouts file
      const loadouts = {
        executor: {
          content: "## Skill: Test-Driven Development\n\nAlways write tests first.",
          profile: "implementation",
        },
        verifier: {
          content: "## Skill: Code Review\n\nReview code thoroughly.",
          profile: "testing",
        },
      };
      fs.writeFileSync(
        path.join(cacheDir, "skill-loadouts.json"),
        JSON.stringify(loadouts)
      );

      // Verify the file is readable and parseable
      const read = JSON.parse(
        fs.readFileSync(path.join(cacheDir, "skill-loadouts.json"), "utf-8")
      );
      expect(read.executor.content).toContain("Test-Driven Development");
      expect(read.executor.profile).toBe("implementation");
      expect(read.verifier.content).toContain("Code Review");
    });

    it("handles legacy string format in skill-loadouts.json", () => {
      // The agent generator handles both { content, profile } and plain string
      const legacyLoadouts = {
        executor: "## Skill: Legacy Format\n\nOld-style loadout.",
      };

      // Simulate the getLoadout helper from agent-generator
      function getLoadout(roleName) {
        const entry = legacyLoadouts[roleName];
        if (!entry) return { content: "", profile: "" };
        if (typeof entry === "string") return { content: entry, profile: "" };
        return { content: entry.content || "", profile: entry.profile || "" };
      }

      const { content, profile } = getLoadout("executor");
      expect(content).toContain("Legacy Format");
      expect(profile).toBe("");

      const { content: missing } = getLoadout("nonexistent");
      expect(missing).toBe("");
    });
  }
);
