/**
 * sessionlog.mjs — Sessionlog integration for claude-code-swarm
 *
 * Detects active sessionlog sessions, builds trajectory checkpoints,
 * syncs session data to MAP via the trajectory protocol, and annotates
 * sessions with swarm metadata for cross-session correlation.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { SESSIONLOG_DIR, SESSIONLOG_STATE_PATH, sessionPaths } from "./paths.mjs";
import { readConfig } from "./config.mjs";
import { resolveTeamName, resolveScope } from "./config.mjs";
import { sendToSidecar, ensureSidecar } from "./sidecar-client.mjs";
import { fireAndForgetTrajectory } from "./map-connection.mjs";
import { resolvePackage } from "./swarmkit-resolver.mjs";

/**
 * Get the current git branch name. Returns null if not in a git repo.
 */
function getGitBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if sessionlog is installed and active.
 * Returns 'active', 'installed but not enabled', or 'not installed'.
 */
export function checkSessionlogStatus() {
  try {
    execSync("which sessionlog", { stdio: "ignore" });
  } catch {
    return "not installed";
  }

  try {
    const output = execSync("sessionlog status", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (/enabled.*true/i.test(output)) {
      return "active";
    }
    return "installed but not enabled";
  } catch {
    return "installed but not enabled";
  }
}

/**
 * Check if sessionlog's standalone hooks are installed in .claude/settings.json.
 * Reads the file directly — no dependency on resolvePackage("sessionlog").
 * Looks for any SessionStart hook command containing "sessionlog " as a sentinel
 * (if session-start is there, all 12 hooks were installed together).
 */
export function hasStandaloneHooks() {
  try {
    const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
    const content = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    const hooks = settings.hooks?.SessionStart ?? [];
    return hooks.some(m => m.hooks?.some(h => h.command?.includes("sessionlog ")));
  } catch {
    return false;
  }
}

/**
 * Auto-enable sessionlog if it is installed but not yet enabled.
 * Tries the programmatic API first (dynamic import), then falls back to CLI.
 * Best-effort — returns true if enabled, false otherwise. Never throws.
 */
export async function ensureSessionlogEnabled() {
  const status = checkSessionlogStatus();
  if (status === "active") return true;
  if (status === "not installed") return false;

  // Status is "installed but not enabled" — try to enable it

  // 1. Try programmatic API via dynamic import
  //    skipAgentHooks: true — agent hooks are managed by cc-swarm's hooks.json
  try {
    const sessionlogMod = await resolvePackage("sessionlog");
    if (sessionlogMod?.enable) {
      const result = await sessionlogMod.enable({ agent: "claude-code", skipAgentHooks: true });
      if (result.enabled) return true;
    }
  } catch {
    // Fall through to CLI
  }

  // 2. Fallback to CLI
  try {
    execSync("sessionlog enable --agent claude-code --skip-agent-hooks", {
      stdio: "ignore",
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the active (non-ended) sessionlog session file.
 * Returns parsed SessionState or null.
 */
export function findActiveSession(sessionlogDir = SESSIONLOG_DIR) {
  if (!fs.existsSync(sessionlogDir)) return null;

  let files;
  try {
    files = fs
      .readdirSync(sessionlogDir)
      .filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }

  let latest = null;
  for (const f of files) {
    try {
      const state = JSON.parse(
        fs.readFileSync(path.join(sessionlogDir, f), "utf-8")
      );
      if (state.phase === "ended") continue;
      if (
        !latest ||
        (state.lastInteractionTime || "") >
          (latest.lastInteractionTime || "")
      ) {
        latest = state;
      }
    } catch {
      // Skip malformed files
    }
  }
  return latest;
}

/**
 * Build a MAP TrajectoryCheckpoint from sessionlog state.
 *
 * Conforms to sessionlog's SessionSyncCheckpoint wire format (snake_case,
 * top-level fields) so OpenHive's sync listener can extract fields correctly.
 * Extra sessionlog-specific fields go in `metadata` for passthrough.
 */
export function buildTrajectoryCheckpoint(state, syncLevel, config) {
  const teamName = resolveTeamName(config);

  const id =
    state.lastCheckpointID ||
    `${state.sessionID}-step${state.stepCount || 0}`;

  // Wire format fields (top-level, snake_case) — always present
  const checkpoint = {
    id,
    session_id: state.sessionID,
    agent: `${teamName}-sidecar`,
    branch: getGitBranch(),
    files_touched: [],
    checkpoints_count: 0,
  };

  // Metadata — sessionlog-specific fields for passthrough
  const metadata = {
    phase: state.phase,
    turnId: state.turnID,
    startedAt: state.startedAt,
    label: `Turn ${state.turnID || "?"} (step ${state.stepCount || 0}, ${state.phase || "unknown"})`,
    // Project context for display
    project: path.basename(process.cwd()),
    firstPrompt: state.firstPrompt ? state.firstPrompt.slice(0, 200) : undefined,
    template: config.template || undefined,
  };
  if (state.endedAt) metadata.endedAt = state.endedAt;

  if (syncLevel === "metrics" || syncLevel === "full") {
    // Promote to top-level wire format fields
    checkpoint.files_touched = state.filesTouched || [];
    checkpoint.checkpoints_count = (state.turnCheckpointIDs || []).length;
    if (state.tokenUsage) {
      checkpoint.token_usage = {
        input_tokens: state.tokenUsage.inputTokens ?? state.tokenUsage.input ?? 0,
        output_tokens: state.tokenUsage.outputTokens ?? state.tokenUsage.output ?? 0,
        cache_creation_tokens: state.tokenUsage.cacheCreationTokens ?? 0,
        cache_read_tokens: state.tokenUsage.cacheReadTokens ?? 0,
        api_call_count: state.tokenUsage.apiCallCount ?? 0,
      };
    }

    // Keep in metadata for sessionlog consumers
    metadata.stepCount = state.stepCount;
    metadata.lastCheckpointID = state.lastCheckpointID;
    metadata.turnCheckpointIDs = state.turnCheckpointIDs;
  }

  if (syncLevel === "full") {
    for (const [key, value] of Object.entries(state)) {
      if (!(key in metadata) && key !== "sessionID") {
        metadata[key] = value;
      }
    }
  }

  return { ...checkpoint, metadata };
}

/**
 * Full sessionlog sync flow: find session, build checkpoint, send to MAP.
 * When sessionId is provided, uses per-session sidecar paths.
 */
export async function syncSessionlog(config, sessionId) {
  const syncLevel = config.sessionlog?.sync || "off";
  if (syncLevel === "off") return;

  const session = findActiveSession();
  if (!session) return;

  const checkpoint = buildTrajectoryCheckpoint(session, syncLevel, config);
  const sPaths = sessionPaths(sessionId);

  // Try sidecar trajectory-checkpoint command
  const sent = await sendToSidecar(
    { action: "trajectory-checkpoint", checkpoint },
    sPaths.socketPath
  );

  if (!sent) {
    const recovered = await ensureSidecar(config, sessionId);
    if (recovered) {
      await sendToSidecar(
        { action: "trajectory-checkpoint", checkpoint },
        sPaths.socketPath
      );
    } else {
      await fireAndForgetTrajectory(config, checkpoint);
    }
  }

  // Cache latest state (shared, not per-session)
  try {
    fs.mkdirSync(path.dirname(SESSIONLOG_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      SESSIONLOG_STATE_PATH,
      JSON.stringify(checkpoint, null, 2)
    );
  } catch {
    // Non-critical
  }
}

/**
 * Annotate the current sessionlog session with swarm metadata.
 * Uses sessionlog's store.annotate() for atomic merge.
 * Best-effort — never throws.
 */
export async function annotateSwarmSession(config, sessionId) {
  if (!sessionId) return;

  let createSessionStore;
  try {
    const sessionlogMod = await resolvePackage("sessionlog");
    if (!sessionlogMod) return;
    ({ createSessionStore } = sessionlogMod);
  } catch {
    // sessionlog not available as a module
    return;
  }

  const teamName = resolveTeamName(config);
  const scope = resolveScope(config);

  const annotations = {
    swarmId: `${teamName}-${sessionId}`,
    teamName,
    template: config.template || "",
    scope,
  };

  try {
    const store = createSessionStore();
    if (typeof store.annotate !== "function") return; // requires sessionlog >=0.0.6
    await store.annotate(sessionId, annotations);
  } catch {
    // Non-critical — session may not exist yet or annotate failed
  }
}

/**
 * Dispatch a sessionlog hook event programmatically.
 * Replaces the CLI pattern: `sessionlog hooks claude-code <hookName>`
 * Uses resolvePackage("sessionlog") to call the lifecycle handler directly.
 * Best-effort — never throws.
 *
 * @param {string} hookName - Sessionlog hook name (e.g. "session-start", "stop")
 * @param {object} hookData - Raw hook event data from Claude Code stdin
 */
export async function dispatchSessionlogHook(hookName, hookData) {
  // Decide whether plugin dispatch should handle this hook.
  // config.sessionlog.mode: "plugin" (always dispatch), "standalone" (never dispatch), "auto" (check)
  const config = readConfig();
  const mode = config.sessionlog?.mode || "auto";
  if (mode === "standalone") return;
  if (mode === "auto" && hasStandaloneHooks()) return;

  let sessionlogMod;
  try {
    sessionlogMod = await resolvePackage("sessionlog");
  } catch {
    return;
  }
  if (!sessionlogMod) return;

  const {
    isEnabled,
    getAgent,
    hasHookSupport,
    createLifecycleHandler,
    createSessionStore,
    createCheckpointStore,
  } = sessionlogMod;

  // Pass cwd explicitly — sessionlog's defaults use git rev-parse which
  // resolves against the OS working directory, not process.cwd().
  const cwd = process.cwd();

  // Bail if sessionlog is not enabled in this repo
  try {
    if (typeof isEnabled === "function" && !(await isEnabled(cwd))) return;
  } catch {
    return;
  }

  const agent = getAgent("claude-code");
  if (!agent || (typeof hasHookSupport === "function" && !hasHookSupport(agent))) return;

  const event = agent.parseHookEvent(hookName, JSON.stringify(hookData));
  if (!event) return;

  const handler = createLifecycleHandler({
    sessionStore: createSessionStore(cwd),
    checkpointStore: createCheckpointStore(cwd),
    cwd,
  });

  await handler.dispatch(agent, event);
}
