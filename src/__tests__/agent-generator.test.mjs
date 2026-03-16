import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { parseBasicYaml, determineTools, generateAgentMd, generateAllAgents } from "../agent-generator.mjs";
import { makeTmpDir, writeFile, makeTeamYaml, cleanupTmpDir } from "./helpers.mjs";

describe("agent-generator", () => {
  describe("parseBasicYaml", () => {
    it("extracts name field", () => {
      const result = parseBasicYaml("name: my-team\nversion: 1");
      expect(result.name).toBe("my-team");
    });

    it("extracts description field", () => {
      const result = parseBasicYaml('description: "A team"');
      expect(result.description).toBe("A team");
    });

    it("extracts roles list", () => {
      const yaml = "roles:\n  - lead\n  - dev\n  - qa\nother: value";
      const result = parseBasicYaml(yaml);
      expect(result.roles).toEqual(["lead", "dev", "qa"]);
    });

    it("handles quoted values", () => {
      const result = parseBasicYaml('name: "quoted-name"');
      expect(result.name).toBe("quoted-name");
    });

    it("stops collecting roles when encountering non-list key", () => {
      const yaml = "roles:\n  - a\n  - b\ntopology:\n  root: a";
      const result = parseBasicYaml(yaml);
      expect(result.roles).toEqual(["a", "b"]);
    });

    it("returns empty roles for YAML without roles section", () => {
      const result = parseBasicYaml("name: test\nversion: 1");
      expect(result.roles).toEqual([]);
    });
  });

  describe("determineTools", () => {
    const minManifest = { topology: {} };

    it("always includes Read, Glob, Grep, Bash", () => {
      const tools = determineTools("worker", minManifest, "spawned");
      expect(tools).toContain("Read");
      expect(tools).toContain("Glob");
      expect(tools).toContain("Grep");
      expect(tools).toContain("Bash");
    });

    it("always includes TaskList, TaskUpdate, SendMessage", () => {
      const tools = determineTools("worker", minManifest, "spawned");
      expect(tools).toContain("TaskList");
      expect(tools).toContain("TaskUpdate");
      expect(tools).toContain("SendMessage");
    });

    it("adds Write, Edit, TaskCreate for root position (no Agent)", () => {
      const tools = determineTools("lead", minManifest, "root");
      expect(tools).toContain("Write");
      expect(tools).toContain("Edit");
      expect(tools).toContain("TaskCreate");
      expect(tools).not.toContain("Agent");
    });

    it("adds Write, Edit, TaskCreate for companion position (no Agent)", () => {
      const tools = determineTools("helper", minManifest, "companion");
      expect(tools).toContain("Write");
      expect(tools).toContain("TaskCreate");
      expect(tools).not.toContain("Agent");
    });

    it("does not add Write for regular spawned position", () => {
      const tools = determineTools("worker", minManifest, "spawned");
      expect(tools).not.toContain("Write");
      expect(tools).not.toContain("Edit");
    });

    it("does not add Agent for spawn_rules (teammates cannot spawn)", () => {
      const manifest = { topology: { spawn_rules: { planner: ["executor"] } } };
      const tools = determineTools("planner", manifest, "spawned");
      expect(tools).not.toContain("Agent");
    });

    it("adds Write, Edit for executor role", () => {
      const tools = determineTools("executor", minManifest, "spawned");
      expect(tools).toContain("Write");
      expect(tools).toContain("Edit");
    });

    it("adds Write, Edit for developer role", () => {
      const tools = determineTools("developer", minManifest, "spawned");
      expect(tools).toContain("Write");
    });

    it("adds Write, Edit for debugger role", () => {
      const tools = determineTools("debugger", minManifest, "spawned");
      expect(tools).toContain("Write");
    });

    it("does not add Write for non-write roles like researcher", () => {
      const tools = determineTools("researcher", minManifest, "spawned");
      expect(tools).not.toContain("Write");
    });
  });

  describe("generateAgentMd", () => {
    const baseOpts = {
      roleName: "executor",
      teamName: "gsd",
      position: "spawned",
      description: "Executes tasks",
      tools: ["Read", "Write", "Bash"],
      skillContent: "# Executor\nYou execute things.",
      manifest: {},
    };

    it("generates frontmatter with name and description", () => {
      const md = generateAgentMd(baseOpts);
      expect(md).toContain("---");
      expect(md).toContain("name: gsd-executor");
      expect(md).toContain('description: "Executes tasks"');
    });

    it("includes model in frontmatter when provided", () => {
      const md = generateAgentMd({ ...baseOpts, model: "opus" });
      expect(md).toContain("model: opus");
    });

    it("omits model when not provided", () => {
      const md = generateAgentMd(baseOpts);
      expect(md).not.toContain("model:");
    });

    it("includes tools list in frontmatter", () => {
      const md = generateAgentMd(baseOpts);
      expect(md).toContain("tools: [Read, Write, Bash]");
    });

    it("includes skill content in body", () => {
      const md = generateAgentMd(baseOpts);
      expect(md).toContain("# Executor");
      expect(md).toContain("You execute things.");
    });

    it("includes capabilities section with team context", () => {
      const md = generateAgentMd(baseOpts);
      expect(md).toContain("## Swarm Capabilities");
      expect(md).toContain("**gsd** team");
    });

    it("includes communication in capabilities", () => {
      const md = generateAgentMd(baseOpts);
      expect(md).toContain("### Communication");
      expect(md).toContain("SendMessage");
    });

    it("includes task management in capabilities", () => {
      const md = generateAgentMd(baseOpts);
      expect(md).toContain("### Task Management");
      expect(md).toContain("TaskList");
    });

    it("includes TaskCreate in capabilities for all agents (general guidance)", () => {
      const md = generateAgentMd(baseOpts);
      expect(md).toContain("TaskCreate");
    });

    it("omits TaskCreate from frontmatter tools for spawned position", () => {
      const md = generateAgentMd(baseOpts);
      const frontmatter = md.split("---")[1];
      expect(frontmatter).not.toContain("TaskCreate");
    });

    it("includes MAP observability note", () => {
      const md = generateAgentMd(baseOpts);
      expect(md).toContain("External Observability");
    });

    it("escapes double quotes in description", () => {
      const md = generateAgentMd({ ...baseOpts, description: 'Says "hello"' });
      expect(md).toContain('description: "Says \\"hello\\""');
    });

    it("includes communication patterns from routing", () => {
      const manifest = {
        communication: {
          routing: {
            peers: [
              { from: "executor", to: "verifier", signals: ["done"] },
              { from: "planner", to: "executor", signals: ["plan-ready"] },
            ],
          },
        },
      };
      const md = generateAgentMd({ ...baseOpts, manifest });
      expect(md).toContain("**Send** done to **verifier**");
      expect(md).toContain("**Receive** plan-ready from **planner**");
    });

    it("includes emissions section", () => {
      const manifest = {
        communication: { emissions: { executor: ["task-done", "error"] } },
      };
      const md = generateAgentMd({ ...baseOpts, manifest });
      expect(md).toContain("**task-done**");
      expect(md).toContain("**error**");
    });

    it("includes subscriptions section", () => {
      const manifest = {
        communication: {
          subscriptions: { executor: [{ channel: "plans", signals: ["ready"] }] },
        },
      };
      const md = generateAgentMd({ ...baseOpts, manifest });
      expect(md).toContain("Channel **plans**: ready");
    });
  });

  describe("generateAllAgents", () => {
    let tmpDir;
    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { cleanupTmpDir(tmpDir); });

    it("returns error when team.yaml is missing", async () => {
      const result = await generateAllAgents(path.join(tmpDir, "missing"), path.join(tmpDir, "out"));
      expect(result.success).toBe(false);
      expect(result.error).toContain("team.yaml not found");
    });

    it("generates AGENT.md for each role in fallback mode", async () => {
      const templateDir = path.join(tmpDir, "template");
      const outputDir = path.join(tmpDir, "agents");
      writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "test", roles: ["lead", "dev"] }));

      const result = await generateAllAgents(templateDir, outputDir);
      expect(result.success).toBe(true);
      expect(result.roles).toEqual(["lead", "dev"]);
      expect(fs.existsSync(path.join(outputDir, "lead", "AGENT.md"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "dev", "AGENT.md"))).toBe(true);
    });

    it("reads role prompt from prompts directory", async () => {
      const templateDir = path.join(tmpDir, "template");
      const outputDir = path.join(tmpDir, "agents");
      writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "test", roles: ["lead"] }));
      writeFile(templateDir, "prompts/lead/ROLE.md", "You are the leader.");

      const result = await generateAllAgents(templateDir, outputDir);
      expect(result.success).toBe(true);
      const agentMd = fs.readFileSync(path.join(outputDir, "lead", "AGENT.md"), "utf-8");
      expect(agentMd).toContain("You are the leader.");
    });

    it("reads prompt.md as fallback", async () => {
      const templateDir = path.join(tmpDir, "template");
      const outputDir = path.join(tmpDir, "agents");
      writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "test", roles: ["dev"] }));
      writeFile(templateDir, "prompts/dev/prompt.md", "You are a developer.");

      const result = await generateAllAgents(templateDir, outputDir);
      const agentMd = fs.readFileSync(path.join(outputDir, "dev", "AGENT.md"), "utf-8");
      expect(agentMd).toContain("You are a developer.");
    });

    it("reads flat prompt file as fallback", async () => {
      const templateDir = path.join(tmpDir, "template");
      const outputDir = path.join(tmpDir, "agents");
      writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "test", roles: ["qa"] }));
      writeFile(templateDir, "prompts/qa.md", "You are QA.");

      const result = await generateAllAgents(templateDir, outputDir);
      const agentMd = fs.readFileSync(path.join(outputDir, "qa", "AGENT.md"), "utf-8");
      expect(agentMd).toContain("You are QA.");
    });

    it("generates content without prompt when no prompt file exists", async () => {
      const templateDir = path.join(tmpDir, "template");
      const outputDir = path.join(tmpDir, "agents");
      writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "test", roles: ["worker"] }));

      const result = await generateAllAgents(templateDir, outputDir);
      expect(result.success).toBe(true);
      const agentMd = fs.readFileSync(path.join(outputDir, "worker", "AGENT.md"), "utf-8");
      expect(agentMd).toContain("# Role: worker");
    });
  });
});
