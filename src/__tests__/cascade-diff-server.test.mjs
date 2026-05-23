/**
 * cascade-diff-server.test.mjs — cascade diff server (Phase 3)
 *
 * Exercises setupCascadeDiffServer against a real temp git repo with a mocked
 * MAP connection that captures sendNotification calls. Covers single-commit
 * diffs, range diffs, files_only, large-diff chunking (seq/final/sha256), and
 * the typed error reply for a bad request.
 *
 * Also includes the Phase 3 stacking verification: a branch forked from a
 * tracked branch emits `x-cascade/stream.opened` with `parent_stream` set, and
 * the tracker DB records the parent edge.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { setupCascadeDiffServer } from "../cascade-diff-server.mjs";
import { openCascadeTracker, ensureStream, findStreamByBranch, closeCascadeTracker } from "../cascade-client.mjs";
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
  return g(dir, "rev-parse HEAD");
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
 * Mock MAP connection — captures every sendNotification(method, params) call
 * and lets the test fire a registered onNotification handler.
 */
function makeMockConnection() {
  const sent = [];
  const handlers = new Map();
  return {
    sent,
    handlers,
    onNotification(method, handler) {
      handlers.set(method, handler);
    },
    offNotification(method) {
      handlers.delete(method);
    },
    sendNotification(method, params) {
      sent.push({ method, params });
      return Promise.resolve();
    },
    /** Sent notifications for a given cascade method. */
    sentFor(method) {
      return sent.filter((s) => s.method === method);
    },
    /** Fire the registered handler for `method` and await it. */
    async fire(method, params) {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`no handler for ${method}`);
      await handler(params);
    },
  };
}

