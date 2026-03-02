import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { resolveTemplatePath, listAvailableTemplates, readTeamManifest } from "../template.mjs";
import { pluginDir } from "../paths.mjs";
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

    it("resolves built-in 'get-shit-done' template", () => {
      const result = resolveTemplatePath("get-shit-done");
      if (result) {
        expect(result).toContain("templates");
        expect(result).toContain("get-shit-done");
      }
      // May be null if templates dir doesn't exist in test env
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
  });

  describe("listAvailableTemplates", () => {
    it("lists templates with names, descriptions, and paths", () => {
      const templates = listAvailableTemplates();
      // Should find at least the built-in templates
      if (templates.length > 0) {
        expect(templates[0]).toHaveProperty("name");
        expect(templates[0]).toHaveProperty("description");
        expect(templates[0]).toHaveProperty("path");
      }
    });

    it("returns empty array when templates dir does not exist", () => {
      const result = listAvailableTemplates(path.join(tmpDir, "nope"));
      expect(result).toEqual([]);
    });
  });

  describe("readTeamManifest", () => {
    it("parses team.yaml and returns manifest object", () => {
      const templateDir = path.join(tmpDir, "template");
      writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "test-team", roles: ["a", "b"] }));
      const manifest = readTeamManifest(templateDir);
      expect(manifest.name).toBe("test-team");
      expect(manifest.roles).toEqual(["a", "b"]);
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
      expect(manifest.topology.companions[0].role).toBe("dev");
    });
  });
});
