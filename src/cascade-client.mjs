/**
 * cascade-client.mjs — git-cascade tracker ownership for claude-code-swarm
 *
 * Owns a persistent `MultiAgentRepoTracker` running in **local mode** as a
 * local state store. cc-swarm emits `x-cascade/*` events itself over the MAP
 * connection (see cascade-events.mjs) — the tracker here is NOT given an
 * `emit` callback. This is the "observed git" design: the tracker mirrors the
 * working branch as a local-mode stream so later phases can observe commits
 * and merges without owning the branch.
 *
 * Every git-cascade call is wrapped in try/catch — cascade failures must never
 * crash the sidecar. When git-cascade can't be imported (not installed) or the
 * repo path is not a git repo, openCascadeTracker() returns null and callers
 * skip cascade work entirely.
 */

import { execFileSync } from "child_process";
import { createLogger } from "./log.mjs";
import { resolvePackage } from "./swarmkit-resolver.mjs";

const log = createLogger("cascade-client");

/**
 * Cached git-cascade module namespace exports (`streams`, `changes`).
 *
 * git-cascade exposes its CRUD helpers as `export * as streams` /
 * `export * as changes`. We resolve them lazily on first use and cache them so
 * the DB-record helpers below don't re-import on every call.
 */
let _gitCascadeMod = null;
async function getGitCascadeMod() {
  if (_gitCascadeMod) return _gitCascadeMod;
  try {
    const mod = await resolvePackage("git-cascade");
    if (mod) _gitCascadeMod = mod;
    return mod;
  } catch (err) {
    log.warn("git-cascade module resolve failed", { error: err.message });
    return null;
  }
}

/**
 * Table prefix for the git-cascade tracker DB. Keeps cascade tables namespaced
 * within the SQLite file in case the DB is ever shared.
 */
const TABLE_PREFIX = "cascade_";

/**
 * Check whether `repoPath` is inside a git working tree.
 * Best-effort — returns false on any error.
 */
