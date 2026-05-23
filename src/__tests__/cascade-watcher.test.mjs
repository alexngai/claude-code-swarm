/**
 * cascade-watcher.test.mjs — observed-git ref watcher (Phase 2)
 *
 * Exercises startCascadeWatcher against a real temp git repo with a mocked
 * MAP connection (captures callExtension calls). Tests baseline (no emit),
 * commit detection, merge detection, and attribution stamping.
 *
 * git-cascade is resolved at runtime via swarmkit-resolver — these tests
 * require git-cascade to be importable from the workspace.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { openCascadeTracker, ensureStream, closeCascadeTracker } from "../cascade-client.mjs";
import { startCascadeWatcher } from "../cascade-watcher.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

/** Run a git command in `dir`, returning trimmed stdout. */
function g(dir, args) {
  return execSync(`git ${args}`, {
    cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Create a real git repo with an initial commit on `main`. */
function makeGitRepo(dir) {
  g(dir, "init -b main");
  g(dir, 'config user.email "test@test.com"');
  g(dir, 'config user.name "Test"');
  g(dir, "config commit.gpgsign false");
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  g(dir, "add .");
  g(dir, 'commit -m "initial"');
}

/** Write a file and commit it; returns the new HEAD SHA. */
function commitFile(dir, relPath, content, message) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  g(dir, "add -A");
  g(dir, `commit -m "${message}"`);
  return g(dir, "rev-parse HEAD");
}

/**
 * Mock MAP connection — captures every callExtension(method, params) call.
 */
function makeMockConnection() {
  const calls = [];
  return {
    calls,
    callExtension(method, params) {
      calls.push({ method, params });
      return Promise.resolve({ ok: true });
    },
    /** Calls for a given x-cascade method suffix. */
    callsFor(suffix) {
      return calls.filter((c) => c.method.endsWith(suffix));
    },
  };
}

describe("cascade-watcher", () => {
  let repoDir;
  let dbPath;
  let tracker;
  let watcher;

  beforeEach(async () => {
    repoDir = makeTmpDir("cascade-watcher-");
    dbPath = path.join(repoDir, "tracker.db");
    makeGitRepo(repoDir);
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    // Register the working branch so the watcher resolves a stream for it.
    ensureStream(tracker, { branch: "main", agentId: "team-sidecar" });
    watcher = null;
  });

  afterEach(() => {
    if (watcher) {
      try { watcher.stop(); } catch { /* ignore */ }
      watcher = null;
    }
    if (tracker) {
      closeCascadeTracker(tracker);
      tracker = null;
    }
    cleanupTmpDir(repoDir);
  });

  it("emits nothing for the baseline snapshot (no history replay)", async () => {
    const conn = makeMockConnection();
    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });

    // The start IIFE takes the baseline; a tick with no new git activity
    // emits no committed/merged events (no history replay).
    await watcher._ready;
    await watcher._tickNow();

    expect(conn.callsFor("stream.committed")).toHaveLength(0);
    expect(conn.callsFor("stream.merged")).toHaveLength(0);
  });

  it("emits stream.committed for a new commit with correct files and summary", async () => {
    const conn = makeMockConnection();
    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    await watcher._ready;

    // New commit on main, then a detect tick.
    const sha = commitFile(repoDir, "src/feature.txt", "hello\n", "add feature");
    await watcher._tickNow();

    const committed = conn.callsFor("stream.committed");
    expect(committed.length).toBe(1);
    const p = committed[0].params;
    expect(p.commit_hash).toBe(sha);
    expect(p.message_summary).toBe("add feature");
    expect(p.files_touched).toContain("src/feature.txt");
    expect(typeof p.change_id).toBe("string");
    expect(p.parent_commit.length).toBeGreaterThan(0);
    // No attribution hint → unattributed.
    expect(p.agent_id).toBe("");
  });

  it("emits committed events oldest-first for multiple new commits", async () => {
    const conn = makeMockConnection();
    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    await watcher._ready;

    commitFile(repoDir, "a.txt", "1\n", "first");
    commitFile(repoDir, "b.txt", "2\n", "second");
    await watcher._tickNow();

    const committed = conn.callsFor("stream.committed");
    expect(committed.length).toBe(2);
    expect(committed[0].params.message_summary).toBe("first");
    expect(committed[1].params.message_summary).toBe("second");
  });

  it("emits stream.merged for a merge commit", async () => {
    const conn = makeMockConnection();

    // Build a feature branch and register it before the watcher starts.
    g(repoDir, "checkout -b feature-x");
    commitFile(repoDir, "feat.txt", "feature\n", "feature work");
    g(repoDir, "checkout main");
    ensureStream(tracker, { branch: "feature-x", agentId: "team-sidecar" });

    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    await watcher._ready;

    // Merge feature-x into main with a real merge commit.
    g(repoDir, "merge --no-ff -m 'merge feature-x' feature-x");
    const mergeSha = g(repoDir, "rev-parse HEAD");
    await watcher._tickNow();

    const merged = conn.callsFor("stream.merged");
    expect(merged.length).toBe(1);
    const p = merged[0].params;
    expect(p.merge_commit).toBe(mergeSha);
    expect(typeof p.target_stream_id).toBe("string");
    expect(p.target_stream_id.length).toBeGreaterThan(0);
    // 2nd parent = feature-x head.
    expect(p.source_commit).toBe(g(repoDir, "rev-parse feature-x"));
  });

  it("stamps agent_id and task_ref when a fresh attribution hint exists", async () => {
    const conn = makeMockConnection();
    const taskRef = { resource_id: "task://x/1", node_id: "n1" };
    const getAttribution = () => ({ agentId: "agent-7", taskRef, ts: Date.now() });

    watcher = startCascadeWatcher({
      tracker, connection: conn, repoPath: repoDir, getAttribution,
    });
    await watcher._ready;
    commitFile(repoDir, "x.txt", "x\n", "attributed commit");
    await watcher._tickNow();

    const committed = conn.callsFor("stream.committed");
    expect(committed.length).toBe(1);
    expect(committed[0].params.agent_id).toBe("agent-7");
    expect(committed[0].params.metadata.task_ref).toEqual(taskRef);
  });

  it("omits attribution when the hint is stale", async () => {
    const conn = makeMockConnection();
    // Hint timestamped well beyond the staleness window.
    const getAttribution = () => ({
      agentId: "agent-stale",
      taskRef: { resource_id: "task://x/2", node_id: "n2" },
      ts: Date.now() - 120_000,
    });

    watcher = startCascadeWatcher({
      tracker, connection: conn, repoPath: repoDir, getAttribution,
    });
    await watcher._ready;
    commitFile(repoDir, "y.txt", "y\n", "stale commit");
    await watcher._tickNow();

    const committed = conn.callsFor("stream.committed");
    expect(committed.length).toBe(1);
    expect(committed[0].params.agent_id).toBe("");
    expect(committed[0].params.metadata.task_ref).toBeUndefined();
  });

  it("omits attribution when no hint is available", async () => {
    const conn = makeMockConnection();
    watcher = startCascadeWatcher({
      tracker, connection: conn, repoPath: repoDir,
      getAttribution: () => null,
    });
    await watcher._ready;
    commitFile(repoDir, "z.txt", "z\n", "no-hint commit");
    await watcher._tickNow();

    const committed = conn.callsFor("stream.committed");
    expect(committed.length).toBe(1);
    expect(committed[0].params.agent_id).toBe("");
  });

  it("re-asserts stream.opened for tracked streams on start", async () => {
    const conn = makeMockConnection();
    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });

    // reassertStreams runs in the start IIFE — await it via _ready.
    await watcher._ready;

    const opened = conn.callsFor("stream.opened");
    expect(opened.length).toBeGreaterThanOrEqual(1);
    expect(opened.some((c) => c.params.metadata?.trigger === "reassert")).toBe(true);
  });

  it("emits stream.opened for a newly-appeared local branch", async () => {
    const conn = makeMockConnection();
    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    await watcher._ready;
    const openedBefore = conn.callsFor("stream.opened").length;

    // A new branch appears after the baseline.
    g(repoDir, "branch new-feature");
    await watcher._tickNow();

    const opened = conn.callsFor("stream.opened");
    expect(opened.length).toBeGreaterThan(openedBefore);
    const newBranchEvent = opened.find((c) => c.params.branch_name === "new-feature");
    expect(newBranchEvent).toBeTruthy();
    expect(newBranchEvent.params.metadata?.trigger).toBe("watcher-new-branch");
  });

  it("emits stream.pushed when a remote ref catches up to a local branch", async () => {
    const conn = makeMockConnection();

    // Set up a bare remote and push main once so a remote-tracking ref exists.
    const remoteDir = makeTmpDir("cascade-remote-");
    g(remoteDir, "init --bare");
    g(repoDir, `remote add origin ${remoteDir}`);
    g(repoDir, "push -u origin main");

    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    await watcher._ready;

    // New commit + push — the remote-tracking ref advances.
    commitFile(repoDir, "pushed.txt", "p\n", "pushed work");
    g(repoDir, "push origin main");
    const pushedSha = g(repoDir, "rev-parse HEAD");
    await watcher._tickNow();

    const pushed = conn.callsFor("stream.pushed");
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    const ev = pushed.find((c) => c.params.pushed_commit === pushedSha);
    expect(ev).toBeTruthy();
    expect(ev.params.remote).toBe("origin");
    expect(ev.params.remote_ref).toBe("main");

    cleanupTmpDir(remoteDir);
  });

  it("a bad tick never throws — watcher survives a broken repo path", async () => {
    const conn = makeMockConnection();
    watcher = startCascadeWatcher({
      tracker, connection: conn, repoPath: path.join(repoDir, "does-not-exist"),
    });
    await expect(watcher._tickNow()).resolves.not.toThrow();
  });

  it("does not emit feature-branch commits as stream.committed against target after merge", async () => {
    const conn = makeMockConnection();

    // Create a feature branch with two commits, then switch back to main.
    g(repoDir, "checkout -b feature-y");
    commitFile(repoDir, "feat-y-1.txt", "y1\n", "feature-y work 1");
    commitFile(repoDir, "feat-y-2.txt", "y2\n", "feature-y work 2");
    const featureHead = g(repoDir, "rev-parse HEAD");
    g(repoDir, "checkout main");

    // Register the feature stream so the watcher knows about it.
    ensureStream(tracker, { branch: "feature-y", agentId: "team-sidecar" });

    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    await watcher._ready;

    // Add a commit directly on main (distinct from the feature work).
    const mainCommit = commitFile(repoDir, "main-work.txt", "m\n", "main work");

    // Merge feature-y into main with a real merge commit (--no-ff).
    g(repoDir, "merge --no-ff -m 'merge feature-y' feature-y");
    const mergeSha = g(repoDir, "rev-parse HEAD");
    await watcher._tickNow();

    // stream.committed should include the main work commit but NOT the two
    // feature-y commits — --first-parent excludes the merged-in side history.
    const committed = conn.callsFor("stream.committed");
    const hashes = committed.map((c) => c.params.commit_hash);
    expect(hashes).toContain(mainCommit);
    expect(hashes).not.toContain(featureHead);
    // The merge commit itself is never emitted as stream.committed (emitMerge handles it).
    expect(hashes).not.toContain(mergeSha);
    // Exactly one stream.committed for the main work commit (not 3 for all three).
    expect(committed.length).toBe(1);

    // stream.merged is emitted for the merge commit.
    const merged = conn.callsFor("stream.merged");
    expect(merged.length).toBe(1);
    expect(merged[0].params.merge_commit).toBe(mergeSha);
  });

  it("stop() is idempotent and never throws", () => {
    const conn = makeMockConnection();
    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    expect(() => { watcher.stop(); watcher.stop(); }).not.toThrow();
  });
});

