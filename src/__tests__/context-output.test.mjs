import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import {
  formatBootstrapContext,
  formatTeamLoadedContext,
  formatNoTemplateMessage,
  formatTemplateNotFoundMessage,
} from "../context-output.mjs";
import { makeTmpDir, writeFile, cleanupTmpDir } from "./helpers.mjs";

describe("context-output", () => {
  describe("formatBootstrapContext", () => {
    it("includes team template name when template is set", () => {
      const out = formatBootstrapContext({ template: "gsd" });
      expect(out).toContain("**gsd**");
    });

    it("shows 'No team template configured' when template is empty", () => {
      const out = formatBootstrapContext({ template: "" });
      expect(out).toContain("No team template configured");
    });

    it("includes MAP status when mapEnabled and mapStatus provided", () => {
      const out = formatBootstrapContext({ template: "t", mapEnabled: true, mapStatus: "connected (scope: swarm:t)" });
      expect(out).toContain("MAP: connected");
    });

    it("shows no observability when MAP is disabled", () => {
      const out = formatBootstrapContext({ template: "t", mapEnabled: false });
      expect(out).toContain("No external observability configured");
    });

    it("shows sessionlog sync level when MAP enabled and sync is not off", () => {
      const out = formatBootstrapContext({
        template: "t", mapEnabled: true, mapStatus: "connected", sessionlogStatus: "active", sessionlogSync: "full",
      });
      expect(out).toContain("trajectory checkpoints synced to MAP (level: full)");
    });

    it("omits sessionlog sync when sync is off", () => {
      const out = formatBootstrapContext({
        template: "t", mapEnabled: true, mapStatus: "connected", sessionlogStatus: "active", sessionlogSync: "off",
      });
      expect(out).not.toContain("trajectory checkpoints");
    });

    it("shows sessionlog WARNING when status is not active", () => {
      const out = formatBootstrapContext({
        template: "t", sessionlogStatus: "installed but not enabled",
      });
      expect(out).toContain("WARNING");
    });

    it("omits sessionlog line when status is 'not installed'", () => {
      const out = formatBootstrapContext({
        template: "t", sessionlogStatus: "not installed",
      });
      expect(out).not.toContain("Sessionlog:");
    });

    it("includes /swarm usage hint", () => {
      const out = formatBootstrapContext({ template: "t" });
      expect(out).toContain("/swarm");
    });

    it("includes openteams template names", () => {
      const out = formatBootstrapContext({ template: "t" });
      expect(out).toContain("gsd");
      expect(out).toContain("bmad-method");
    });
  });

  describe("formatTeamLoadedContext", () => {
    let tmpDir;
    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { cleanupTmpDir(tmpDir); });

    it("includes catalog content when SKILL.md exists", () => {
      writeFile(tmpDir, "SKILL.md", "# Team Catalog\nSome content");
      const out = formatTeamLoadedContext(tmpDir, "/path/to/template", "test-team");
      expect(out).toContain("Team Catalog");
    });

    it("omits catalog when SKILL.md does not exist", () => {
      const out = formatTeamLoadedContext(tmpDir, "/path/to/template", "test-team");
      expect(out).toContain("Agent Team Instructions");
    });

    it("includes template path in output", () => {
      const out = formatTeamLoadedContext(tmpDir, "/my/template", "test");
      expect(out).toContain("/my/template");
    });

    it("includes capabilities section with task and communication tools", () => {
      const out = formatTeamLoadedContext(tmpDir, "/t", "test");
      expect(out).toContain("Swarm Capabilities");
      expect(out).toContain("TaskCreate");
      expect(out).toContain("SendMessage");
    });
  });

  describe("formatNoTemplateMessage", () => {
    it("includes usage instructions", () => {
      const out = formatNoTemplateMessage([]);
      expect(out).toContain(".swarm/claude-swarm/config.json");
      expect(out).toContain("/swarm");
    });

    it("lists all provided templates", () => {
      const templates = [
        { name: "a", description: "Team A" },
        { name: "b", description: "Team B" },
      ];
      const out = formatNoTemplateMessage(templates);
      expect(out).toContain("**a**: Team A");
      expect(out).toContain("**b**: Team B");
    });

    it("handles empty templates array", () => {
      const out = formatNoTemplateMessage([]);
      expect(out).toContain("Available templates (via openteams):");
    });
  });

  describe("formatTemplateNotFoundMessage", () => {
    it("includes the template name in the warning", () => {
      const out = formatTemplateNotFoundMessage("my-missing-template");
      expect(out).toContain("my-missing-template");
      expect(out).toContain("not found");
    });

    it("suggests using /swarm command", () => {
      const out = formatTemplateNotFoundMessage("x");
      expect(out).toContain("/swarm");
    });
  });
});
