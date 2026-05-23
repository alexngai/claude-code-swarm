/**
 * cascade-watcher.mjs — observed-git ref watcher for claude-code-swarm
 *
 * Phase 2 of cascade integration. The watcher is the **detector**: it polls
 * `git for-each-ref` on an interval and diffs ref → SHA snapshots to detect
 * commits, merges, pushes, and new branches. When it observes git activity it
 * pulls real git data per commit and emits `x-cascade/*` events over the MAP
 * connection (via cascade-events.mjs).
 *
 * Polling (not fs.watch) is deliberate: it is cross-platform reliable, needs
 * zero new dependencies, and costs one cheap git call per tick.
 *
 * The watcher works fully standalone — it emits unattributed events when no
 * fresh attribution hint is present. A `PostToolUse(Bash)` hook supplies
 * *attribution* (agent_id, task_ref) as an optional side-channel; it never
 * detects git itself.
 *
 * Everything here is wrapped so a cascade failure can never crash the sidecar:
 * a bad tick logs and continues, the watcher never throws.
 */

import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { promisify } from "util";
import { createLogger } from "./log.mjs";
import {
  ensureStream,
  findStreamByBranch,
  recordObservedCommit,
  recordObservedMerge,
  recordObservedConflict,
  recordObservedConflictResolved,
} from "./cascade-client.mjs";
import {
  buildStreamOpenedParams,
  emitStreamOpened,
  buildStreamCommittedParams,
  emitStreamCommitted,
  buildStreamMergedParams,
  emitStreamMerged,
  buildStreamPushedParams,
  emitStreamPushed,
  buildStreamConflictedParams,
  emitStreamConflicted,
  buildStreamConflictResolvedParams,
  emitStreamConflictResolved,
} from "./cascade-events.mjs";

const log = createLogger("cascade-watcher");

const execFileAsync = promisify(execFile);

/** Poll interval for the ref watcher. One `git for-each-ref` call per tick. */
export const POLL_INTERVAL_MS = 3000;

/**
 * Staleness window for attribution hints. A hint older than this is treated as
 * unrelated to the observed git activity and ignored — the event is emitted
 * unattributed rather than mis-attributed. Set to 5s: the PostToolUse(Bash)
 * hook fires synchronously after the Bash tool returns, and the watcher's 3s
 * poll picks it up on the next tick — 5s gives ~2s buffer while sharply
 * narrowing the cross-tool-invocation race window vs the original 30s. A
 * complete fix would key hints per agent / per tool-call (so two concurrent
 * Bash tools from different agents can't overwrite each other's attribution);
 * that is design work, not just a constant tweak — tracked as a known
 * follow-up.
 */
export const ATTRIBUTION_STALENESS_MS = 5_000;

/** Git's empty-tree SHA — used as the parent of an initial (rootless) commit. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Run a git command in `repoPath`. Returns trimmed stdout, or "" on any error.
 * Best-effort — never throws.
 */
async function git(repoPath, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Snapshot all refs → SHAs via a single `git for-each-ref` call.
 * Returns a Map<refname, sha>. Empty Map on any error.
 */
async function snapshotRefs(repoPath) {
  const out = await git(repoPath, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  ]);
  const map = new Map();
  if (!out) return map;
  for (const line of out.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp === -1) continue;
    const ref = line.slice(0, sp);
    const sha = line.slice(sp + 1).trim();
    if (ref && sha) map.set(ref, sha);
  }
  return map;
}

/**
 * Start the observed-git ref watcher.
 *
 * Takes a baseline ref snapshot on start (no events emitted for the baseline —
 * no history replay), then polls every POLL_INTERVAL_MS and emits `x-cascade/*`
 * events for newly-observed git activity.
 *
 * @param {object} opts
 * @param {object} opts.tracker     git-cascade tracker (from openCascadeTracker)
 * @param {object} opts.connection  MAP AgentConnection (may be null/dead)
 * @param {string} opts.repoPath    Path to the git repository
 * @param {Function} [opts.getAttribution]  () => { agentId, taskRef, ts } | null
 * @param {string} [opts.agentId]   Fallback agent id for stream registration
 * @returns {{ stop: Function, reassertStreams: Function }} Watcher handle.
 */
