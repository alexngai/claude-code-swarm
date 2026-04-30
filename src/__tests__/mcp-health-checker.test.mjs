import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  checkMcpHealth,
  collectScopeReferences,
  discoverActiveSet,
  formatHealthReport,
} from "../mcp-health-checker.mjs";

describe("checkMcpHealth", () => {
  it("classifies declared servers as ok when active", () => {
    const report = checkMcpHealth({
      providers: new Map([
        ["ast-grep", { command: "npx", args: ["ast-grep-mcp"] }],
      ]),
      activeSet: new Map([
        ["ast-grep", { source: "project", spec: { command: "npx" } }],
      ]),
    });

    expect(report.ok).toEqual([
      expect.objectContaining({ name: "ast-grep", source: "project" }),
    ]);
    expect(report.missing).toEqual([]);
  });

  it("classifies declared-but-not-active servers as missing", () => {
    const report = checkMcpHealth({
      providers: {
        "chrome-devtools": { command: "npx", args: ["chrome-devtools-mcp"] },
      },
      activeSet: new Map(),
    });

    expect(report.missing).toEqual([
      expect.objectContaining({ name: "chrome-devtools" }),
    ]);
    expect(report.ok).toEqual([]);
  });

  it("separates ref providers from concrete providers", () => {
    const report = checkMcpHealth({
      providers: {
        "secrets-scanner": { ref: "@openhive/secrets-scanner" },
        "ast-grep": { command: "npx" },
      },
      activeSet: new Map([
        ["ast-grep", { source: "user" }],
      ]),
    });

    expect(report.refs).toEqual([
      expect.objectContaining({
        name: "secrets-scanner",
        ref: "@openhive/secrets-scanner",
      }),
    ]);
    expect(report.ok).toEqual([
      expect.objectContaining({ name: "ast-grep", source: "user" }),
    ]);
  });

  it("treats disabled providers as a distinct category", () => {
    const report = checkMcpHealth({
      providers: {
        "ast-grep": { command: "npx", disabled: true },
      },
      activeSet: new Map(),
    });

    expect(report.disabled).toEqual([
      expect.objectContaining({ name: "ast-grep" }),
    ]);
    expect(report.missing).toEqual([]);
  });

  it("surfaces active servers not declared as activeOnly", () => {
    const report = checkMcpHealth({
      providers: new Map(),
      activeSet: new Map([
        ["opentasks", { source: "plugin" }],
        ["agent-inbox", { source: "plugin" }],
      ]),
    });

    expect(report.activeOnly.map((a) => a.name).sort()).toEqual([
      "agent-inbox",
      "opentasks",
    ]);
  });

  it("flags scope references to servers not in providers or active", () => {
    const report = checkMcpHealth({
      providers: {
        "ast-grep": { command: "npx" },
      },
      activeSet: new Map([["ast-grep", { source: "project" }]]),
      scopeReferences: [
        { loadout: "code-reviewer", server: "ast-grep" }, // backed
        { loadout: "debug-flow", server: "missing-thing" }, // orphan
      ],
    });

    expect(report.orphanedReferences).toEqual([
      { loadout: "debug-flow", server: "missing-thing" },
    ]);
  });

  it("accepts both Map and plain-object inputs", () => {
    const r1 = checkMcpHealth({
      providers: { x: { command: "y" } },
      activeSet: { x: { source: "user" } },
    });
    const r2 = checkMcpHealth({
      providers: new Map([["x", { command: "y" }]]),
      activeSet: new Map([["x", { source: "user" }]]),
    });

    expect(r1.ok).toHaveLength(1);
    expect(r2.ok).toHaveLength(1);
  });
});

describe("collectScopeReferences", () => {
  it("extracts scope references from a loadouts map", () => {
    const loadouts = new Map([
      [
        "reviewer",
        {
          mcpScope: [
            { server: "ast-grep" },
            { server: "chrome-devtools", tools: ["navigate"] },
          ],
        },
      ],
      ["planner", { mcpScope: [] }],
      ["implementer", { mcpScope: [{ server: "filesystem" }] }],
    ]);

    const refs = collectScopeReferences(loadouts);
    expect(refs).toEqual([
      { loadout: "reviewer", server: "ast-grep" },
      { loadout: "reviewer", server: "chrome-devtools" },
      { loadout: "implementer", server: "filesystem" },
    ]);
  });

  it("accepts plain-object loadouts", () => {
    const refs = collectScopeReferences({
      x: { mcpScope: [{ server: "a" }] },
    });
    expect(refs).toEqual([{ loadout: "x", server: "a" }]);
  });

  it("returns empty array for empty input", () => {
    expect(collectScopeReferences()).toEqual([]);
    expect(collectScopeReferences(new Map())).toEqual([]);
  });
});

