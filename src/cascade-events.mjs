/**
 * cascade-events.mjs — x-cascade/* event builders + emit for claude-code-swarm
 *
 * cc-swarm emits `x-cascade/*` notifications itself over the MAP connection
 * (rather than letting git-cascade's `emit` callback drive them). This module
 * builds the snake_case wire payloads and forwards them as MAP extension
 * notifications.
 *
 * Wire shapes match git-cascade's `events/index.d.ts` (StreamOpenedParams etc.)
 * so an OpenHive hub can consume them with no translation.
 */

import { createLogger } from "./log.mjs";

const log = createLogger("cascade-events");

/**
 * Build the `x-cascade/stream.opened` param shape (snake_case wire format).
 *
 * Mirrors git-cascade's `StreamOpenedParams`. Always sets `is_local_mode: true`
 * — cc-swarm only ever registers existing branches as local-mode streams.
 *
 * `parent_stream` carries the fork edge: when the watcher detects a branch
 * forked from a tracked branch it passes the parent's stream id, and the hub's
 * `cascade-handler` writes it as `parent_stream_id` so the PR-stack walker can
 * traverse the stack. Omitted (left undefined) when there is no parent.
 *
 * @param {object} opts
 * @param {string} opts.streamId    git-cascade stream id
 * @param {string} opts.name        Human-readable stream name
 * @param {string} opts.agentId     Owning agent id
 * @param {string} opts.baseCommit  Commit the stream was based from
 * @param {string} [opts.branchName] Branch the stream maps to
 * @param {string} [opts.parentStream] Parent stream id, when forked
 * @param {object} [opts.metadata]  Free-form caller metadata
 * @returns {object} StreamOpenedParams-shaped object
 */
export function buildStreamOpenedParams({ streamId, name, agentId, baseCommit, branchName, parentStream, metadata } = {}) {
  return {
    stream_id: streamId,
    name,
    agent_id: agentId,
    base_commit: baseCommit,
    branch_name: branchName,
    is_local_mode: true,
    ...(parentStream ? { parent_stream: parentStream } : {}),
    metadata: metadata || {},
  };
}

/**
 * Emit an `x-cascade/stream.opened` notification over a MAP connection.
 *
 * Fire-and-forget: any failure is caught and logged — this never throws, so a
 * missing/dead connection can't crash the sidecar.
 *
 * @param {object} connection  A MAP AgentConnection (must expose callExtension)
 * @param {object} params      Payload from buildStreamOpenedParams()
 */
export function emitStreamOpened(connection, params) {
  emitCascadeEvent(connection, "x-cascade/stream.opened", params);
}

/**
 * Build the `x-cascade/stream.committed` param shape (snake_case wire format).
 *
 * Mirrors git-cascade's `StreamCommittedParams`. The watcher pulls real git
 * data (summary, files, parent) and a git-cascade change id per commit.
 *
 * @param {object} opts
 * @param {string} opts.streamId        Stream that received the commit
 * @param {string} opts.commitHash      Commit SHA
 * @param {string} opts.changeId        git-cascade Change-Id for this change
 * @param {string} opts.agentId         Authoring agent id ("" when unattributed)
 * @param {string} opts.messageSummary  First line of the commit message
 * @param {string[]} opts.filesTouched  Files modified by the commit
 * @param {string} opts.parentCommit    Parent commit SHA
 * @param {object} [opts.metadata]      Free-form caller metadata
 * @returns {object} StreamCommittedParams-shaped object
 */
export function buildStreamCommittedParams({ streamId, commitHash, changeId, agentId, messageSummary, filesTouched, parentCommit, metadata } = {}) {
  return {
    stream_id: streamId,
    commit_hash: commitHash,
    change_id: changeId || "",
    agent_id: agentId || "",
    message_summary: messageSummary || "",
    files_touched: Array.isArray(filesTouched) ? filesTouched : [],
    parent_commit: parentCommit || "",
    metadata: metadata || {},
  };
}

/**
 * Emit an `x-cascade/stream.committed` notification over a MAP connection.
 * Fire-and-forget — never throws.
 *
 * @param {object} connection  A MAP AgentConnection (must expose callExtension)
 * @param {object} params      Payload from buildStreamCommittedParams()
 */
