/**
 * content-provider.mjs — Trajectory content provider for claude-code-swarm
 *
 * Provides session transcript content for on-demand trajectory/content requests
 * from the hub. Reads from sessionlog's session state to find the transcript,
 * then serves the raw Claude Code JSONL.
 *
 * Two content sources:
 * 1. Live session: reads directly from state.transcriptPath (active JSONL file)
 * 2. Committed checkpoint: reads from sessionlog's checkpoint store (full.jsonl)
 *
 * Returns { metadata, transcript, prompts, context } matching the
 * SessionContentProvider type from @multi-agent-protocol/sdk.
 */

import fs from "fs";
import path from "path";
import { SESSIONLOG_DIR } from "./paths.mjs";
import { resolvePackage } from "./swarmkit-resolver.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger("content-provider");

/**
 * Create a content provider function for the sidecar.
 * The provider receives a checkpointId and returns transcript content.
 *
 * For live sessions, checkpointId may be the session ID or a checkpoint ID.
 * We search sessionlog state to find the transcript path.
 *
 * @returns {Function} SessionContentProvider-compatible async function
 */
export function createContentProvider() {
  return async function provideContent(checkpointId) {
    try {
      // 1. Try to find a live session with this checkpoint or session ID
      const liveContent = await readLiveSessionContent(checkpointId);
      if (liveContent) return liveContent;

      // 2. Try to read from committed checkpoint store
      const committedContent = await readCommittedContent(checkpointId);
      if (committedContent) return committedContent;

      log.warn("content not found for checkpoint", { checkpointId });
      return null;
    } catch (err) {
      log.warn("content provider error", { checkpointId, error: err.message });
      return null;
    }
  };
}

/**
 * Read transcript content from a live (non-ended) sessionlog session.
 * Searches all session state files for one that matches the checkpoint ID
 * or has a matching session ID, then reads the transcript from disk.
 */
async function readLiveSessionContent(checkpointId) {
  if (!fs.existsSync(SESSIONLOG_DIR)) return null;

  let files;
  try {
    files = fs.readdirSync(SESSIONLOG_DIR).filter(f => f.endsWith(".json"));
  } catch {
    return null;
  }

  for (const f of files) {
    try {
      const statePath = path.join(SESSIONLOG_DIR, f);
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));

      // Match by session ID, checkpoint ID, or checkpoint in turnCheckpointIDs
      const isMatch =
        state.sessionID === checkpointId ||
        state.lastCheckpointID === checkpointId ||
        (state.turnCheckpointIDs || []).includes(checkpointId);

      if (!isMatch) continue;

      // Read the transcript from the path stored in session state
      const transcriptPath = state.transcriptPath;
      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        log.warn("transcript path not found", { sessionID: state.sessionID, transcriptPath });
        continue;
      }

      const transcript = fs.readFileSync(transcriptPath, "utf-8");

      // Extract prompts from transcript (user messages)
      const prompts = extractPrompts(transcript);

      return {
        metadata: {
          sessionID: state.sessionID,
          phase: state.phase,
          stepCount: state.stepCount || 0,
          filesTouched: state.filesTouched || [],
          tokenUsage: state.tokenUsage || {},
          startedAt: state.startedAt,
          endedAt: state.endedAt,
          source: "live",
        },
        transcript,
        prompts,
        context: `Session ${state.sessionID} (${state.phase})`,
      };
    } catch {
      // Skip malformed files
    }
  }

  return null;
}

/**
 * Read transcript content from sessionlog's committed checkpoint store.
 * Uses sessionlog's library API via resolvePackage.
 */
async function readCommittedContent(checkpointId) {
  try {
    const sessionlogMod = await resolvePackage("sessionlog");
    if (!sessionlogMod?.createCheckpointStore) return null;

    const store = sessionlogMod.createCheckpointStore();
    if (!store?.readSessionContent) return null;

    // Try reading committed content (session index 0)
    const content = await store.readSessionContent(checkpointId, 0);
    if (!content) return null;

    return {
      metadata: {
        ...content.metadata,
        source: "committed",
      },
      transcript: content.transcript,
      prompts: content.prompts,
      context: content.context,
    };
  } catch {
    return null;
  }
}

/**
 * Extract user prompts from a Claude Code JSONL transcript.
 */
function extractPrompts(transcript) {
  const prompts = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user") {
        const msg = entry.message;
        if (typeof msg === "string") {
          prompts.push(msg);
        } else if (msg?.content) {
          if (typeof msg.content === "string") {
            prompts.push(msg.content);
          } else if (Array.isArray(msg.content)) {
            const text = msg.content
              .filter(b => b.type === "text" && b.text)
              .map(b => b.text)
              .join("\n");
            if (text) prompts.push(text);
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  return prompts.join("\n---\n");
}
