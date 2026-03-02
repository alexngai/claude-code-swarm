import fs from "fs";
import path from "path";
import os from "os";

export function makeTmpDir(prefix = "swarm-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(baseDir, relPath, content) {
  const full = path.join(baseDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

export function makeConfig(overrides = {}) {
  return {
    template: overrides.template ?? "test-team",
    map: {
      enabled: overrides.mapEnabled ?? false,
      server: overrides.server ?? "ws://localhost:8080",
      scope: overrides.scope ?? "",
      systemId: overrides.systemId ?? "system-claude-swarm",
      sidecar: overrides.sidecar ?? "session",
    },
    sessionlog: {
      enabled: overrides.sessionlogEnabled ?? false,
      sync: overrides.sessionlogSync ?? "off",
    },
  };
}

export function makeTeamYaml(overrides = {}) {
  const name = overrides.name ?? "test-team";
  const roles = overrides.roles ?? ["lead", "worker"];
  const lines = [
    `name: ${name}`,
    `description: "Test team"`,
    `version: 1`,
    `roles:`,
    ...roles.map((r) => `  - ${r}`),
    `topology:`,
    `  root:`,
    `    role: ${roles[0]}`,
  ];
  if (overrides.companions?.length) {
    lines.push(`  companions:`);
    for (const c of overrides.companions) {
      lines.push(`    - role: ${c}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function makeRoles(overrides = {}) {
  return {
    team: overrides.team ?? "test-team",
    roles: overrides.roles ?? ["lead", "worker"],
    root: overrides.root ?? "lead",
    companions: overrides.companions ?? [],
  };
}

export function makeHookData(overrides = {}) {
  return {
    tool_input: {
      name: overrides.name ?? "test-agent",
      prompt: overrides.prompt ?? "Do something",
      description: overrides.description ?? "An agent",
    },
    tool_use_id: overrides.toolUseId ?? "tool-123",
    stop_reason: overrides.stopReason ?? "end_turn",
  };
}

export function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