export function emitStreamCommitted(connection, params) {
  emitCascadeEvent(connection, "x-cascade/stream.committed", params);
}

/**
 * Build the `x-cascade/stream.merged` param shape (snake_case wire format).
 *
 * Mirrors git-cascade's `StreamMergedParams`. `source_stream_id` is best-effort
 * — the watcher resolves the source branch by the 2nd parent commit and it may
 * be empty when the source branch was already deleted.
 *
 * @param {object} opts
 * @param {string} opts.sourceStreamId  Stream merged FROM ("" when unresolved)
 * @param {string} opts.targetStreamId  Stream merged INTO
 * @param {string} opts.mergeCommit     Resulting merge commit SHA
 * @param {string} opts.agentId         Agent that performed the merge
 * @param {string} [opts.sourceCommit]  Head of the source at merge time
 * @param {string} [opts.strategy]      Merge strategy label
 * @param {object} [opts.metadata]      Free-form caller metadata
 * @returns {object} StreamMergedParams-shaped object
 */
export function buildStreamMergedParams({ sourceStreamId, targetStreamId, mergeCommit, agentId, sourceCommit, strategy, metadata } = {}) {
  return {
    source_stream_id: sourceStreamId || "",
    target_stream_id: targetStreamId,
    merge_commit: mergeCommit,
    agent_id: agentId || "",
    source_commit: sourceCommit || "",
    strategy: strategy || "merge-commit",
    metadata: metadata || {},
  };
}

/**
 * Emit an `x-cascade/stream.merged` notification over a MAP connection.
 * Fire-and-forget — never throws.
 *
 * @param {object} connection  A MAP AgentConnection (must expose callExtension)
 * @param {object} params      Payload from buildStreamMergedParams()
 */
export function emitStreamMerged(connection, params) {
  emitCascadeEvent(connection, "x-cascade/stream.merged", params);
}

/**
 * Build the `x-cascade/stream.pushed` param shape (snake_case wire format).
 *
 * Mirrors git-cascade's `StreamPushedParams`.
 *
 * @param {object} opts
 * @param {string} opts.streamId      Stream whose head was pushed
 * @param {string} opts.agentId       Agent that did the push
 * @param {string} opts.pushedCommit  Commit SHA at the head when pushed
 * @param {string} opts.remote        Remote name (e.g. 'origin')
 * @param {string} opts.remoteRef     Remote ref pushed to
 * @param {object} [opts.metadata]    Free-form caller metadata
 * @returns {object} StreamPushedParams-shaped object
 */
export function buildStreamPushedParams({ streamId, agentId, pushedCommit, remote, remoteRef, metadata } = {}) {
  return {
    stream_id: streamId,
    agent_id: agentId || "",
    pushed_commit: pushedCommit,
    remote: remote || "origin",
    remote_ref: remoteRef || "",
    metadata: metadata || {},
  };
}

/**
 * Emit an `x-cascade/stream.pushed` notification over a MAP connection.
 * Fire-and-forget — never throws.
 *
 * @param {object} connection  A MAP AgentConnection (must expose callExtension)
 * @param {object} params      Payload from buildStreamPushedParams()
 */
export function emitStreamPushed(connection, params) {
  emitCascadeEvent(connection, "x-cascade/stream.pushed", params);
}

/**
 * Build the `x-cascade/stream.conflicted` param shape (snake_case wire format).
 *
 * Mirrors git-cascade's `StreamConflictedParams`. cc-swarm emits this on the
 * transition where a tracked stream enters an in-progress merge state (i.e.
 * the watcher observes `.git/MERGE_HEAD` appear). Rebase conflicts are out of
 * scope for v1.
 *
 * @param {object} opts
 * @param {string} opts.streamId          Stream that became conflicted
 * @param {string} [opts.conflictId]      Persisted conflict record id (cf-xxx)
 * @param {string[]} opts.conflictedFiles Files reported as conflicted
 * @param {string} [opts.agentId]         Agent that triggered the conflicting op
 * @param {string} [opts.conflictingCommit] Commit being applied (e.g. MERGE_HEAD)
 * @param {string} [opts.targetCommit]    Commit being applied onto (HEAD)
 * @param {string} [opts.source]          Operation flavor: "merge" | "rebase" | ...
 * @param {object} [opts.metadata]        Free-form caller metadata
 * @returns {object} StreamConflictedParams-shaped object
 */
