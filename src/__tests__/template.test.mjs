import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { resolveTemplatePath, listAvailableTemplates, readTeamManifest, generateTeamArtifacts } from "../template.mjs";
import { makeTmpDir, writeFile, makeTeamYaml, cleanupTmpDir } from "./helpers.mjs";

describe("template", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanupTmpDir(tmpDir); });

  describe("resolveTemplatePath", () => {
    it("returns absolute path when nameOrPath is an existing directory", () => {
      const dir = path.join(tmpDir, "my-template");
      fs.mkdirSync(dir);
      const result = resolveTemplatePath(dir);
      expect(result).toBe(dir);
    });

    it("returns null when template is not found", () => {
      const result = resolveTemplatePath("nonexistent-template-12345");
      expect(result).toBeNull();
    });

    it("resolves relative paths", () => {
      const dir = path.join(tmpDir, "rel-template");
      fs.mkdirSync(dir);
      const result = resolveTemplatePath(dir);
      expect(result).toBe(path.resolve(dir));
    });

    it("resolves built-in template names via openteams", () => {
      // openteams ships built-in templates like gsd, bmad-method
      const result = resolveTemplatePath("gsd");
      if (result) {
        expect(result).toContain("gsd");
        expect(fs.existsSync(path.join(result, "team.yaml"))).toBe(true);
      }
    });
  });

  describe("listAvailableTemplates", () => {
    it("returns an array", () => {
      const templates = listAvailableTemplates();
      expect(Array.isArray(templates)).toBe(true);
    });

    it("templates have name, description, and path", () => {
      const templates = listAvailableTemplates();
      if (templates.length > 0) {
        expect(templates[0]).toHaveProperty("name");
        expect(templates[0]).toHaveProperty("description");
        expect(templates[0]).toHaveProperty("path");
      }
    });

    it("includes built-in templates when openteams is available", () => {
      const templates = listAvailableTemplates();
      // openteams 0.2.2+ ships built-in templates
      if (templates.length > 0) {
        const names = templates.map((t) => t.name);
        expect(names.some((n) => n === "gsd" || n === "bmad-method")).toBe(true);
      }
    });
  });

  describe("readTeamManifest", () => {
    it("parses team.yaml and returns manifest object", () => {
      const templateDir = path.join(tmpDir, "template");
      writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "test-team", roles: ["a", "b"] }));
      const manifest = readTeamManifest(templateDir);
      expect(manifest.name).toBe("test-team");
    });

    it("throws when team.yaml does not exist", () => {
      expect(() => readTeamManifest(path.join(tmpDir, "missing"))).toThrow();
    });

    it("parses topology section", () => {
      const templateDir = path.join(tmpDir, "template");
      writeFile(templateDir, "team.yaml", makeTeamYaml({
        name: "t", roles: ["lead", "dev"], companions: ["dev"],
      }));
      const manifest = readTeamManifest(templateDir);
      expect(manifest.topology.root.role).toBe("lead");
    });
  });

  describe("generateTeamArtifacts", () => {
    it("generates SKILL.md and agent prompts for a valid template", () => {
      const templatePath = resolveTemplatePath("gsd");
      if (!templatePath) return; // skip if openteams not available

      const outputDir = path.join(tmpDir, "output");
      const result = generateTeamArtifacts(templatePath, outputDir);

      expect(result.success).toBe(true);
      expect(result.teamName).toBe("gsd");
      expect(fs.existsSync(path.join(outputDir, "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "agents"))).toBe(true);
    });

    it("returns error for nonexistent template path", () => {
      const result = generateTeamArtifacts(path.join(tmpDir, "nope"), path.join(tmpDir, "out"));
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });
});
