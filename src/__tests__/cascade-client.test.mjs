/**
 * cascade-client.test.mjs — git-cascade tracker ownership (Phase 1)
 *
 * Exercises openCascadeTracker / ensureStream / closeCascadeTracker against a
 * real temp git repo with a couple of branches. git-cascade is resolved at
 * runtime via swarmkit-resolver, so these tests require git-cascade to be
 * importable from the workspace.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  openCascadeTracker,
  ensureStream,
  closeCascadeTracker,
  findStreamByBranch,
  recordObservedCommit,
  recordObservedMerge,
} from "../cascade-client.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

/**
 * Create a real git repo with an initial commit and a couple of branches.
 * Leaves `main` (or the default branch) checked out.
 */
function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  execSync("git config commit.gpgsign false", { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "initial"', { cwd: dir, stdio: "pipe" });
  // Create a couple of extra branches.
  execSync("git branch feature-a", { cwd: dir, stdio: "pipe" });
  execSync("git branch feature-b", { cwd: dir, stdio: "pipe" });
}

/** Current branch name of a repo. */
function currentBranch(dir) {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** HEAD commit SHA of a repo (optionally a specific rev). */
function headSha(dir, rev = "HEAD") {
  return execSync(`git rev-parse ${rev}`, {
    cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

describe("cascade-client", () => {
  let repoDir;
  let dbPath;
  let tracker;

  beforeEach(() => {
    repoDir = makeTmpDir("cascade-test-");
    dbPath = path.join(repoDir, "tracker.db");
    makeGitRepo(repoDir);
    tracker = null;
  });

  afterEach(() => {
    if (tracker) {
      closeCascadeTracker(tracker);
      tracker = null;
    }
    cleanupTmpDir(repoDir);
  });

  it("openCascadeTracker returns a tracker for a git repo", async () => {
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    expect(tracker).not.toBeNull();
    expect(typeof tracker.trackExistingBranch).toBe("function");
  });

  it("openCascadeTracker returns null for a non-git directory", async () => {
    const nonGit = makeTmpDir("cascade-nongit-");
    try {
      const t = await openCascadeTracker({
        repoPath: nonGit,
        dbPath: path.join(nonGit, "tracker.db"),
      });
      expect(t).toBeNull();
    } finally {
      cleanupTmpDir(nonGit);
    }
  });

  it("ensureStream creates a stream for the working branch", async () => {
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    expect(tracker).not.toBeNull();

    const branch = currentBranch(repoDir);
    const result = ensureStream(tracker, { branch, agentId: "team-sidecar" });

    expect(result).not.toBeNull();
    expect(result.created).toBe(true);
    expect(typeof result.streamId).toBe("string");
    expect(result.streamId.length).toBeGreaterThan(0);
  });

  it("ensureStream is idempotent on a second call for the same branch", async () => {
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    expect(tracker).not.toBeNull();

    const branch = currentBranch(repoDir);
    const first = ensureStream(tracker, { branch, agentId: "team-sidecar" });
    const second = ensureStream(tracker, { branch, agentId: "team-sidecar" });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.streamId).toBe(first.streamId);
  });

  it("ensureStream tracks distinct branches as separate streams", async () => {
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    expect(tracker).not.toBeNull();

    const a = ensureStream(tracker, { branch: "feature-a", agentId: "team-sidecar" });
    const b = ensureStream(tracker, { branch: "feature-b", agentId: "team-sidecar" });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.streamId).not.toBe(b.streamId);
  });

  it("ensureStream returns null when tracker is missing", () => {
    expect(ensureStream(null, { branch: "main", agentId: "x" })).toBeNull();
  });

  it("closeCascadeTracker is a safe no-op on null", () => {
    expect(() => closeCascadeTracker(null)).not.toThrow();
  });

  it("closeCascadeTracker closes an open tracker", async () => {
    const t = await openCascadeTracker({ repoPath: repoDir, dbPath });
    expect(t).not.toBeNull();
    expect(() => closeCascadeTracker(t)).not.toThrow();
  });

  it("findStreamByBranch resolves a tracked branch and returns null otherwise", async () => {
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    expect(tracker).not.toBeNull();

    const branch = currentBranch(repoDir);
    const created = ensureStream(tracker, { branch, agentId: "team-sidecar" });
    expect(created).not.toBeNull();

    expect(findStreamByBranch(tracker, branch)).toBe(created.streamId);
    expect(findStreamByBranch(tracker, "no-such-branch")).toBeNull();
    expect(findStreamByBranch(null, branch)).toBeNull();
  });

  it("recordObservedCommit persists a change and returns its id", async () => {
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    expect(tracker).not.toBeNull();

    const branch = currentBranch(repoDir);
    const stream = ensureStream(tracker, { branch, agentId: "team-sidecar" });
    expect(stream).not.toBeNull();

    const commit = headSha(repoDir);
    const changeId = await recordObservedCommit(tracker, {
      streamId: stream.streamId,
      commit,
      description: "initial",
    });

    expect(typeof changeId).toBe("string");
    expect(changeId.length).toBeGreaterThan(0);
  });

  it("recordObservedCommit returns null when tracker is missing", async () => {
    const result = await recordObservedCommit(null, {
      streamId: "s1", commit: "abc", description: "x",
    });
    expect(result).toBeNull();
  });

  it("recordObservedMerge persists a merge edge and returns its id", async () => {
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    expect(tracker).not.toBeNull();

    const target = ensureStream(tracker, { branch: currentBranch(repoDir), agentId: "team-sidecar" });
    const source = ensureStream(tracker, { branch: "feature-a", agentId: "team-sidecar" });
    expect(target).not.toBeNull();
    expect(source).not.toBeNull();

    const mergeCommit = headSha(repoDir);
    const mergeId = await recordObservedMerge(tracker, {
      sourceStreamId: source.streamId,
      sourceCommit: headSha(repoDir, "feature-a"),
      targetStreamId: target.streamId,
      mergeCommit,
      metadata: { trigger: "test" },
    });

    expect(typeof mergeId).toBe("string");
    expect(mergeId.length).toBeGreaterThan(0);
  });

  it("recordObservedMerge returns null when required fields are missing", async () => {
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    expect(tracker).not.toBeNull();
    const result = await recordObservedMerge(tracker, { sourceStreamId: "s1" });
    expect(result).toBeNull();
  });
});
