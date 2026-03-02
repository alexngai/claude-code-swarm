/**
 * inbox.mjs — MAP inbox management for claude-code-swarm
 *
 * Handles reading, formatting, clearing, and writing the inbox.jsonl file
 * that bridges MAP messages into Claude's context.
 */

import fs from "fs";
import { INBOX_PATH } from "./paths.mjs";

/**
 * Read and parse all messages from the inbox.
 * Returns an array of parsed message objects. Never throws.
 */
export function readInbox(inboxPath = INBOX_PATH) {
  try {
    const content = fs.readFileSync(inboxPath, "utf-8").trim();
    if (!content) return [];

    const messages = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Clear the inbox file.
 */
export function clearInbox(inboxPath = INBOX_PATH) {
  try {
    fs.writeFileSync(inboxPath, "");
  } catch {
    // Non-critical
  }
}

/**
 * Append a message to the inbox as an NDJSON line.
 * Used by the sidecar to write incoming MAP messages.
 */
export function writeToInbox(message, inboxPath = INBOX_PATH) {
  fs.appendFileSync(inboxPath, JSON.stringify(message) + "\n");
}

/**
 * Format inbox messages as markdown for injection into Claude's context.
 * Returns empty string if no messages.
 */
export function formatInboxAsMarkdown(messages) {
  if (!messages.length) return "";

  const now = Date.now();
  const lines = [
    `## [MAP] ${messages.length} external message${messages.length > 1 ? "s" : ""}`,
    "",
  ];

  for (const msg of messages) {
    const from = msg.from || "unknown";
    const age = msg.timestamp
      ? formatAge(now - new Date(msg.timestamp).getTime())
      : "unknown";
    const priority = msg.meta?.priority;
    const payload = msg.payload || {};

    lines.push(`**From ${from}** (${age} ago)`);

    if (typeof payload === "string") {
      lines.push(`> ${payload}`);
    } else if (payload.type) {
      lines.push(
        `> [${payload.type}] ${payload.description || payload.message || JSON.stringify(payload)}`
      );
    } else {
      lines.push(`> ${JSON.stringify(payload)}`);
    }

    if (priority && priority !== "normal") {
      lines.push(`> Priority: ${priority}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format a millisecond duration as a human-readable age string.
 */
export function formatAge(ms) {
  if (ms < 1000) return "<1s";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}
