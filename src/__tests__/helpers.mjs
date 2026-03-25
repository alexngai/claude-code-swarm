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
      swarmId: overrides.swarmId ?? "",
      auth: {
        token: overrides.authToken ?? "",
        param: overrides.authParam ?? "token",
        credential: overrides.authCredential ?? "",
      },
    },
    sessionlog: {
      enabled: overrides.sessionlogEnabled ?? false,
      sync: overrides.sessionlogSync ?? "off",
      mode: overrides.sessionlogMode ?? "auto",
    },
    opentasks: {
      enabled: overrides.opentasksEnabled ?? false,
      autoStart: overrides.opentasksAutoStart ?? true,
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

export function makeSubagentStartData(overrides = {}) {
  return {
    session_id: overrides.sessionId ?? "session-123",
    transcript_path: overrides.transcriptPath ?? "/tmp/transcript.jsonl",
    cwd: overrides.cwd ?? "/tmp",
    permission_mode: overrides.permissionMode ?? "default",
    hook_event_name: "SubagentStart",
    agent_id: overrides.agentId ?? "agent-abc123",
    agent_type: overrides.agentType ?? "Explore",
  };
}

export function makeSubagentStopData(overrides = {}) {
  return {
    session_id: overrides.sessionId ?? "session-123",
    transcript_path: overrides.transcriptPath ?? "/tmp/transcript.jsonl",
    cwd: overrides.cwd ?? "/tmp",
    permission_mode: overrides.permissionMode ?? "default",
    hook_event_name: "SubagentStop",
    stop_hook_active: overrides.stopHookActive ?? false,
    agent_id: overrides.agentId ?? "agent-def456",
    agent_type: overrides.agentType ?? "Explore",
    agent_transcript_path: overrides.agentTranscriptPath ?? "/tmp/subagents/agent-def456.jsonl",
    last_assistant_message: overrides.lastAssistantMessage ?? "Analysis complete.",
  };
}

export function makeTeammateIdleData(overrides = {}) {
  return {
    session_id: overrides.sessionId ?? "session-123",
    transcript_path: overrides.transcriptPath ?? "/tmp/transcript.jsonl",
    cwd: overrides.cwd ?? "/tmp",
    permission_mode: overrides.permissionMode ?? "default",
    hook_event_name: "TeammateIdle",
    teammate_name: overrides.teammateName ?? "researcher",
    team_name: overrides.teamName ?? "my-team",
  };
}

export function makeTaskCompletedData(overrides = {}) {
  return {
    session_id: overrides.sessionId ?? "session-123",
    transcript_path: overrides.transcriptPath ?? "/tmp/transcript.jsonl",
    cwd: overrides.cwd ?? "/tmp",
    permission_mode: overrides.permissionMode ?? "default",
    hook_event_name: "TaskCompleted",
    task_id: overrides.taskId ?? "task-001",
    task_subject: overrides.taskSubject ?? "Implement feature",
    task_description: overrides.taskDescription ?? "Add the new feature",
    teammate_name: overrides.teammateName ?? "implementer",
    team_name: overrides.teamName ?? "my-team",
  };
}

export function makeOpentasksMcpHookData(overrides = {}) {
  return {
    session_id: overrides.sessionId ?? "session-123",
    tool_name: overrides.toolName ?? "mcp__opentasks__update",
    tool_input: overrides.toolInput ?? { target: "task://test/1", status: "open" },
    tool_output: overrides.toolOutput ?? "{}",
  };
}

export function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
