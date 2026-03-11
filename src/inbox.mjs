/**
 * inbox.mjs — Inbox formatting for claude-code-swarm
 *
 * Provides markdown formatting for messages retrieved via agent-inbox IPC.
 */

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
    const from = msg.from || msg.sender_id || "unknown";
    const age = msg.timestamp || msg.created_at
      ? formatAge(now - new Date(msg.timestamp || msg.created_at).getTime())
      : "unknown";
    const priority = msg.meta?.priority || msg.importance;
    const payload = msg.payload || msg.content || {};

    lines.push(`**From ${from}** (${age} ago)`);

    if (typeof payload === "string") {
      lines.push(`> ${payload}`);
    } else if (payload.type === "text" && payload.text) {
      lines.push(`> ${payload.text}`);
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
