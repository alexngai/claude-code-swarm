import { describe, it, expect } from "vitest";
import {
  buildFrontmatter,
  buildScopeFile,
  materializeLoadout,
  resolveMcpScope,
  scopeNeedsHook,
} from "../loadout-materializer.mjs";

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

function makeRole(overrides = {}) {
  return {
    name: "reviewer",
    description: "Reviews code and proposes improvements",
    displayName: "Reviewer",
    ...overrides,
  };
}

function makeLoadout(overrides = {}) {
  return {
    name: "reviewer-loadout",
    description: "Reviewer loadout",
    skills: { profile: "code-reviewer" },
    capabilities: ["file.read", "git.diff"],
    capabilityConfig: undefined,
    mcpServers: [],
    mcpScope: [],
    permissions: {},
    promptAddendum: undefined,
    raw: {},
    ...overrides,
  };
}

function makeTemplate(overrides = {}) {
  return {
    manifest: { name: "loadout-demo", version: 1, roles: ["reviewer"], topology: { root: { role: "reviewer" } } },
    mcpProviders: new Map(),
    roles: new Map(),
    loadouts: new Map(),
    prompts: new Map(),
    mcpServers: new Map(),
    sourcePath: "",
    ...overrides,
  };
}

function commonOptions(overrides = {}) {
  return {
    teamName: "loadout-demo",
    projectPath: "/abs/project",
    scopeFilePath: ".swarm/claude-swarm/tmp/teams/loadout-demo/scope/reviewer.json",
    hookCommand: "${CLAUDE_PLUGIN_ROOT}/hooks/scope-check.mjs",
    nativeTools: ["Read", "Grep", "Glob", "Bash"],
    position: "companion",
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────

describe("materializeLoadout — input validation", () => {
  it("throws when role.name is missing", () => {
    expect(() =>
      materializeLoadout({
        role: {},
        loadout: makeLoadout(),
        template: makeTemplate(),
      })
    ).toThrow(/role\.name is required/);
  });
});

// ────────────────────────────────────────────────────────────
// No-loadout path
// ────────────────────────────────────────────────────────────

describe("materializeLoadout — role with no loadout", () => {
  it("produces frontmatter without mcp-related fields", () => {
    const { frontmatter, scopeFile, warnings } = materializeLoadout({
      role: makeRole(),
      loadout: undefined,
      template: makeTemplate(),
      options: commonOptions(),
    });

    expect(frontmatter.name).toBe("loadout-demo-reviewer");
    expect(frontmatter.team_name).toBe("loadout-demo");
    expect(frontmatter.role).toBe("reviewer");
    expect(frontmatter.generated_by).toBe("claude-code-swarm");
    expect(typeof frontmatter.generated_at).toBe("string");
    expect(frontmatter.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);

    expect(frontmatter.mcpServers).toBeUndefined();
    expect(frontmatter.disallowedTools).toBeUndefined();
    expect(frontmatter.hooks).toBeUndefined();
    expect(frontmatter.capabilities).toBeUndefined();

    expect(scopeFile.scope).toEqual([]);
    expect(scopeFile.permissions).toEqual({ allow: [], deny: [], ask: [] });
    expect(warnings).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// Scope-only entries
// ────────────────────────────────────────────────────────────

describe("materializeLoadout — scope-only entries", () => {
  it("emits mcpServers as string refs for bare scope entries", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({
        mcpScope: [{ server: "opentasks" }, { server: "ast-grep" }],
      }),
      template: makeTemplate(),
      options: commonOptions(),
    });

    expect(frontmatter.mcpServers).toEqual(["opentasks", "ast-grep"]);
  });

  it("emits disallowedTools from exclude entries", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({
        mcpScope: [
          { server: "ast-grep", exclude: ["dangerous_replace", "reckless"] },
          { server: "chrome-devtools" },
        ],
      }),
      template: makeTemplate(),
      options: commonOptions(),
    });

    expect(frontmatter.mcpServers).toEqual(["ast-grep", "chrome-devtools"]);
    expect(frontmatter.disallowedTools).toEqual([
      "mcp__ast-grep__dangerous_replace",
      "mcp__ast-grep__reckless",
    ]);
  });

  it("records tools allowlists in the scope file for hook enforcement", () => {
    const { frontmatter, scopeFile } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({
        mcpScope: [
          { server: "chrome-devtools", tools: ["navigate", "screenshot"] },
        ],
      }),
      template: makeTemplate(),
      options: commonOptions(),
    });

    expect(frontmatter.mcpServers).toEqual(["chrome-devtools"]);
    expect(frontmatter.hooks).toBeDefined();
    expect(scopeFile.scope).toEqual([
      { server: "chrome-devtools", tools: ["navigate", "screenshot"] },
    ]);
  });
});