export function buildStreamConflictedParams({ streamId, conflictId, conflictedFiles, agentId, conflictingCommit, targetCommit, source, metadata } = {}) {
  return {
    stream_id: streamId,
    ...(conflictId ? { conflict_id: conflictId } : {}),
    conflicted_files: Array.isArray(conflictedFiles) ? conflictedFiles : [],
    agent_id: agentId || "",
    conflicting_commit: conflictingCommit || "",
    target_commit: targetCommit || "",
    source: source || "merge",
    metadata: metadata || {},
  };
}

/**
 * Emit an `x-cascade/stream.conflicted` notification over a MAP connection.
 * Fire-and-forget — never throws.
 *
 * @param {object} connection  A MAP AgentConnection (must expose callExtension)
 * @param {object} params      Payload from buildStreamConflictedParams()
 */
export function emitStreamConflicted(connection, params) {
  emitCascadeEvent(connection, "x-cascade/stream.conflicted", params);
}

/**
 * Build the `x-cascade/stream.conflict_resolved` param shape (snake_case wire).
 *
 * Mirrors git-cascade's `StreamConflictResolvedParams`. cc-swarm emits this on
 * the transition where the in-progress merge state goes away: either HEAD
 * advanced to a merge commit (`manual` / `agent` resolution) or HEAD is
 * unchanged (the merge was aborted — `abandoned`).
 *
 * @param {object} opts
 * @param {string} opts.streamId          Stream whose conflict was resolved
 * @param {string} opts.conflictId        Conflict record id that was resolved
 * @param {string} opts.resolutionMethod  "manual" | "agent" | "abandoned" | ...
 * @param {string} [opts.resolvedBy]      Agent or human that resolved it
 * @param {string} [opts.resolutionSummary] Optional human-readable summary
 * @param {object} [opts.metadata]        Free-form caller metadata
 * @returns {object} StreamConflictResolvedParams-shaped object
 */
export function buildStreamConflictResolvedParams({ streamId, conflictId, resolutionMethod, resolvedBy, resolutionSummary, metadata } = {}) {
  return {
    stream_id: streamId,
    conflict_id: conflictId || "",
    resolution_method: resolutionMethod || "manual",
    ...(resolvedBy ? { resolved_by: resolvedBy } : {}),
    ...(resolutionSummary ? { resolution_summary: resolutionSummary } : {}),
    metadata: metadata || {},
  };
}

/**
 * Emit an `x-cascade/stream.conflict_resolved` notification over a MAP connection.
 * Fire-and-forget — never throws.
 *
 * @param {object} connection  A MAP AgentConnection (must expose callExtension)
 * @param {object} params      Payload from buildStreamConflictResolvedParams()
 */
export function emitStreamConflictResolved(connection, params) {
  emitCascadeEvent(connection, "x-cascade/stream.conflict_resolved", params);
}

/**
 * Shared fire-and-forget emit for all `x-cascade/*` notifications.
 *
 * Any failure (no connection, callExtension throws, promise rejects) is caught
 * and logged. This never throws — a missing/dead connection or a misbehaving
 * hub can't crash the sidecar.
 *
 * @param {object} connection  A MAP AgentConnection (must expose callExtension)
 * @param {string} method      Full `x-cascade/*` method name
 * @param {object} params      Snake_case wire payload
 */
function emitCascadeEvent(connection, method, params) {
  if (!connection || typeof connection.callExtension !== "function") {
    log.debug("skipping cascade emit: no MAP connection", { method });
    return;
  }
  try {
    Promise.resolve(connection.callExtension(method, params))
      .catch((err) => log.warn("cascade emit failed", { method, error: err.message }));
  } catch (err) {
    log.warn("cascade emit threw", { method, error: err.message });
  }
}