describe("cascade-diff-server", () => {
  let repoDir;
  let dbDir;
  let dbPath;
  let tracker;
  let dispose;

  beforeEach(async () => {
    repoDir = makeTmpDir("cascade-diff-");
    // Keep the tracker DB outside the repo so `git add -A` never stages it
    // into a diff under test.
    dbDir = makeTmpDir("cascade-diff-db-");
    dbPath = path.join(dbDir, "tracker.db");
    makeGitRepo(repoDir);
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    ensureStream(tracker, { branch: "main", agentId: "team-sidecar" });
    dispose = null;
  });

  afterEach(() => {
    if (dispose) {
      try { dispose(); } catch { /* ignore */ }
      dispose = null;
    }
    if (tracker) {
      closeCascadeTracker(tracker);
      tracker = null;
    }
    cleanupTmpDir(repoDir);
    cleanupTmpDir(dbDir);
  });

  it("serves a single-commit diff inline", async () => {
    const conn = makeMockConnection();
    dispose = setupCascadeDiffServer(conn, { repoPath: repoDir, tracker });

    const sha = commitFile(repoDir, "feature.txt", "hello world\n", "add feature");
    const streamId = findStreamByBranch(tracker, "main");

    await conn.fire("cascade/diff.request", {
      request_id: "req-1",
      stream_id: streamId,
      head: sha,
      format: "unified",
    });

    const responses = conn.sentFor("cascade/diff.response");
    expect(responses.length).toBe(1);
    const p = responses[0].params;
    expect(p.request_id).toBe("req-1");
    expect(p.streaming).toBe(false);
    expect(p.diff).toContain("feature.txt");
    expect(p.diff).toContain("+hello world");
    expect(p.files_touched).toContain("feature.txt");
    expect(p.truncated).toBe(false);
  });

  it("serves a range diff for base..head", async () => {
    const conn = makeMockConnection();
    dispose = setupCascadeDiffServer(conn, { repoPath: repoDir, tracker });

    const base = g(repoDir, "rev-parse HEAD");
    commitFile(repoDir, "a.txt", "alpha\n", "add a");
    const head = commitFile(repoDir, "b.txt", "beta\n", "add b");
    const streamId = findStreamByBranch(tracker, "main");

    await conn.fire("cascade/diff.request", {
      request_id: "req-range",
      stream_id: streamId,
      head,
      base,
      format: "unified",
    });

    const responses = conn.sentFor("cascade/diff.response");
    expect(responses.length).toBe(1);
    const p = responses[0].params;
    expect(p.streaming).toBe(false);
    // Both commits in the range are present.
    expect(p.diff).toContain("a.txt");
    expect(p.diff).toContain("b.txt");
    expect(p.files_touched.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("returns only file names when files_only is set", async () => {
    const conn = makeMockConnection();
    dispose = setupCascadeDiffServer(conn, { repoPath: repoDir, tracker });

    const sha = commitFile(repoDir, "src/x.txt", "x\n", "add x");
    const streamId = findStreamByBranch(tracker, "main");

    await conn.fire("cascade/diff.request", {
      request_id: "req-files",
      stream_id: streamId,
      head: sha,
      files_only: true,
      format: "unified",
    });

    const responses = conn.sentFor("cascade/diff.response");
    expect(responses.length).toBe(1);
    const p = responses[0].params;
    expect(p.streaming).toBe(false);
    // files_only: no diff body, just the file list.
    expect(p.diff).toBe("");
    expect(p.files_touched).toEqual(["src/x.txt"]);
  });

  it("streams a large diff in seq-ordered chunks with a final sha256", async () => {
    const conn = makeMockConnection();
    dispose = setupCascadeDiffServer(conn, { repoPath: repoDir, tracker });

    // A >512 KB file forces the streaming path (inline threshold is 512 KB).
    const bigContent = "lorem ipsum dolor sit amet\n".repeat(40_000); // ~1.05 MB
    const sha = commitFile(repoDir, "big.txt", bigContent, "add big file");
    const streamId = findStreamByBranch(tracker, "main");

    await conn.fire("cascade/diff.request", {
      request_id: "req-big",
      stream_id: streamId,
      head: sha,
      format: "unified",
    });

    // Announcement.
    const responses = conn.sentFor("cascade/diff.response");
    expect(responses.length).toBe(1);
    const ann = responses[0].params;
    expect(ann.streaming).toBe(true);
    expect(typeof ann.chunk_stream_id).toBe("string");
    expect(ann.total_size).toBeGreaterThan(512 * 1024);
    expect(ann.files_touched).toContain("big.txt");

    // Chunks: contiguous seq from 0, exactly one final.
    const chunks = conn.sentFor("cascade/diff.chunk");
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.params.chunk_stream_id).toBe(ann.chunk_stream_id);
      expect(c.params.seq).toBe(i);
    });
    const finalChunks = chunks.filter((c) => c.params.final === true);
    expect(finalChunks.length).toBe(1);
    expect(finalChunks[0]).toBe(chunks[chunks.length - 1]);

    // Reassemble in seq order and verify sha256 over the full payload.
    const assembled = Buffer.concat(
      chunks.map((c) => Buffer.from(c.params.data, "base64")),
    );
    expect(assembled.length).toBe(ann.total_size);
    const got = createHash("sha256").update(assembled).digest("hex");
    expect(got).toBe(finalChunks[0].params.sha256);
    expect(assembled.toString("utf-8")).toContain("big.txt");
  });

  it("replies with the typed error variant for a bad request", async () => {
    const conn = makeMockConnection();
    dispose = setupCascadeDiffServer(conn, { repoPath: repoDir, tracker });

    // Missing head — a malformed request.
    await conn.fire("cascade/diff.request", {
      request_id: "req-bad",
      stream_id: "stream-x",
    });

    const responses = conn.sentFor("cascade/diff.response");
    expect(responses.length).toBe(1);
    expect(responses[0].params.request_id).toBe("req-bad");
    expect(responses[0].params.error).toBeTruthy();
    expect(responses[0].params.error.code).toBe("bad_request");
  });

  it("replies with the error variant when git fails on a bad commit", async () => {
    const conn = makeMockConnection();
    dispose = setupCascadeDiffServer(conn, { repoPath: repoDir, tracker });

    const streamId = findStreamByBranch(tracker, "main");
    await conn.fire("cascade/diff.request", {
      request_id: "req-nogit",
      stream_id: streamId,
      head: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      format: "unified",
    });

    const responses = conn.sentFor("cascade/diff.response");
    expect(responses.length).toBe(1);
    expect(responses[0].params.request_id).toBe("req-nogit");
    expect(responses[0].params.error).toBeTruthy();
    expect(responses[0].params.error.code).toBe("internal");
  });

  it("never throws — ignores a request with no request_id", async () => {
    const conn = makeMockConnection();
    dispose = setupCascadeDiffServer(conn, { repoPath: repoDir, tracker });
    await expect(conn.fire("cascade/diff.request", {})).resolves.not.toThrow();
    expect(conn.sentFor("cascade/diff.response").length).toBe(0);
  });

  it("dispose() unregisters the handler and is idempotent", () => {
    const conn = makeMockConnection();
    const d = setupCascadeDiffServer(conn, { repoPath: repoDir, tracker });
    expect(conn.handlers.has("cascade/diff.request")).toBe(true);
    d();
    expect(conn.handlers.has("cascade/diff.request")).toBe(false);
    expect(() => d()).not.toThrow();
  });

  it("returns a no-op dispose when the connection cannot register handlers", () => {
    const d = setupCascadeDiffServer({}, { repoPath: repoDir, tracker });
    expect(typeof d).toBe("function");
    expect(() => d()).not.toThrow();
  });
});