// ────────────────────────────────────────────────────────────
// Install specs
// ────────────────────────────────────────────────────────────

describe("materializeLoadout — install specs and refs", () => {
  it("emits inline install specs as object entries with a warning", () => {
    const { frontmatter, warnings } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({
        mcpServers: [
          { name: "bespoke", command: "node", args: ["./my.js"] },
        ],
        mcpScope: [],
      }),
      template: makeTemplate(),
      options: commonOptions(),
    });

    expect(frontmatter.mcpServers).toEqual([
      { bespoke: { command: "node", args: ["./my.js"] } },
    ]);
    expect(warnings.some((w) => w.includes("bespoke"))).toBe(true);
    expect(warnings.some((w) => w.includes("subprocess"))).toBe(true);
  });

  it("captures refs separately via resolveMcpScope (not placed in frontmatter)", () => {
    const warnings = [];
    const res = resolveMcpScope({
      mcpScope: [],
      mcpInstalls: [
        { ref: "@openhive/secrets-scanner", config: { apiKey: "$SECRET" } },
      ],
      warnings,
      roleName: "reviewer",
    });

    expect(res.mcpServers).toEqual([]);
    expect(res.refs).toEqual([
      { ref: "@openhive/secrets-scanner", config: { apiKey: "$SECRET" } },
    ]);
  });

  it("does not duplicate servers when install + scope reference the same name", () => {
    const warnings = [];
    const res = resolveMcpScope({
      mcpScope: [{ server: "opentasks" }],
      mcpInstalls: [
        { name: "opentasks", command: "node", args: ["./ot.js"] },
      ],
      warnings,
      roleName: "reviewer",
    });

    expect(res.mcpServers).toHaveLength(1);
    // Install entry emits the inline form; the bare scope ref is collapsed into it.
    expect(res.mcpServers[0]).toEqual({
      opentasks: { command: "node", args: ["./ot.js"] },
    });
  });
});

// ────────────────────────────────────────────────────────────
// Permissions → scope file
// ────────────────────────────────────────────────────────────

describe("materializeLoadout — permissions flow to scope file", () => {
  it("copies allow/deny/ask lists to scopeFile.permissions", () => {
    const { scopeFile } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({
        permissions: {
          allow: ["Read(**)"],
          deny: ["Bash(git push:*)"],
          ask: ["Write(.env)"],
        },
      }),
      template: makeTemplate(),
      options: commonOptions(),
    });

    expect(scopeFile.permissions).toEqual({
      allow: ["Read(**)"],
      deny: ["Bash(git push:*)"],
      ask: ["Write(.env)"],
    });
  });

  it("leaves empty-list fields populated as [] (not undefined)", () => {
    const { scopeFile } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({ permissions: {} }),
      template: makeTemplate(),
      options: commonOptions(),
    });

    expect(scopeFile.permissions.allow).toEqual([]);
    expect(scopeFile.permissions.deny).toEqual([]);
    expect(scopeFile.permissions.ask).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// Hooks — only when needed
// ────────────────────────────────────────────────────────────

describe("scopeNeedsHook", () => {
  it("returns true when any scope entry has tools", () => {
    expect(
      scopeNeedsHook(
        { scope: [{ server: "x", tools: ["a"] }] },
        {}
      )
    ).toBe(true);
  });

  it("returns true when loadout has permissions.allow/deny/ask", () => {
    expect(
      scopeNeedsHook({ scope: [] }, { permissions: { allow: ["Read(**)"] } })
    ).toBe(true);
    expect(
      scopeNeedsHook({ scope: [] }, { permissions: { deny: ["X"] } })
    ).toBe(true);
    expect(
      scopeNeedsHook({ scope: [] }, { permissions: { ask: ["Y"] } })
    ).toBe(true);
  });

  it("returns false when only bare server refs + empty permissions", () => {
    expect(
      scopeNeedsHook({ scope: [{ server: "x" }] }, { permissions: {} })
    ).toBe(false);
  });

  it("returns false for exclude-only scope (handled by disallowedTools)", () => {
    expect(
      scopeNeedsHook(
        { scope: [{ server: "x", exclude: ["y"] }] },
        { permissions: {} }
      )
    ).toBe(false);
  });
});