function isGitRepo(repoPath) {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

/**
 * Open a git-cascade MultiAgentRepoTracker in local mode.
 *
 * The tracker acts purely as a local state store — no `emit` callback is
 * passed because cc-swarm emits x-cascade/* events itself over MAP.
 *
 * @param {object} opts
 * @param {string} opts.repoPath  Path to the git repository (the swarm cwd)
 * @param {string} opts.dbPath    Path to the tracker SQLite DB file
 * @returns {Promise<object|null>} The tracker instance, or null if git-cascade
 *   is unavailable or `repoPath` is not a git repo. Never throws.
 */
export async function openCascadeTracker({ repoPath, dbPath }) {
  if (!repoPath || !isGitRepo(repoPath)) {
    log.warn("cascade disabled: not a git repository", { repoPath });
    return null;
  }

  let gitCascade;
  try {
    gitCascade = await resolvePackage("git-cascade");
  } catch (err) {
    log.warn("cascade disabled: git-cascade import failed", { error: err.message });
    return null;
  }
  if (!gitCascade || typeof gitCascade.MultiAgentRepoTracker !== "function") {
    log.warn("cascade disabled: git-cascade not available");
    return null;
  }

  try {
    const tracker = new gitCascade.MultiAgentRepoTracker({
      repoPath,
      dbPath,
      tablePrefix: TABLE_PREFIX,
      // Skip startup recovery — local-mode tracking has no in-flight
      // operations to recover, and recovery touches git state we don't own.
      skipRecovery: true,
    });
    log.info("cascade tracker opened", { repoPath, dbPath });
    return tracker;
  } catch (err) {
    log.warn("cascade disabled: failed to open tracker", { error: err.message });
    return null;
  }
}

/**
 * Resolve the stream id that tracks `branch`, or null when none does.
 *
 * Streams registered via `trackExistingBranch` are local-mode —
 * `getStreamBranchName` returns the existing branch they track. Best-effort:
 * returns null on any error and skips streams whose branch can't be read.
 *
 * @param {object} tracker  A MultiAgentRepoTracker (from openCascadeTracker)
 * @param {string} branch   Branch name to match
 * @returns {string|null} The matching stream id, or null.
 */
export function findStreamByBranch(tracker, branch) {
  if (!tracker || !branch) return null;
  try {
    const existing = tracker.listStreams();
    for (const stream of existing) {
      let trackedBranch;
      try {
        trackedBranch = tracker.getStreamBranchName(stream.id);
      } catch {
        continue;
      }
      if (trackedBranch === branch) return stream.id;
    }
  } catch (err) {
    log.warn("findStreamByBranch failed", { branch, error: err.message });
  }
  return null;
}

/**
 * Ensure a stream exists for the given branch (idempotent).
 *
 * If a stream already tracks `branch`, returns its id with `created: false`.
 * Otherwise calls `trackExistingBranch` to register the branch as a
 * local-mode stream and returns the new id with `created: true`.
 *
 * @param {object} tracker  A MultiAgentRepoTracker (from openCascadeTracker)
 * @param {object} opts
 * @param {string} opts.branch        Branch name to track
 * @param {string} opts.agentId       Owning agent id
 * @param {string} [opts.parentStream] Parent stream id, if forked
 * @returns {{ streamId: string, created: boolean } | null} Null on failure.
 */
export function ensureStream(tracker, { branch, agentId, parentStream } = {}) {
  if (!tracker || !branch) return null;

  try {
    const existingId = findStreamByBranch(tracker, branch);
    if (existingId) {
      return { streamId: existingId, created: false };
    }

    const streamId = tracker.trackExistingBranch({
      branch,
      name: branch,
      agentId,
      parentStream,
    });
    return { streamId, created: true };
  } catch (err) {
    log.warn("ensureStream failed", { branch, error: err.message });
    return null;
  }
}

/**
 * Record an observed commit as a git-cascade change.
 *
 * Calls `changes.createChange` against the tracker's DB. createChange does NOT
 * emit any event — that is intentional: the cascade-watcher emits the
 * `x-cascade/stream.committed` event itself over MAP. This helper exists only
 * to persist the change row and hand back the git-cascade change id so the
 * watcher can stamp `change_id` on the emitted event.
 *
 * @param {object} tracker  A MultiAgentRepoTracker (from openCascadeTracker)
 * @param {object} opts
 * @param {string} opts.streamId     Stream that received the commit
 * @param {string} opts.commit       Commit SHA
 * @param {string} opts.description  Change description (commit summary)
 * @returns {Promise<string|null>} The git-cascade change id, or null on failure.
 */
export async function recordObservedCommit(tracker, { streamId, commit, description } = {}) {
  if (!tracker || !tracker.db || !streamId || !commit) return null;
  try {
    const mod = await getGitCascadeMod();
    if (!mod?.changes?.createChange) return null;
    return mod.changes.createChange(tracker.db, {
      streamId,
      commit,
      description: description || "",
    });
  } catch (err) {
    log.warn("recordObservedCommit failed", { streamId, commit, error: err.message });
    return null;
  }
}

/**
 * Record an observed merge as a git-cascade stream merge edge.
 *
 * Calls `streams.recordMerge` against the tracker's DB. Like
 * `recordObservedCommit`, this only persists the merge row — the
 * cascade-watcher emits the `x-cascade/stream.merged` event itself.
 *
 * @param {object} tracker  A MultiAgentRepoTracker (from openCascadeTracker)
 * @param {object} opts
 * @param {string} opts.sourceStreamId  Stream merged FROM
 * @param {string} opts.sourceCommit    Commit SHA in the source stream
 * @param {string} opts.targetStreamId  Stream merged INTO
 * @param {string} opts.mergeCommit     Resulting merge commit SHA
 * @param {object} [opts.metadata]      Free-form metadata
 * @returns {Promise<string|null>} The merge record id, or null on failure.
 */
export async function recordObservedMerge(tracker, { sourceStreamId, sourceCommit, targetStreamId, mergeCommit, metadata } = {}) {
  if (!tracker || !tracker.db || !sourceStreamId || !targetStreamId || !mergeCommit) return null;
  try {
    const mod = await getGitCascadeMod();
    if (!mod?.streams?.recordMerge) return null;
    return mod.streams.recordMerge(tracker.db, {
      sourceStreamId,
      sourceCommit: sourceCommit || "",
      targetStreamId,
      mergeCommit,
      metadata: metadata || {},
    });
  } catch (err) {
    log.warn("recordObservedMerge failed", { sourceStreamId, targetStreamId, mergeCommit, error: err.message });
    return null;
  }
}

/**
 * Record an observed in-progress merge conflict as a git-cascade conflict row.
 *
 * Calls `conflicts.createConflict` against the tracker's DB so the watcher has
 * a stable `conflict_id` (cf-xxx) to stamp on emitted events. The function
 * mirrors the `recordObserved*` style — no event emission (the watcher emits),
 * try/catch, returns null on any failure so cascade can never crash the
 * sidecar.
 *
 * @param {object} tracker  A MultiAgentRepoTracker (from openCascadeTracker)
 * @param {object} opts
 * @param {string} opts.streamId           Stream that became conflicted
 * @param {string} opts.conflictingCommit  Commit being applied (MERGE_HEAD)
 * @param {string} opts.targetCommit       Commit being applied onto (HEAD)
 * @param {string[]} opts.conflictedFiles  Files reported by git as conflicted
 * @returns {Promise<string|null>} The git-cascade conflict id, or null on failure.
 */
export async function recordObservedConflict(tracker, { streamId, conflictingCommit, targetCommit, conflictedFiles } = {}) {
  if (!tracker || !tracker.db || !streamId || !conflictingCommit) return null;
  try {
    const mod = await getGitCascadeMod();
    if (!mod?.conflicts?.createConflict) return null;
    return mod.conflicts.createConflict(tracker.db, {
      streamId,
      conflictingCommit,
      targetCommit: targetCommit || "",
      conflictedFiles: Array.isArray(conflictedFiles) ? conflictedFiles : [],
    });
  } catch (err) {
    log.warn("recordObservedConflict failed", { streamId, conflictingCommit, error: err.message });
    return null;
  }
}

/**
 * Record the resolution (or abandonment) of an observed conflict.
 *
 * For methods `"manual"` / `"agent"` / `"ours"` / `"theirs"` this calls
 * `conflicts.resolveConflict`. For `"abandoned"` (the merge was aborted) it
 * calls `conflicts.abandonConflict`, since `ConflictResolution.method` does
 * not include `"abandoned"` in git-cascade's type union.
 *
 * Best-effort — returns false on any failure, never throws.
 *
 * @param {object} tracker  A MultiAgentRepoTracker (from openCascadeTracker)
 * @param {object} opts
 * @param {string} opts.conflictId  Conflict record id (cf-xxx) returned by
 *   `recordObservedConflict`
 * @param {string} opts.method      "manual" | "agent" | "abandoned" | "ours" | "theirs"
 * @param {string} [opts.resolvedBy] Agent id or "human"
 * @param {string} [opts.summary]   Optional free-form resolution summary
 * @returns {Promise<boolean>} True on success, false on any failure.
 */
export async function recordObservedConflictResolved(tracker, { conflictId, method, resolvedBy, summary } = {}) {
  if (!tracker || !tracker.db || !conflictId) return false;
  try {
    const mod = await getGitCascadeMod();
    if (!mod?.conflicts) return false;
    if (method === "abandoned") {
      if (typeof mod.conflicts.abandonConflict !== "function") return false;
      mod.conflicts.abandonConflict(tracker.db, conflictId);
      return true;
    }
    if (typeof mod.conflicts.resolveConflict !== "function") return false;
    mod.conflicts.resolveConflict(tracker.db, conflictId, {
      method: method || "manual",
      resolvedBy: resolvedBy || "human",
      ...(summary ? { details: summary } : {}),
    });
    return true;
  } catch (err) {
    log.warn("recordObservedConflictResolved failed", { conflictId, method, error: err.message });
    return false;
  }
}

/**
 * Safely close a cascade tracker. No-op when `tracker` is falsy. Never throws.
 *
 * @param {object|null} tracker
 */
export function closeCascadeTracker(tracker) {
  if (!tracker) return;
  try {
    tracker.close();
    log.debug("cascade tracker closed");
  } catch (err) {
    log.warn("failed to close cascade tracker", { error: err.message });
  }
}
