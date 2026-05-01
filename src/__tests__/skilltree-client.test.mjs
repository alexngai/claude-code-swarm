import { describe, it, expect } from "vitest";
import {
  parseSkillTreeExtension,
  inferProfileFromRole,
  computeRoleCriteria,
} from "../skilltree-client.mjs";

describe("skilltree-client", () => {
  describe("parseSkillTreeExtension", () => {
    it("returns empty defaults and roles for manifest without skilltree", () => {
      const result = parseSkillTreeExtension({ name: "test", roles: ["a"] });
      expect(result).toEqual({ defaults: {}, roles: {} });
    });

    it("returns empty defaults and roles for null manifest", () => {
      const result = parseSkillTreeExtension(null);
      expect(result).toEqual({ defaults: {}, roles: {} });
    });

    it("returns empty defaults and roles for undefined manifest", () => {
      const result = parseSkillTreeExtension(undefined);
      expect(result).toEqual({ defaults: {}, roles: {} });
    });

    it("extracts defaults from skilltree extension", () => {
      const manifest = {
        name: "test",
        roles: ["a", "b"],
        skilltree: {
          defaults: { profile: "implementation", maxSkills: 6 },
        },
      };
      const result = parseSkillTreeExtension(manifest);
      expect(result.defaults).toEqual({ profile: "implementation", maxSkills: 6 });
      expect(result.roles).toEqual({});
    });

    it("extracts per-role overrides from skilltree extension", () => {
      const manifest = {
        name: "test",
        roles: ["orchestrator", "executor", "verifier"],
        skilltree: {
          defaults: { profile: "implementation" },
          roles: {
            orchestrator: { profile: "code-review" },
            executor: { profile: "implementation", tags: ["development"] },
            verifier: { profile: "testing" },
          },
        },
      };
      const result = parseSkillTreeExtension(manifest);
      expect(result.defaults).toEqual({ profile: "implementation" });
      expect(result.roles.orchestrator).toEqual({ profile: "code-review" });
      expect(result.roles.executor).toEqual({ profile: "implementation", tags: ["development"] });
      expect(result.roles.verifier).toEqual({ profile: "testing" });
    });

    it("handles skilltree extension with only roles, no defaults", () => {
      const manifest = {
        name: "test",
        roles: ["a"],
        skilltree: {
          roles: { a: { profile: "debugging" } },
        },
      };
      const result = parseSkillTreeExtension(manifest);
      expect(result.defaults).toEqual({});
      expect(result.roles.a).toEqual({ profile: "debugging" });
    });

    it("handles skilltree extension with only defaults, no roles", () => {
      const manifest = {
        name: "test",
        roles: ["a"],
        skilltree: {
          defaults: { tags: ["typescript"] },
        },
      };
      const result = parseSkillTreeExtension(manifest);
      expect(result.defaults).toEqual({ tags: ["typescript"] });
      expect(result.roles).toEqual({});
    });
  });

  describe("inferProfileFromRole", () => {
    it("maps executor to implementation", () => {
      expect(inferProfileFromRole("executor")).toBe("implementation");
    });

    it("maps developer to implementation", () => {
      expect(inferProfileFromRole("developer")).toBe("implementation");
    });

    it("maps debugger to debugging", () => {
      expect(inferProfileFromRole("debugger")).toBe("debugging");
    });

    it("maps verifier to testing", () => {
      expect(inferProfileFromRole("verifier")).toBe("testing");
    });

    it("maps qa to testing", () => {
      expect(inferProfileFromRole("qa")).toBe("testing");
    });

    it("maps plan-checker to code-review", () => {
      expect(inferProfileFromRole("plan-checker")).toBe("code-review");
    });

    it("maps tech-writer to documentation", () => {
      expect(inferProfileFromRole("tech-writer")).toBe("documentation");
    });

    it("returns empty string for unknown role", () => {
      expect(inferProfileFromRole("orchestrator")).toBe("");
    });

    it("returns empty string for roadmapper", () => {
      expect(inferProfileFromRole("roadmapper")).toBe("");
    });

    it("matches partial role names", () => {
      expect(inferProfileFromRole("senior-developer")).toBe("implementation");
    });

    it("matches quick-flow-dev to implementation", () => {
      expect(inferProfileFromRole("quick-flow-dev")).toBe("implementation");
    });
  });

  describe("computeRoleCriteria — priority chain", () => {
    const baseManifest = { name: "t", roles: ["worker"] };

    it("uses skilltree extension defaults when no per-role override", () => {
      const out = computeRoleCriteria("worker", {
        ...baseManifest,
        skilltree: { defaults: { profile: "implementation", maxSkills: 4 } },
      });
      expect(out).toEqual({ profile: "implementation", maxSkills: 4 });
    });

    it("merges per-role override over defaults", () => {
      const out = computeRoleCriteria("worker", {
        ...baseManifest,
        skilltree: {
          defaults: { profile: "implementation", maxSkills: 4 },
          roles: { worker: { profile: "code-review" } },
        },
      });
      expect(out.profile).toBe("code-review");
      expect(out.maxSkills).toBe(4);
    });

    it("openteams loadout.skills overlays on top of skilltree extension", () => {
      const template = {
        roles: new Map([
          ["worker", { loadout: { skills: { profile: "security" } } }],
        ]),
      };
      const out = computeRoleCriteria(
        "worker",
        {
          ...baseManifest,
          skilltree: { defaults: { profile: "implementation" } },
        },
        {},
        template,
      );
      // openteams wins on profile (replace-if-set)
      expect(out.profile).toBe("security");
    });

    it("openteams include unions with skilltree extension include", () => {
      const template = {
        roles: new Map([
          [
            "worker",
            { loadout: { skills: { include: ["b", "c"] } } },
          ],
        ]),
      };
      const out = computeRoleCriteria(
        "worker",
        {
          ...baseManifest,
          skilltree: {
            roles: { worker: { profile: "x", include: ["a", "b"] } },
          },
        },
        {},
        template,
      );
      expect([...out.include].sort()).toEqual(["a", "b", "c"]);
    });

    it("openteams max_tokens renames to maxTokens and replaces", () => {
      const template = {
        roles: new Map([
          ["worker", { loadout: { skills: { max_tokens: 30000 } } }],
        ]),
      };
      const out = computeRoleCriteria(
        "worker",
        {
          ...baseManifest,
          skilltree: { defaults: { profile: "x", maxTokens: 8000 } },
        },
        {},
        template,
      );
      expect(out.maxTokens).toBe(30000);
    });

    it("falls back to config.defaultProfile when no skill-bearing criteria", () => {
      const out = computeRoleCriteria(
        "novel-role",
        baseManifest,
        { defaultProfile: "documentation" },
      );
      expect(out.profile).toBe("documentation");
    });

    it("falls back to inferProfileFromRole when no defaultProfile", () => {
      const out = computeRoleCriteria("verifier", baseManifest);
      expect(out.profile).toBe("testing");
    });

    it("returns null when no criteria can be derived", () => {
      const out = computeRoleCriteria("brand-new-role-xyz", baseManifest);
      expect(out).toBeNull();
    });

    it("does not invoke fallback chain when criteria already has tags", () => {
      const out = computeRoleCriteria("worker", {
        ...baseManifest,
        skilltree: { defaults: { tags: ["typescript"] } },
      });
      expect(out.tags).toEqual(["typescript"]);
      expect(out.profile).toBeUndefined();
    });

    it("does not invoke fallback chain when openteams provided include", () => {
      const template = {
        roles: new Map([
          ["worker", { loadout: { skills: { include: ["x"] } } }],
        ]),
      };
      const out = computeRoleCriteria("worker", baseManifest, {}, template);
      expect(out.include).toEqual(["x"]);
      // No fallback profile assigned
      expect(out.profile).toBeUndefined();
    });

    it("accepts template.roles as a plain object (not just Map)", () => {
      const template = {
        roles: { worker: { loadout: { skills: { profile: "security" } } } },
      };
      const out = computeRoleCriteria("worker", baseManifest, {}, template);
      expect(out.profile).toBe("security");
    });

    it("openteams overlay precedes fallback (no defaultProfile applied if openteams set profile)", () => {
      const template = {
        roles: new Map([
          ["worker", { loadout: { skills: { profile: "security" } } }],
        ]),
      };
      const out = computeRoleCriteria(
        "worker",
        baseManifest,
        { defaultProfile: "implementation" },
        template,
      );
      expect(out.profile).toBe("security");
    });

    it("preserves criteria fields openteams does not declare", () => {
      const template = {
        roles: new Map([
          [
            "worker",
            { loadout: { skills: { profile: "security" } } },
          ],
        ]),
      };
      const out = computeRoleCriteria(
        "worker",
        {
          ...baseManifest,
          skilltree: {
            roles: {
              worker: {
                profile: "x",
                tags: ["typescript"],
                keywords: ["frontend"],
                maxSkills: 6,
              },
            },
          },
        },
        {},
        template,
      );
      expect(out.profile).toBe("security");
      expect(out.tags).toEqual(["typescript"]);
      expect(out.keywords).toEqual(["frontend"]);
      expect(out.maxSkills).toBe(6);
    });
  });
});