describe("materializeLoadout — hook frontmatter emission", () => {
  it("omits hooks when scope needs no enforcement", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({
        mcpScope: [{ server: "opentasks" }],
      }),
      template: makeTemplate(),
      options: commonOptions(),
    });

    expect(frontmatter.hooks).toBeUndefined();
  });

  it("emits PreToolUse hook with env vars pointing at scope file", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({
        mcpScope: [{ server: "chrome-devtools", tools: ["navigate"] }],
      }),
      template: makeTemplate(),
      options: commonOptions(),
    });

    expect(frontmatter.hooks?.PreToolUse).toBeDefined();
    const entry = frontmatter.hooks.PreToolUse[0];
    expect(entry.matcher).toBe("mcp__.*");
    expect(entry.hooks[0].type).toBe("command");
    expect(entry.hooks[0].env.SCOPE_FILE).toBe(
      ".swarm/claude-swarm/tmp/teams/loadout-demo/scope/reviewer.json"
    );
    expect(entry.hooks[0].env.ROLE_NAME).toBe("reviewer");
  });

  it("omits hook block when hookCommand or scopeFilePath missing", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({
        mcpScope: [{ server: "chrome-devtools", tools: ["navigate"] }],
      }),
      template: makeTemplate(),
      options: commonOptions({ hookCommand: null, scopeFilePath: null }),
    });

    expect(frontmatter.hooks).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// Capabilities pass-through
// ────────────────────────────────────────────────────────────

describe("materializeLoadout — capabilities", () => {
  it("copies loadout.capabilities to frontmatter", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({
        capabilities: ["file.read", "git.diff", "exec.test"],
      }),
      template: makeTemplate(),
      options: commonOptions(),
    });

    expect(frontmatter.capabilities).toEqual([
      "file.read",
      "git.diff",
      "exec.test",
    ]);
  });
});

// ────────────────────────────────────────────────────────────
// Provider map flexibility
// ────────────────────────────────────────────────────────────

describe("provider-map acceptance", () => {
  it("accepts template.mcpProviders as Map", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({ mcpScope: [{ server: "opentasks" }] }),
      template: makeTemplate({
        mcpProviders: new Map([
          ["opentasks", { command: "node", args: ["./ot.js"] }],
        ]),
      }),
      options: commonOptions(),
    });

    expect(frontmatter.mcpServers).toEqual(["opentasks"]);
  });

  it("accepts template.mcpProviders as plain object (cached JSON form)", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({ mcpScope: [{ server: "opentasks" }] }),
      template: makeTemplate({
        mcpProviders: { opentasks: { command: "node", args: ["./ot.js"] } },
      }),
      options: commonOptions(),
    });

    expect(frontmatter.mcpServers).toEqual(["opentasks"]);
  });
});

// ────────────────────────────────────────────────────────────
// Ordering + determinism
// ────────────────────────────────────────────────────────────