describe("cascade-watcher — stream.conflicted / stream.conflict_resolved", () => {
  let repoDir;
  let dbPath;
  let tracker;
  let watcher;

  beforeEach(async () => {
    repoDir = makeTmpDir("cascade-watcher-conflict-");
    dbPath = path.join(repoDir, "tracker.db");
    makeGitRepo(repoDir);
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    ensureStream(tracker, { branch: "main", agentId: "team-sidecar" });
    watcher = null;
  });

  afterEach(() => {
    if (watcher) {
      try { watcher.stop(); } catch { /* ignore */ }
      watcher = null;
    }
    if (tracker) {
      closeCascadeTracker(tracker);
      tracker = null;
    }
    cleanupTmpDir(repoDir);
  });

  /**
   * Set up two divergent branches that touch the same file at the same line —
   * `git merge --no-ff feature` on main then produces a conflict. Returns the
   * feature-branch HEAD SHA so tests can assert on `conflicting_commit`.
   */
  function makeDivergent() {
    // Seed a shared file on main first.
    fs.writeFileSync(path.join(repoDir, "shared.txt"), "base\n");
    g(repoDir, "add -A");
    g(repoDir, 'commit -m "seed shared"');

    g(repoDir, "checkout -b feature");
    fs.writeFileSync(path.join(repoDir, "shared.txt"), "feature change\n");
    g(repoDir, "add -A");
    g(repoDir, 'commit -m "feature edit"');
    const featureHead = g(repoDir, "rev-parse HEAD");

    g(repoDir, "checkout main");
    fs.writeFileSync(path.join(repoDir, "shared.txt"), "main change\n");
    g(repoDir, "add -A");
    g(repoDir, 'commit -m "main edit"');
    return featureHead;
  }

  /** `git merge --no-ff feature` that we expect to fail with a conflict. */
  function startConflictingMerge() {
    try {
      execSync("git merge --no-ff -m 'merge feature' feature", {
        cwd: repoDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Expected — the merge fails with a conflict, MERGE_HEAD now exists.
    }
  }

  it("emits stream.conflicted then stream.conflict_resolved with 'manual' when resolved by commit", async () => {
    const conn = makeMockConnection();
    const featureHead = makeDivergent();

    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    await watcher._ready;

    // Trigger the conflict, then tick: expect one stream.conflicted.
    startConflictingMerge();
    await watcher._tickNow();

    const conflicted = conn.callsFor("stream.conflicted");
    expect(conflicted.length).toBe(1);
    const cp = conflicted[0].params;
    expect(cp.conflicted_files).toContain("shared.txt");
    expect(cp.conflicting_commit).toBe(featureHead);
    expect(cp.source).toBe("merge");
    expect(typeof cp.stream_id).toBe("string");
    expect(cp.stream_id.length).toBeGreaterThan(0);
    expect(typeof cp.conflict_id).toBe("string");
    expect(cp.conflict_id.length).toBeGreaterThan(0);
    // No spurious second emit while the conflict is open.
    await watcher._tickNow();
    expect(conn.callsFor("stream.conflicted").length).toBe(1);
    expect(conn.callsFor("stream.conflict_resolved").length).toBe(0);

    // Manually resolve and commit — HEAD advances to a merge commit (2 parents).
    fs.writeFileSync(path.join(repoDir, "shared.txt"), "manually resolved\n");
    g(repoDir, "add -A");
    g(repoDir, 'commit -m "resolve merge"');

    await watcher._tickNow();

    const resolved = conn.callsFor("stream.conflict_resolved");
    expect(resolved.length).toBe(1);
    const rp = resolved[0].params;
    expect(rp.resolution_method).toBe("manual");
    expect(rp.stream_id).toBe(cp.stream_id);
    expect(rp.conflict_id).toBe(cp.conflict_id);
  });

  it("emits stream.conflict_resolved with 'abandoned' when the merge is aborted", async () => {
    const conn = makeMockConnection();
    makeDivergent();

    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    await watcher._ready;

    startConflictingMerge();
    await watcher._tickNow();
    expect(conn.callsFor("stream.conflicted").length).toBe(1);

    // Abort the merge — MERGE_HEAD goes away, HEAD unchanged.
    g(repoDir, "merge --abort");
    await watcher._tickNow();

    const resolved = conn.callsFor("stream.conflict_resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0].params.resolution_method).toBe("abandoned");
  });

  it("never emits stream.conflicted in a clean repo with no merge state", async () => {
    const conn = makeMockConnection();
    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    await watcher._ready;

    // A few innocent ticks with no merge state.
    await watcher._tickNow();
    commitFile(repoDir, "clean.txt", "clean\n", "clean commit");
    await watcher._tickNow();
    await watcher._tickNow();

    expect(conn.callsFor("stream.conflicted").length).toBe(0);
    expect(conn.callsFor("stream.conflict_resolved").length).toBe(0);
  });
});