export function startCascadeWatcher({ tracker, connection, repoPath, getAttribution, agentId } = {}) {
  let conn = connection;
  let prevRefs = null;
  let ticking = false;
  let timer = null;
  let stopped = false;
  // Resolves once the baseline snapshot + initial re-assert have run. tick()
  // awaits this so a poll never races the baseline.
  let readyPromise = null;

  // Stream id cache per branch name — avoids re-resolving on every tick.
  const streamIdByBranch = new Map();

  // In-flight merge-conflict state. Populated when the probe sees
  // `.git/MERGE_HEAD` appear and cleared when it disappears. We cache enough
  // to correlate the resolution event with the conflict event: stream id,
  // conflict id, the HEAD SHA we observed *before* the merge started, and
  // the conflicting commit (so we can tell "advanced to a merge commit"
  // apart from "merge --abort, HEAD unchanged"). Keyed by the absolute path
  // of `.git/MERGE_HEAD` so different worktrees don't collide.
  let inFlightMerge = null;

  const fallbackAgentId = agentId || "cascade-watcher";

  /** Read the freshest attribution hint, or null when none/stale. */
  function freshAttribution() {
    if (typeof getAttribution !== "function") return null;
    let hint;
    try {
      hint = getAttribution();
    } catch {
      return null;
    }
    if (!hint || typeof hint.ts !== "number") return null;
    if (Date.now() - hint.ts > ATTRIBUTION_STALENESS_MS) return null;
    return hint;
  }

  /**
   * Build the `agent_id` + `metadata` pair for an emitted event, consulting
   * the latest attribution hint. Returns unattributed defaults when no fresh
   * hint exists.
   */
  function attributionFor(baseMetadata = {}) {
    const hint = freshAttribution();
    const metadata = { ...baseMetadata };
    if (hint?.taskRef) metadata.task_ref = hint.taskRef;
    return {
      agentId: hint?.agentId || "",
      metadata,
    };
  }

  /** Resolve (and cache) the stream id for a branch, registering it if new. */
  function resolveStreamId(branch, { parentStream } = {}) {
    if (streamIdByBranch.has(branch)) return streamIdByBranch.get(branch);
    let streamId = findStreamByBranch(tracker, branch);
    if (!streamId) {
      const result = ensureStream(tracker, { branch, agentId: fallbackAgentId, parentStream });
      streamId = result?.streamId || null;
    }
    if (streamId) streamIdByBranch.set(branch, streamId);
    return streamId;
  }

  /**
   * Emit `x-cascade/stream.opened` for every currently-tracked stream.
   *
   * Idempotent on the hub — used on watcher start and exposed for the sidecar
   * to call on MAP (re)connect. Covers Phase 1's "lost first-boot emit" gap
   * where the stream.opened event was dropped before the connection existed.
   */
  function reassertStreams() {
    if (!tracker) return;
    let streams;
    try {
      streams = tracker.listStreams();
    } catch (err) {
      log.warn("reassertStreams: listStreams failed", { error: err.message });
      return;
    }
    for (const stream of streams || []) {
      try {
        let branch = null;
        try {
          branch = tracker.getStreamBranchName(stream.id);
        } catch { /* not a local-mode stream / branch gone */ }
        if (branch) streamIdByBranch.set(branch, stream.id);
        const { agentId: attrAgent, metadata } = attributionFor({ trigger: "reassert" });
        emitStreamOpened(conn, buildStreamOpenedParams({
          streamId: stream.id,
          name: stream.name || branch || stream.id,
          agentId: attrAgent || stream.agent_id || fallbackAgentId,
          baseCommit: stream.base_commit || "",
          branchName: branch || undefined,
          metadata,
        }));
      } catch (err) {
        log.warn("reassertStreams: emit failed", { streamId: stream.id, error: err.message });
      }
    }
  }

  /** Emit a stream.committed event for one observed commit. */
  async function emitCommit(streamId, branch, sha) {
    try {
      const summary = await git(repoPath, ["show", "-s", "--format=%s", sha]);
      const filesRaw = await git(repoPath, [
        "diff-tree", "--no-commit-id", "--name-only", "-r", sha,
      ]);
      const filesTouched = filesRaw ? filesRaw.split("\n").filter(Boolean) : [];
      let parent = await git(repoPath, ["rev-parse", `${sha}^`]);
      if (!parent) parent = EMPTY_TREE_SHA;

      const changeId = await recordObservedCommit(tracker, {
        streamId,
        commit: sha,
        description: summary,
      });

      const { agentId: attrAgent, metadata } = attributionFor({
        trigger: "watcher-commit",
        branch,
      });
      emitStreamCommitted(conn, buildStreamCommittedParams({
        streamId,
        commitHash: sha,
        changeId: changeId || "",
        agentId: attrAgent,
        messageSummary: summary,
        filesTouched,
        parentCommit: parent,
        metadata,
      }));
    } catch (err) {
      log.warn("emitCommit failed", { branch, sha, error: err.message });
    }
  }

  /** Emit a stream.merged event for one observed merge commit. */
  async function emitMerge(targetStreamId, targetBranch, mergeSha, parents) {
    try {
      const sourceCommit = parents[1] || "";
      // Resolve the source stream best-effort: find a branch whose HEAD is (or
      // contains) the 2nd parent. May be empty when the source branch is gone.
      let sourceStreamId = "";
      if (sourceCommit) {
        const containing = await git(repoPath, [
          "branch", "--format=%(refname:short)", "--contains", sourceCommit,
        ]);
        const candidates = containing
          ? containing.split("\n").map((b) => b.trim()).filter((b) => b && b !== targetBranch)
          : [];
        for (const candidate of candidates) {
          const head = await git(repoPath, ["rev-parse", candidate]);
          if (head === sourceCommit) {
            sourceStreamId = resolveStreamId(candidate) || "";
            break;
          }
        }
        // No exact-head match — fall back to the first containing branch.
        if (!sourceStreamId && candidates.length > 0) {
          sourceStreamId = resolveStreamId(candidates[0]) || "";
        }
      }

      // Only write the DB record when there is a real, distinct source stream.
      // When sourceStreamId is empty (source branch gone / unresolved) the wire
      // event is still emitted below — we just skip the DB record to avoid a
      // self-merge binding.
      if (sourceStreamId) {
        await recordObservedMerge(tracker, {
          sourceStreamId,
          sourceCommit,
          targetStreamId,
          mergeCommit: mergeSha,
          metadata: { trigger: "watcher-merge" },
        });
      }

      const { agentId: attrAgent, metadata } = attributionFor({
        trigger: "watcher-merge",
        branch: targetBranch,
      });
      emitStreamMerged(conn, buildStreamMergedParams({
        sourceStreamId,
        targetStreamId,
        mergeCommit: mergeSha,
        agentId: attrAgent,
        sourceCommit,
        strategy: "merge-commit",
        metadata,
      }));
    } catch (err) {
      log.warn("emitMerge failed", { targetBranch, mergeSha, error: err.message });
    }
  }

  /** Handle a local branch ref that advanced (or appeared) since last tick. */
  async function handleLocalBranch(refname, oldSha, newSha) {
    const branch = refname.slice("refs/heads/".length);

    // New branch — register it, link best-effort to the branch it forked from.
    if (!oldSha) {
      let parentStream;
      try {
        const tracked = tracker?.listStreams?.() || [];
        // Best-effort fork detection: among tracked branches, pick the one
        // whose merge-base with the new branch is the new branch's own root
        // (a clean fork). Prefer a tracked branch whose HEAD *is* the fork
        // point — that is the most likely parent. Fall back to the first
        // tracked branch that shares any history.
        let exactForkStreamId = null;
        let sharedHistoryStreamId = null;
        for (const stream of tracked) {
          let otherBranch;
          try {
            otherBranch = tracker.getStreamBranchName(stream.id);
          } catch { continue; }
          if (!otherBranch || otherBranch === branch) continue;
          const base = await git(repoPath, ["merge-base", branch, otherBranch]);
          if (!base) continue;
          if (!sharedHistoryStreamId) sharedHistoryStreamId = stream.id;
          const otherHead = await git(repoPath, ["rev-parse", otherBranch]);
          if (otherHead && otherHead === base) {
            exactForkStreamId = stream.id;
            break;
          }
        }
        parentStream = exactForkStreamId || sharedHistoryStreamId || undefined;
      } catch { /* best-effort parent linkage */ }

      const streamId = resolveStreamId(branch, { parentStream });
      if (streamId) {
        const { agentId: attrAgent, metadata } = attributionFor({
          trigger: "watcher-new-branch",
          branch,
        });
        emitStreamOpened(conn, buildStreamOpenedParams({
          streamId,
          name: branch,
          agentId: attrAgent || fallbackAgentId,
          baseCommit: newSha,
          branchName: branch,
          parentStream,
          metadata,
        }));
      }
      return;
    }

    if (oldSha === newSha) return;

    const streamId = resolveStreamId(branch);
    if (!streamId) return;

    // Merge commit? The new HEAD with 2+ parents is a merge.
    const parentLine = await git(repoPath, ["rev-list", "--parents", "-n1", newSha]);
    const parents = parentLine ? parentLine.split(/\s+/).slice(1) : [];
    const isMerge = parents.length >= 2;

    // Emit committed events for each new commit, oldest-first.
    // When this is a merge, use --first-parent so only the target branch's own
    // commits are included — the entire merged-in side-branch history is excluded.
    const revList = await git(repoPath, [
      "rev-list", "--reverse",
      ...(isMerge ? ["--first-parent"] : []),
      `${oldSha}..${newSha}`,
    ]);
    const newCommits = revList ? revList.split("\n").filter(Boolean) : [];
    for (const sha of newCommits) {
      if (isMerge && sha === newSha) continue; // merge commit handled below
      await emitCommit(streamId, branch, sha);
    }

    if (isMerge) {
      await emitMerge(streamId, branch, newSha, parents);
    }
  }

  /** Handle a remote-tracking branch ref that changed — observed as a push. */
  async function handleRemoteBranch(refname, oldSha, newSha) {
    if (oldSha === newSha) return;
    // refs/remotes/<remote>/<branch...>
    const rest = refname.slice("refs/remotes/".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return;
    const remote = rest.slice(0, slash);
    const branch = rest.slice(slash + 1);

    // Only treat it as a push when a local branch matches the new SHA — i.e.
    // the local branch's work was pushed to the remote.
    const localSha = await git(repoPath, ["rev-parse", `refs/heads/${branch}`]);
    if (!localSha || localSha !== newSha) return;

    const streamId = resolveStreamId(branch);
    if (!streamId) return;

    const { agentId: attrAgent, metadata } = attributionFor({
      trigger: "watcher-push",
      branch,
    });
    emitStreamPushed(conn, buildStreamPushedParams({
      streamId,
      agentId: attrAgent,
      pushedCommit: newSha,
      remote,
      remoteRef: branch,
      metadata,
    }));
  }

  /**
   * Probe in-progress merge-conflict state.
   *
   * Cheap on the steady-state (no-merge) path: just one `existsSync` on
   * `.git/MERGE_HEAD` (resolved once via `git rev-parse --git-dir`). Only on a
   * transition does the probe spend more cycles to gather files, parents, and
   * stream attribution.
   *
   * Transitions handled:
   *   - off → on: emit `stream.conflicted` with conflicted files + record a
   *     conflict row so we have a stable `conflict_id` to correlate the
   *     resolution event with.
   *   - on → off: discriminate manual-vs-abandoned by walking HEAD. If HEAD
   *     advanced to a commit with ≥2 parents since the conflict started, the
   *     user (or an agent) committed the merge: `resolution_method: "manual"`
   *     (or `"agent"` when a fresh attribution hint is present). Otherwise
   *     HEAD is unchanged → the merge was aborted: `resolution_method:
   *     "abandoned"`.
   *
   * Rebase conflicts (`.git/rebase-merge/`, `.git/rebase-apply/`) are out of
   * scope for v1 — known TODO.
   *
   * Resilient — the whole probe is wrapped in try/catch and logs+continues on
   * any failure. A wrong-state emission is worse than no emission.
   */
  async function probeMergeConflicts() {
    try {
      // Resolve the worktree-local .git dir cheaply. `git rev-parse --git-dir`
      // returns the dir relative to the cwd; resolve against `repoPath`.
      const gitDirRel = await git(repoPath, ["rev-parse", "--git-dir"]);
      if (!gitDirRel) {
        // Not a git repo (or git not available). If we had an in-flight merge
        // we can't reason about it any more — drop the cache silently.
        inFlightMerge = null;
        return;
      }
      const gitDir = path.isAbsolute(gitDirRel)
        ? gitDirRel
        : path.resolve(repoPath, gitDirRel);
      const mergeHeadPath = path.join(gitDir, "MERGE_HEAD");
      let inMerge;
      try {
        inMerge = existsSync(mergeHeadPath);
      } catch {
        inMerge = false;
      }

      // No transition: nothing to emit (conflict events fire on transitions
      // only, never on every tick while a conflict is open).
      if (inMerge && inFlightMerge) return;
      if (!inMerge && !inFlightMerge) return;

      if (inMerge && !inFlightMerge) {
        // off → on: collect conflicted files, parents, owning stream, then emit.
        const filesRaw = await git(repoPath, [
          "diff", "--name-only", "--diff-filter=U",
        ]);
        const conflictedFiles = filesRaw
          ? filesRaw.split("\n").map((f) => f.trim()).filter(Boolean)
          : [];

        // MERGE_HEAD is the SHA being merged in.
        let conflictingCommit = "";
        try {
          conflictingCommit = readFileSync(mergeHeadPath, "utf-8").split(/\s+/)[0] || "";
        } catch { /* leave empty */ }

        const targetCommit = await git(repoPath, ["rev-parse", "HEAD"]);

        // Resolve the owning stream id via the current branch.
        let branch = "";
        const symbolic = await git(repoPath, ["symbolic-ref", "HEAD"]);
        if (symbolic && symbolic.startsWith("refs/heads/")) {
          branch = symbolic.slice("refs/heads/".length);
        }
        const streamId = branch ? resolveStreamId(branch) : null;
        if (!streamId) {
          // Can't attribute to a stream — leave the cache empty so we don't
          // try to emit a bogus resolved event later either.
          log.warn("probeMergeConflicts: no owning stream", { branch });
          inFlightMerge = { skip: true };
          return;
        }

        const conflictId = await recordObservedConflict(tracker, {
          streamId,
          conflictingCommit,
          targetCommit,
          conflictedFiles,
        });

        const { agentId: attrAgent, metadata } = attributionFor({
          trigger: "watcher-conflict",
          branch,
        });
        emitStreamConflicted(conn, buildStreamConflictedParams({
          streamId,
          conflictId: conflictId || "",
          conflictedFiles,
          agentId: attrAgent,
          conflictingCommit,
          targetCommit,
          source: "merge",
          metadata,
        }));

        inFlightMerge = {
          streamId,
          branch,
          conflictId: conflictId || "",
          conflictingCommit,
          targetCommitBeforeResolve: targetCommit,
        };
        return;
      }

      if (!inMerge && inFlightMerge) {
        // on → off: figure out whether HEAD advanced (manual/agent resolve)
        // or stayed put (abandoned via `git merge --abort`).
        const cached = inFlightMerge;
        inFlightMerge = null;
        if (cached.skip) return;

        const currentHead = await git(repoPath, ["rev-parse", "HEAD"]);
        let resolutionMethod = "abandoned";
        let resolutionSummary;
        if (currentHead && currentHead !== cached.targetCommitBeforeResolve) {
          // HEAD moved. If the new HEAD has ≥2 parents we observed a real
          // merge commit (the conflict was resolved + committed). Treat
          // attribution-present resolutions as "agent" so the wire event
          // reflects who did the work.
          const parentLine = await git(repoPath, ["rev-list", "--parents", "-n1", currentHead]);
          const parents = parentLine ? parentLine.split(/\s+/).slice(1) : [];
          if (parents.length >= 2) {
            const hint = freshAttribution();
            resolutionMethod = hint?.agentId ? "agent" : "manual";
            resolutionSummary = `Merged ${cached.conflictingCommit.slice(0, 7) || "MERGE_HEAD"} into ${cached.branch || "branch"}`;
          }
          // HEAD moved but not to a merge commit — unusual (e.g. user committed
          // with `--no-ff` flow). Treat as "manual" so we don't lose the resolve.
          else {
            resolutionMethod = "manual";
          }
        }

        const { agentId: attrAgent, metadata } = attributionFor({
          trigger: "watcher-conflict-resolved",
          branch: cached.branch,
        });
        const resolvedBy = attrAgent || (resolutionMethod === "abandoned" ? "human" : "human");

        await recordObservedConflictResolved(tracker, {
          conflictId: cached.conflictId,
          method: resolutionMethod,
          resolvedBy,
          summary: resolutionSummary,
        });

        emitStreamConflictResolved(conn, buildStreamConflictResolvedParams({
          streamId: cached.streamId,
          conflictId: cached.conflictId,
          resolutionMethod,
          resolvedBy,
          resolutionSummary,
          metadata,
        }));
      }
    } catch (err) {
      log.warn("probeMergeConflicts failed", { error: err.message });
    }
  }

  /** One poll tick: snapshot refs, diff against the prior snapshot, emit. */
  async function tick() {
    if (stopped || ticking) return;
    // Wait for the baseline to be established so a poll never races start.
    if (readyPromise) {
      try { await readyPromise; } catch { /* ignore — start logged it */ }
    }
    if (stopped || ticking) return;
    ticking = true;
    try {
      const refs = await snapshotRefs(repoPath);
      if (!prevRefs) {
        // Baseline — record without emitting (no history replay).
        prevRefs = refs;
        return;
      }

      for (const [refname, newSha] of refs) {
        const oldSha = prevRefs.get(refname) || null;
        if (oldSha === newSha) continue;
        try {
          if (refname.startsWith("refs/heads/")) {
            await handleLocalBranch(refname, oldSha, newSha);
          } else if (refname.startsWith("refs/remotes/")) {
            await handleRemoteBranch(refname, oldSha, newSha);
          }
        } catch (err) {
          log.warn("tick: ref handler failed", { refname, error: err.message });
        }
      }

      prevRefs = refs;

      // Probe in-progress merge state *after* the ref-diff pass — so an
      // aborted merge's "HEAD unchanged" check is consistent with the same
      // refs snapshot we just diffed.
      await probeMergeConflicts();
    } catch (err) {
      log.warn("tick failed", { error: err.message });
    } finally {
      ticking = false;
    }
  }

  // Take the baseline snapshot, re-assert open streams, then start polling.
  readyPromise = (async () => {
    try {
      prevRefs = await snapshotRefs(repoPath);
      reassertStreams();
    } catch (err) {
      log.warn("watcher start failed", { error: err.message });
    }
  })();

  timer = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();

  log.info("cascade watcher started", { repoPath, pollIntervalMs: POLL_INTERVAL_MS });

  return {
    /** Stop the watcher. Idempotent, never throws. */
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      log.debug("cascade watcher stopped");
    },
    /**
     * Re-assert `x-cascade/stream.opened` for all tracked streams. Called by
     * the sidecar on MAP (re)connect — idempotent on the hub.
     */
    reassertStreams,
    /** Update the MAP connection ref (after a reconnect swaps it). */
    setConnection(newConn) {
      conn = newConn;
    },
    /** Run one tick immediately (used by tests to avoid waiting on the timer). */
    _tickNow: tick,
    /** Resolves once the baseline snapshot + initial re-assert have run (tests). */
    _ready: readyPromise,
  };
}