describe("frontmatter order + shape", () => {
  it("places identity keys before tool/scope keys for readability", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout({
        mcpScope: [{ server: "opentasks" }],
        capabilities: ["file.read"],
      }),
      template: makeTemplate(),
      options: commonOptions(),
    });

    const keys = Object.keys(frontmatter);
    expect(keys.indexOf("name")).toBeLessThan(keys.indexOf("tools"));
    expect(keys.indexOf("team_name")).toBeLessThan(keys.indexOf("mcpServers"));
    expect(keys.indexOf("role")).toBeLessThan(keys.indexOf("capabilities"));
  });

  it("emits project_path when provided", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout(),
      template: makeTemplate(),
      options: commonOptions({ projectPath: "/Users/alice/proj" }),
    });

    expect(frontmatter.project_path).toBe("/Users/alice/proj");
  });

  it("omits project_path when not provided", () => {
    const { frontmatter } = materializeLoadout({
      role: makeRole(),
      loadout: makeLoadout(),
      template: makeTemplate(),
      options: commonOptions({ projectPath: undefined }),
    });

    expect("project_path" in frontmatter).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// End-to-end — loadout-demo shape
// ────────────────────────────────────────────────────────────

describe("end-to-end — loadout-demo reviewer role", () => {
  it("materializes a realistic inline-extended loadout", () => {
    // Mimics the reviewer role from openteams/examples/loadout-demo/
    const loadout = {
      name: "__inline:reviewer",
      description: "Security-focused extension of code-reviewer",
      skills: {
        profile: "security-engineer",
        include: ["review-style-guide", "owasp-top-10", "secrets-detection"],
        max_tokens: 30000,
      },
      capabilities: [
        "file.read",
        "git.diff",
        "codebase.search",
        "exec.test",
        "task.update",
      ],
      mcpServers: [{ ref: "@openhive/secrets-scanner" }],
      mcpScope: [
        { server: "ast-grep" },
        { server: "chrome-devtools", tools: ["navigate", "screenshot", "get_page_text"] },
      ],
      permissions: {
        allow: ["Read(**)", "Bash(git diff:*)", "Bash(npm audit:*)"],
        deny: ["Bash(git push:*)", "Bash(rm -rf:*)", "Bash(curl *:*)"],
      },
      promptAddendum: "## Review Mindset\n- Cite line numbers\n",
      raw: {},
    };

    const { frontmatter, scopeFile, warnings } = materializeLoadout({
      role: makeRole(),
      loadout,
      template: makeTemplate({
        mcpProviders: new Map([
          ["ast-grep", { command: "npx", args: ["ast-grep-mcp"] }],
          ["chrome-devtools", { command: "npx", args: ["chrome-devtools-mcp"] }],
        ]),
      }),
      options: commonOptions(),
    });

    // Name + identity
    expect(frontmatter.name).toBe("loadout-demo-reviewer");
    expect(frontmatter.team_name).toBe("loadout-demo");

    // MCP scope: bare refs for both servers
    expect(frontmatter.mcpServers).toEqual(["ast-grep", "chrome-devtools"]);

    // No disallowedTools because no exclude fields on scope entries
    expect(frontmatter.disallowedTools).toBeUndefined();

    // Hook needed because chrome-devtools has a tools allowlist
    expect(frontmatter.hooks?.PreToolUse).toBeDefined();

    // Scope file: both servers, chrome-devtools with tool allowlist
    expect(scopeFile.scope).toEqual([
      { server: "ast-grep" },
      {
        server: "chrome-devtools",
        tools: ["navigate", "screenshot", "get_page_text"],
      },
    ]);

    // Permissions flowed through
    expect(scopeFile.permissions.deny).toContain("Bash(git push:*)");
    expect(scopeFile.permissions.allow).toContain("Bash(npm audit:*)");

    // Capabilities
    expect(frontmatter.capabilities).toContain("task.update");
    expect(frontmatter.capabilities).toContain("exec.test");

    // No inline install warnings (only a ref)
    expect(warnings.filter((w) => w.includes("subprocess"))).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// buildScopeFile + buildFrontmatter directly
// ────────────────────────────────────────────────────────────

describe("buildScopeFile / buildFrontmatter — direct callers", () => {
  it("buildScopeFile tolerates undefined loadout", () => {
    const sf = buildScopeFile({
      role: makeRole(),
      loadout: undefined,
      mcp: { scope: [] },
      teamName: "t",
    });

    expect(sf.role).toBe("reviewer");
    expect(sf.permissions).toEqual({ allow: [], deny: [], ask: [] });
  });

  it("buildFrontmatter produces stable name format", () => {
    const fm = buildFrontmatter({
      role: { name: "planner" },
      loadout: undefined,
      teamName: "alpha",
      mcp: { mcpServers: [], disallowedTools: [] },
      scopeFilePath: null,
      hookCommand: null,
      projectPath: "/x",
      nativeTools: ["Read"],
      position: "root",
    });

    expect(fm.name).toBe("alpha-planner");
    expect(fm.team_name).toBe("alpha");
    expect(fm.position).toBe("root");
  });
});