describe("cascade stacking — forked branch carries parent_stream", () => {
  let repoDir;
  let dbDir;
  let dbPath;
  let tracker;
  let watcher;

  /** Mock MAP connection capturing callExtension calls (watcher emit path). */
  function makeEmitConnection() {
    const calls = [];
    return {
      calls,
      callExtension(method, params) {
        calls.push({ method, params });
        return Promise.resolve({ ok: true });
      },
      callsFor(suffix) {
        return calls.filter((c) => c.method.endsWith(suffix));
      },
    };
  }

  beforeEach(async () => {
    repoDir = makeTmpDir("cascade-stack-");
    dbDir = makeTmpDir("cascade-stack-db-");
    dbPath = path.join(dbDir, "tracker.db");
    makeGitRepo(repoDir);
    tracker = await openCascadeTracker({ repoPath: repoDir, dbPath });
    // Track `main` so the watcher can resolve it as the fork parent.
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
    cleanupTmpDir(dbDir);
  });

  it("emits stream.opened with parent_stream and records the parent edge in the tracker DB", async () => {
    const conn = makeEmitConnection();
    watcher = startCascadeWatcher({ tracker, connection: conn, repoPath: repoDir });
    await watcher._ready;

    const mainStreamId = findStreamByBranch(tracker, "main");
    expect(mainStreamId).toBeTruthy();

    // Fork a new branch off main's HEAD (a clean fork — main's HEAD is the
    // fork point), then detect it with a tick.
    g(repoDir, "branch feature-stack");
    await watcher._tickNow();

    // The stream.opened event for the forked branch carries parent_stream.
    const opened = conn.callsFor("stream.opened");
    const forkEvent = opened.find((c) => c.params.branch_name === "feature-stack");
    expect(forkEvent).toBeTruthy();
    expect(forkEvent.params.parent_stream).toBe(mainStreamId);

    // The tracker DB recorded the parent edge — listStreams exposes it so the
    // hub's PR-stack walker can traverse parent → child.
    const forkStreamId = findStreamByBranch(tracker, "feature-stack");
    expect(forkStreamId).toBeTruthy();
    const streams = tracker.listStreams();
    const forkRow = streams.find((s) => s.id === forkStreamId);
    expect(forkRow).toBeTruthy();
    // git-cascade records the parent edge on the stream row.
    const recordedParent = forkRow.parent_stream ?? forkRow.parentStream ?? forkRow.parent_stream_id;
    expect(recordedParent).toBe(mainStreamId);
  });
});
