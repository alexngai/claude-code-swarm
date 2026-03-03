/**
 * cli.mjs — Claude CLI invocation helper for e2e tests
 *
 * Uses --output-format stream-json which produces newline-delimited JSON
 * (one JSON object per line) containing the full message stream including
 * system messages, assistant tool_use blocks, and the final result.
 *
 * IMPORTANT: Uses spawn with stdio: ['ignore', 'pipe', 'pipe'] to close
 * stdin immediately. Without this, claude -p hangs waiting for stdin EOF.
 *
 * All CLI invocations are logged to e2e/logs/<timestamp>-<label>.log
 * for post-run debugging. Feed these back to diagnose failures.
 */

import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.resolve(__dirname, "../..");
export const DEFAULT_MODEL = process.env.E2E_MODEL || "sonnet";
export const DEFAULT_BUDGET = process.env.E2E_BUDGET || "0.50";

const LOG_DIR = path.resolve(__dirname, "..", "logs");

// Preflight: check if claude CLI is available
export let CLI_AVAILABLE = false;
try {
  execSync("which claude", { stdio: "ignore" });
  CLI_AVAILABLE = true;
} catch {
  CLI_AVAILABLE = false;
}

/**
 * Build a clean environment for the child claude process.
 * Strips env vars from any parent Claude Code session that would
 * confuse the child into thinking it's already inside a session.
 */
function cleanEnv() {
  const env = { ...process.env };

  // Remove vars that tell claude it's inside an existing session
  const stripPrefixes = ["CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_SESSION", "CLAUDE_CONVERSATION"];
  for (const key of Object.keys(env)) {
    if (stripPrefixes.some((p) => key.startsWith(p))) {
      delete env[key];
    }
  }

  // Re-add only the ones we explicitly want
  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

  return env;
}

/** Ensure log directory exists. */
function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/** Sanitize a string for use as a filename. */
function sanitizeLabel(s) {
  return s
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

/**
 * Write a log file for a CLI invocation.
 * Returns the log file path.
 */
function writeLog(label, { args, exitCode, stdout, stderr, error, messages, result, durationMs }) {
  ensureLogDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ts}-${sanitizeLabel(label)}.log`;
  const logPath = path.join(LOG_DIR, filename);

  const sections = [
    `# E2E Log: ${label}`,
    `# Timestamp: ${new Date().toISOString()}`,
    `# Duration: ${durationMs}ms`,
    "",
    "## Command",
    `claude ${args.join(" ")}`,
    "",
    "## Exit Code",
    String(exitCode),
    "",
  ];

  if (error) {
    sections.push("## Error", String(error), "");
  }

  sections.push(
    "## Stderr",
    stderr || "(empty)",
    "",
    "## Parsed Messages Summary",
    `Total messages: ${messages?.length ?? 0}`,
  );

  if (messages?.length > 0) {
    const typeCounts = {};
    for (const m of messages) {
      const key = m.subtype ? `${m.type}/${m.subtype}` : m.type;
      typeCounts[key] = (typeCounts[key] || 0) + 1;
    }
    sections.push(`Message types: ${JSON.stringify(typeCounts)}`);

    // Tool calls (handles both direct content and nested message.content)
    const toolCalls = [];
    for (const m of messages) {
      const content = (m.type === "assistant" && Array.isArray(m.content))
        ? m.content
        : (m.type === "assistant" && Array.isArray(m.message?.content))
          ? m.message.content
          : null;
      if (content) {
        for (const b of content) {
          if (b.type === "tool_use") toolCalls.push(b.name);
        }
      }
      if (m.type === "content_block_start" && m.content_block?.type === "tool_use") {
        toolCalls.push(m.content_block.name);
      }
    }
    if (toolCalls.length > 0) {
      sections.push(`Tool calls: ${toolCalls.join(", ")}`);
    }
  }

  if (result) {
    sections.push(
      "",
      "## Result",
      JSON.stringify(result, null, 2),
    );
  }

  sections.push(
    "",
    "## Raw Stdout",
    stdout || "(empty)",
  );

  fs.writeFileSync(logPath, sections.join("\n"), "utf-8");
  return logPath;
}

/**
 * Parse newline-delimited JSON (stream-json format).
 * Each line is a separate JSON object.
 */
function parseStreamJson(stdout) {
  const messages = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // skip non-JSON lines
    }
  }
  return messages;
}

/**
 * Spawn claude with stdin closed (/dev/null).
 * Returns { exitCode, stdout, stderr, killed }.
 *
 * This is critical: execFile leaves stdin as an open pipe, and claude -p
 * hangs waiting for stdin EOF. Using spawn with stdio 'ignore' connects
 * stdin to /dev/null which provides immediate EOF.
 */
function spawnClaude(args, options = {}) {
  const { cwd, timeout = 180_000, env } = options;

  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: env || cleanEnv(),
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let killed = false;

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: killed ? 143 : (code || 0),
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        killed,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: err.message,
        killed: false,
      });
    });
  });
}

/**
 * Invoke the claude CLI in non-interactive print mode.
 * Returns { messages, result, exitCode, stderr, stdout, logFile }.
 *
 * Uses stream-json format to capture the full message stream including
 * tool calls, system messages, and the final result.
 */
export function runClaude(prompt, options = {}) {
  const {
    cwd,
    model = DEFAULT_MODEL,
    maxBudgetUsd = DEFAULT_BUDGET,
    maxTurns,
    timeout = 180_000,
    label = prompt.slice(0, 40),
    extraArgs = [],
  } = options;

  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--plugin-dir", PLUGIN_DIR,
    "--model", model,
    "--max-budget-usd", String(maxBudgetUsd),
    "--no-session-persistence",
    "--dangerously-skip-permissions",
  ];

  if (maxTurns !== undefined) {
    args.push("--max-turns", String(maxTurns));
  }

  args.push(...extraArgs);

  const startTime = Date.now();

  return spawnClaude(args, { cwd, timeout }).then(({ exitCode, stdout, stderr, killed }) => {
    const durationMs = Date.now() - startTime;
    let messages = [];
    let result = null;

    // stream-json: newline-delimited JSON objects
    messages = parseStreamJson(stdout);

    // Find the result message
    result = messages.find((m) => m.type === "result") || null;

    const logFile = writeLog(label, {
      args, exitCode, stdout, stderr,
      error: killed ? "Process killed by timeout" : null,
      messages, result, durationMs,
    });

    return {
      messages,
      result,
      exitCode,
      stderr,
      stdout,
      logFile,
    };
  });
}

/**
 * Run only initialization hooks (no LLM call).
 * Uses --init-only to trigger SessionStart hooks and exit.
 * Returns { exitCode, stderr, stdout, logFile }.
 */
export function runInitOnly(options = {}) {
  const {
    cwd,
    timeout = 30_000,
    label = "init-only",
    extraArgs = [],
  } = options;

  const args = [
    "--init-only",
    "--plugin-dir", PLUGIN_DIR,
    "--dangerously-skip-permissions",
    ...extraArgs,
  ];

  const startTime = Date.now();

  return spawnClaude(args, { cwd, timeout }).then(({ exitCode, stdout, stderr, killed }) => {
    const durationMs = Date.now() - startTime;

    const logFile = writeLog(label, {
      args, exitCode, stdout, stderr,
      error: killed ? "Process killed by timeout" : null,
      messages: [], result: null, durationMs,
    });

    return {
      exitCode,
      stderr,
      stdout,
      logFile,
    };
  });
}
