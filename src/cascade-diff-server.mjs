/**
 * cascade-diff-server.mjs — services `cascade/diff.request` notifications.
 *
 * Phase 3 of cascade integration. The OpenHive hub fetches unified diffs from
 * the cc-swarm sidecar on demand so its cascade changelog/diff endpoints work
 * for cc-swarm-tracked streams. Flow:
 *
 *   1. Hub sends `cascade/diff.request` with `request_id`, `stream_id`,
 *      `head`, optional `base` / `file_paths` / `files_only`.
 *   2. This handler shells out to plain `git show` / `git diff` in the repo
 *      cwd and produces a unified-diff blob (or a name-only list when
 *      `files_only: true`).
 *   3. Response is emitted as a `cascade/diff.response` notification —
 *      inline when ≤ 512 KB, streamed via N `cascade/diff.chunk`
 *      notifications when larger.
 *
 * cc-swarm runs git-cascade in **local mode** — there are no worktrees. The
 * `head` / `base` in the request are commit hashes and self-identifying, so
 * stream → diff resolution is just `git` against the single repo cwd; the
 * `stream_id` is validated against the tracker but never used to pick a path.
 *
 * The 50 MB raw cap (`MAX_DIFF_BYTES`) defends against runaway monorepo
 * diffs. Errors fold into the same `cascade/diff.response` method via the
 * `error` shape — this handler never throws.
 */

import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import { createLogger } from "./log.mjs";

const log = createLogger("cascade-diff");

const REQUEST_METHOD = "cascade/diff.request";
const RESPONSE_METHOD = "cascade/diff.response";
const CHUNK_METHOD = "cascade/diff.chunk";

/** Reply inline when the raw diff is at or below this size. */
const INLINE_THRESHOLD_BYTES = 512 * 1024;
/** Per-chunk payload size for streamed diffs (mirrors sync-client STREAM_CHUNK_SIZE). */
const CHUNK_SIZE_BYTES = 1024 * 1024;
/** Hard cap on captured git stdout — defends against runaway monorepo diffs. */
const MAX_DIFF_BYTES = 50 * 1024 * 1024;
/** Kill the git spawn after this long. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Register the `cascade/diff.request` handler on a MAP connection.
 *
 * @param {object} connection  MAP AgentConnection — must expose
 *   `onNotification(method, handler)` and `sendNotification(method, params)`.
 * @param {object} opts
 * @param {string} opts.repoPath  Path to the git repository (the swarm cwd).
 * @param {object} [opts.tracker] git-cascade tracker — used only to validate
 *   that `stream_id` is known; diff resolution never needs it.
 * @returns {Function} A dispose function — best-effort, never throws.
 */
export function setupCascadeDiffServer(connection, { repoPath, tracker } = {}) {
  if (!connection || typeof connection.onNotification !== "function") {
    log.debug("cascade diff server skipped: no MAP connection");
    return () => {};
  }
  if (typeof connection.sendNotification !== "function") {
    log.debug("cascade diff server skipped: connection cannot sendNotification");
    return () => {};
  }

  const handler = async (params) => {
    const req = params || null;
    if (!req || typeof req.request_id !== "string" || !req.request_id) return;
    if (!req.stream_id || !req.head) {
      sendError(connection, req.request_id, "bad_request", "missing stream_id or head");
      return;
    }

    log.info("cascade diff request", {
      requestId: req.request_id,
      streamId: req.stream_id,
      head: req.head,
      hasBase: Boolean(req.base),
      filesOnly: req.files_only === true,
    });

    // Best-effort stream validation. The tracker only carries local-mode
    // streams; an unknown stream id still resolves fine via git (head/base
    // are commit hashes), so a missing stream is a warning, not an error.
    if (tracker && typeof tracker.getStreamBranchName === "function") {
      try {
        tracker.getStreamBranchName(req.stream_id);
      } catch {
        log.debug("cascade diff: stream not tracked, resolving by commit hash", {
          streamId: req.stream_id,
        });
      }
    }

    let produced;
    try {
      produced = await runGit({
        repoPath,
        head: req.head,
        base: req.base,
        filePaths: Array.isArray(req.file_paths) ? req.file_paths : undefined,
        filesOnly: req.files_only === true,
      });
    } catch (err) {
      log.warn("cascade diff: git failed", { requestId: req.request_id, error: err.message });
      sendError(connection, req.request_id, "internal", `git failed: ${err.message}`);
      return;
    }

    try {
      if (produced.blob.length <= INLINE_THRESHOLD_BYTES) {
        await connection.sendNotification(RESPONSE_METHOD, {
          request_id: req.request_id,
          streaming: false,
          diff: produced.blob.toString("utf-8"),
          files_touched: produced.filesTouched,
          truncated: produced.truncated,
        });
        log.info("cascade diff response sent (inline)", {
          requestId: req.request_id,
          size: produced.blob.length,
        });
        return;
      }
      await streamLargeBlob(connection, req.request_id, produced);
    } catch (err) {
      log.warn("cascade diff: send failed", { requestId: req.request_id, error: err.message });
      sendError(connection, req.request_id, "internal", `send failed: ${err.message}`);
    }
  };

  connection.onNotification(REQUEST_METHOD, handler);
  log.info("cascade diff server registered", { repoPath });

  return () => {
    try {
      if (typeof connection.offNotification === "function") {
        connection.offNotification(REQUEST_METHOD, handler);
      }
    } catch { /* non-fatal */ }
  };
}

