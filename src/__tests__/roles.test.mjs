import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { readRoles, matchRole, writeRoles } from "../roles.mjs";
import { makeTmpDir, writeFile, makeTeamYaml, cleanupTmpDir } from "./helpers.mjs";

describe("roles", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanupTmpDir(tmpDir); });

  describe("readRoles", () => {
    it("reads and parses a valid roles.json", () => {
      const rolesPath = writeFile(tmpDir, "roles.json", JSON.stringify({
        team: "my-team", roles: ["a", "b"], root: "a", companions: [],
      }));
      const roles = readRoles(rolesPath);
      expect(roles.team).toBe("my-team");
      expect(roles.roles).toEqual(["a", "b"]);
    });

    it("returns empty structure when file does not exist", () => {
      const roles = readRoles(path.join(tmpDir, "nope.json"));
      expect(roles.team).toBe("");
      expect(roles.roles).toEqual([]);
    });

    it("returns empty structure when file contains invalid JSON", () => {
      const rolesPath = writeFile(tmpDir, "roles.json", "bad json");
      const roles = readRoles(rolesPath);
      expect(roles.roles).toEqual([]);
    });
  });

  describe("matchRole", () => {
    const roles = { team: "gsd", roles: ["orchestrator", "executor", "verifier"] };

    it("returns null when agentName is empty", () => {
      expect(matchRole("", roles)).toBeNull();
    });

    it("returns null when roles.roles is empty", () => {
      expect(matchRole("test", { team: "t", roles: [] })).toBeNull();
    });

    it("returns null when roles.roles is missing", () => {
      expect(matchRole("test", {})).toBeNull();
    });

    it("matches exact role name", () => {
      expect(matchRole("executor", roles)).toBe("executor");
    });

    it("matches prefixed name: team-role", () => {
      expect(matchRole("gsd-executor", roles)).toBe("executor");
    });

    it("matches suffixed name: anything-role", () => {
      expect(matchRole("my-custom-executor", roles)).toBe("executor");
    });

    it("returns null when no match is found", () => {
      expect(matchRole("planner", roles)).toBeNull();
    });

    it("returns first match", () => {
      const result = matchRole("orchestrator", roles);
      expect(result).toBe("orchestrator");
    });
  });

  describe("writeRoles", () => {
    it("reads team.yaml and writes roles.json", () => {
      const templateDir = path.join(tmpDir, "template");
      const outputPath = path.join(tmpDir, "map", "roles.json");
      writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "my-team", roles: ["a", "b"] }));

      const result = writeRoles(templateDir, outputPath);
      expect(result).not.toBeNull();
      expect(result.team).toBe("my-team");
      expect(result.roles).toEqual(["a", "b"]);

      const written = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      expect(written.team).toBe("my-team");
    });

    it("extracts root role from topology", () => {
      const templateDir = path.join(tmpDir, "template");
      const outputPath = path.join(tmpDir, "map", "roles.json");
      writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "t", roles: ["lead", "dev"] }));

      const result = writeRoles(templateDir, outputPath);
      expect(result.root).toBe("lead");
    });

    it("extracts companion roles", () => {
      const templateDir = path.join(tmpDir, "template");
      const outputPath = path.join(tmpDir, "map", "roles.json");
      writeFile(templateDir, "team.yaml", makeTeamYaml({
        name: "t", roles: ["lead", "dev", "qa"], companions: ["dev"],
      }));

      const result = writeRoles(templateDir, outputPath);
      expect(result.companions).toEqual(["dev"]);
    });

    it("returns null when team.yaml is missing", () => {
      const result = writeRoles(path.join(tmpDir, "missing"), path.join(tmpDir, "out.json"));
      expect(result).toBeNull();
    });
  });
});
