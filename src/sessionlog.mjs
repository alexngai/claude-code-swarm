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
import { resolveTeamName, resolveScope } from "./config.mjs";
import { sendToSidecar, ensureSidecar } from "./sidecar-client.mjs";
import { fireAndForgetTrajectory } from "./map-connection.mjs";

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
 * Metadata contents are filtered by sync level.
 */
export function buildTrajectoryCheckpoint(state, syncLevel, config) {
  const teamName = resolveTeamName(config);
  const agentId = `${teamName}-sidecar`;

  const id =
    state.lastCheckpointID ||
    `${state.sessionID}-step${state.stepCount || 0}`;

  const label = `Turn ${state.turnID || "?"} (step ${state.stepCount || 0}, ${state.phase || "unknown"})`;

  const metadata = {
    phase: state.phase,
    turnId: state.turnID,
    startedAt: state.startedAt,
  };
  if (state.endedAt) metadata.endedAt = state.endedAt;

  if (syncLevel === "metrics" || syncLevel === "full") {
    metadata.stepCount = state.stepCount;
    metadata.filesTouched = state.filesTouched;
    metadata.lastCheckpointID = state.lastCheckpointID;
    metadata.turnCheckpointIDs = state.turnCheckpointIDs;
    if (state.tokenUsage) metadata.tokenUsage = state.tokenUsage;
  }

  if (syncLevel === "full") {
    for (const [key, value] of Object.entries(state)) {
      if (!(key in metadata) && key !== "sessionID") {
        metadata[key] = value;
      }
    }
  }

  return {
    id,
    agentId,
    sessionId: state.sessionID,
    label,
    metadata,
  };
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
    ({ createSessionStore } = await import("sessionlog"));
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