// ── Git shell-out ────────────────────────────────────────────────────────────

/**
 * Resolve a diff via plain git in the repo cwd.
 *
 * `head` / `base` are commit hashes — self-identifying, no worktree needed:
 *   - Single commit (no base): `git show <head>`.
 *   - Range (base present):    `git diff <base>..<head>`.
 * `files_only` swaps in `--name-only`. `files_touched` is always computed via
 * a separate `--name-only` invocation so it is correct even for full diffs.
 */
async function runGit({ repoPath, head, base, filePaths, filesOnly }) {
  const diffArgs = buildGitArgs({ head, base, filePaths, filesOnly });
  const captured = await spawnCapped(repoPath, diffArgs);

  // files_touched: always compute via --name-only, independent of filesOnly.
  let filesTouched;
  if (filesOnly) {
    filesTouched = parseNameOnly(captured.data);
  } else {
    const nameArgs = buildGitArgs({ head, base, filePaths, filesOnly: true });
    try {
      const names = await spawnCapped(repoPath, nameArgs);
      filesTouched = parseNameOnly(names.data);
    } catch {
      filesTouched = [];
    }
  }

  return {
    blob: filesOnly ? Buffer.from("") : captured.data,
    filesTouched,
    truncated: captured.truncated,
  };
}

/** Build the git argv for a diff / name-only request. */
function buildGitArgs({ head, base, filePaths, filesOnly }) {
  const paths = Array.isArray(filePaths) && filePaths.length > 0
    ? ["--", ...filePaths]
    : [];
  if (filesOnly) {
    if (base) {
      return ["diff", "--name-only", `${base}..${head}`, ...paths];
    }
    return ["show", "--name-only", "--format=", head, ...paths];
  }
  if (base) {
    return ["diff", "--no-textconv", "-U3", `${base}..${head}`, ...paths];
  }
  return ["show", "--no-textconv", "-U3", "--format=", head, ...paths];
}

/**
 * Spawn git, capture stdout up to MAX_DIFF_BYTES. Beyond that, drop the rest
 * and mark `truncated`. Kills after GIT_TIMEOUT_MS. Resolves on overflow /
 * timeout; rejects only on spawn error or non-zero exit.
 */
function spawnCapped(cwd, args) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }

    const parts = [];
    let total = 0;
    let truncated = false;
    let stderrBuf = "";
    let settled = false;

    const killTimer = setTimeout(() => {
      truncated = true;
      try { proc.kill("SIGKILL"); } catch { /* nothing to kill */ }
    }, GIT_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => {
      if (truncated) return;
      if (total + chunk.length > MAX_DIFF_BYTES) {
        const remaining = MAX_DIFF_BYTES - total;
        if (remaining > 0) parts.push(chunk.subarray(0, remaining));
        total = MAX_DIFF_BYTES;
        truncated = true;
        return;
      }
      parts.push(chunk);
      total += chunk.length;
    });

    proc.stderr.on("data", (chunk) => {
      if (stderrBuf.length < 8192) stderrBuf += chunk.toString("utf-8");
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(err);
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (code !== 0 && !truncated) {
        reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderrBuf.trim().slice(0, 200)}`));
        return;
      }
      resolve({ data: Buffer.concat(parts), truncated });
    });
  });
}

/** Parse `--name-only` output into a deduped list of file paths. */
function parseNameOnly(buf) {
  const seen = new Set();
  for (const line of buf.toString("utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed) seen.add(trimmed);
  }
  return Array.from(seen);
}

// ── Streaming ────────────────────────────────────────────────────────────────

/**
 * Send a large diff as a streaming announcement followed by base64 chunks.
 * The last chunk carries `final: true` + a sha256 over the full payload.
 */
async function streamLargeBlob(connection, requestId, produced) {
  const { blob, filesTouched, truncated } = produced;
  // A random nonce keeps two sidecars routing through the same hub from
  // colliding on the hub-side chunk-stream map even on a retried request_id.
  const chunkStreamId = `cdiff-${requestId}-${randomBytes(6).toString("hex")}`;

  await connection.sendNotification(RESPONSE_METHOD, {
    request_id: requestId,
    streaming: true,
    chunk_stream_id: chunkStreamId,
    total_size: blob.length,
    files_touched: filesTouched,
  });

  const sha = createHash("sha256").update(blob).digest("hex");
  const totalChunks = Math.max(1, Math.ceil(blob.length / CHUNK_SIZE_BYTES));

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE_BYTES;
    const end = Math.min(start + CHUNK_SIZE_BYTES, blob.length);
    const slice = blob.subarray(start, end);
    const isFinal = i === totalChunks - 1;
    await connection.sendNotification(CHUNK_METHOD, {
      chunk_stream_id: chunkStreamId,
      seq: i,
      data: slice.toString("base64"),
      ...(isFinal ? { final: true, sha256: sha, truncated } : {}),
    });
  }

  log.info("cascade diff response sent (streamed)", {
    requestId,
    size: blob.length,
    chunks: totalChunks,
  });
}

/** Reply with the typed error variant of `cascade/diff.response`. Never throws. */
function sendError(connection, requestId, code, message) {
  try {
    Promise.resolve(
      connection.sendNotification(RESPONSE_METHOD, {
        request_id: requestId,
        error: { code, message },
      }),
    ).catch((err) => log.warn("cascade diff: error reply failed", { requestId, error: err.message }));
  } catch (err) {
    log.warn("cascade diff: error reply threw", { requestId, error: err.message });
  }
}