describe("discoverActiveSet", () => {
  let tmpProject;
  let tmpHome;
  let tmpPlugin;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-proj-"));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-home-"));
    tmpPlugin = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-plugin-"));
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpPlugin, { recursive: true, force: true });
  });

  function writeJson(p, obj) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj));
  }

  it("returns empty map when no sources exist", () => {
    const result = discoverActiveSet({
      projectPath: tmpProject,
      pluginPath: tmpPlugin,
      userHome: tmpHome,
    });
    expect(result.size).toBe(0);
  });

  it("reads plugin.json mcpServers with source=plugin", () => {
    writeJson(path.join(tmpPlugin, ".claude-plugin", "plugin.json"), {
      mcpServers: { opentasks: { command: "node" } },
    });

    const result = discoverActiveSet({
      projectPath: tmpProject,
      pluginPath: tmpPlugin,
      userHome: tmpHome,
    });

    expect(result.get("opentasks")).toEqual(
      expect.objectContaining({ source: "plugin" })
    );
  });

  it("reads project .mcp.json with source=project", () => {
    writeJson(path.join(tmpProject, ".mcp.json"), {
      mcpServers: { "ast-grep": { command: "npx" } },
    });

    const result = discoverActiveSet({
      projectPath: tmpProject,
      pluginPath: tmpPlugin,
      userHome: tmpHome,
    });

    expect(result.get("ast-grep")).toEqual(
      expect.objectContaining({ source: "project" })
    );
  });

  it("reads ~/.claude/mcp.json with source=user", () => {
    writeJson(path.join(tmpHome, ".claude", "mcp.json"), {
      mcpServers: { "my-mcp": { command: "node" } },
    });

    const result = discoverActiveSet({
      projectPath: tmpProject,
      pluginPath: tmpPlugin,
      userHome: tmpHome,
    });

    expect(result.get("my-mcp")).toEqual(
      expect.objectContaining({ source: "user" })
    );
  });

  it("project overrides user overrides plugin on name conflict", () => {
    writeJson(path.join(tmpPlugin, ".claude-plugin", "plugin.json"), {
      mcpServers: { fs: { command: "plugin-fs" } },
    });
    writeJson(path.join(tmpHome, ".claude", "mcp.json"), {
      mcpServers: { fs: { command: "user-fs" } },
    });
    writeJson(path.join(tmpProject, ".mcp.json"), {
      mcpServers: { fs: { command: "project-fs" } },
    });

    const result = discoverActiveSet({
      projectPath: tmpProject,
      pluginPath: tmpPlugin,
      userHome: tmpHome,
    });

    expect(result.get("fs")).toEqual(
      expect.objectContaining({
        source: "project",
        spec: { command: "project-fs" },
      })
    );
  });

  it("silently skips malformed JSON", () => {
    const mcpPath = path.join(tmpProject, ".mcp.json");
    fs.writeFileSync(mcpPath, "{not valid json]");

    const result = discoverActiveSet({
      projectPath: tmpProject,
      pluginPath: tmpPlugin,
      userHome: tmpHome,
    });

    expect(result.size).toBe(0);
  });
});

describe("formatHealthReport", () => {
  it("renders a header with the team name", () => {
    const report = checkMcpHealth({
      providers: new Map([["x", { command: "y" }]]),
      activeSet: new Map(),
    });
    const out = formatHealthReport(report, { teamName: "demo" });
    expect(out).toContain('Team "demo" MCP status');
  });

  it("marks ok entries with a checkmark and source", () => {
    const report = checkMcpHealth({
      providers: { "ast-grep": { command: "npx" } },
      activeSet: new Map([["ast-grep", { source: "project" }]]),
    });
    const out = formatHealthReport(report);
    expect(out).toContain("✓ ast-grep");
    expect(out).toContain("(project)");
  });

  it("marks missing with warning and an actionable hint", () => {
    const report = checkMcpHealth({
      providers: { "chrome-devtools": { command: "npx" } },
      activeSet: new Map(),
    });
    const out = formatHealthReport(report);
    expect(out).toContain("⚠ chrome-devtools");
    expect(out).toContain("/swarm mcp install chrome-devtools");
  });

  it("surfaces orphaned scope references in a dedicated section", () => {
    const report = checkMcpHealth({
      providers: new Map(),
      activeSet: new Map(),
      scopeReferences: [{ loadout: "x", server: "missing" }],
    });
    const out = formatHealthReport(report);
    expect(out).toContain("not backed by any provider");
    expect(out).toContain('loadout "x" uses "missing"');
  });

  it("falls back to a neutral message when nothing is declared", () => {
    const report = checkMcpHealth({ providers: new Map(), activeSet: new Map() });
    const out = formatHealthReport(report);
    expect(out).toContain("no MCP providers declared");
  });
});
