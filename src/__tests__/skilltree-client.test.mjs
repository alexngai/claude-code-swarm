import { describe, it, expect } from "vitest";
import { parseSkillTreeExtension } from "../skilltree-client.mjs";

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
});
