/**
 * assertions.mjs — Tool call extraction and assertion helpers for e2e tests
 *
 * Handles messages from --output-format stream-json (newline-delimited JSON).
 * Each message is a JSON object with a `type` field. Common types:
 *   - "system" (subtypes: "init", "hook_response", "hook_started")
 *   - "assistant" (content array with "text" and "tool_use" blocks)
 *   - "user" (content array with "tool_result" blocks)
 *   - "result" (final result with cost and metadata)
 */

/**
 * Extract all tool_use calls from the message stream.
 * Returns array of { name, input, id } objects.
 *
 * Handles multiple message formats:
 *   - Assistant messages: { type: "assistant", content: [{ type: "tool_use", ... }] }
 *   - Content block events: { type: "content_block_start", content_block: { type: "tool_use", ... } }
 */
export function extractToolCalls(messages) {
  const calls = [];
  for (const msg of messages) {
    // Standard assistant message with content array
    if (msg.type === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          calls.push({
            name: block.name,
            input: block.input || {},
            id: block.id,
          });
        }
      }
      continue;
    }

    // Content block start event (stream-json)
    if (
      msg.type === "content_block_start" &&
      msg.content_block?.type === "tool_use"
    ) {
      calls.push({
        name: msg.content_block.name,
        input: msg.content_block.input || {},
        id: msg.content_block.id,
      });
      continue;
    }

    // Nested message wrapper (some stream-json variants)
    if (msg.message?.content && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          calls.push({
            name: block.name,
            input: block.input || {},
            id: block.id,
          });
        }
      }
    }
  }
  return calls;
}

/**
 * Extract tool calls by name. Returns array of matching tool call inputs.
 */
export function findToolCalls(messages, toolName) {
  return extractToolCalls(messages)
    .filter((tc) => tc.name === toolName)
    .map((tc) => tc.input);
}

/**
 * Assert that a specific tool was called at least once.
 * Returns the matching call inputs.
 */
export function expectToolCalled(messages, toolName) {
  const calls = findToolCalls(messages, toolName);
  expect(calls.length).toBeGreaterThan(0);
  return calls;
}

/**
 * Assert that a tool was called with specific input properties.
 */
export function expectToolCalledWith(messages, toolName, inputMatch) {
  const calls = findToolCalls(messages, toolName);
  expect(calls).toEqual(
    expect.arrayContaining([expect.objectContaining(inputMatch)])
  );
  return calls;
}

/**
 * Get the final result message.
 */
export function getResult(messages) {
  return messages.find((m) => m.type === "result") || null;
}

/**
 * Extract hook output text from system messages.
 *
 * Hook responses can appear in various forms:
 *   - { type: "system", subtype: "hook_response", stdout: "...", output: "..." }
 *   - { type: "system", subtype: "init", content: "..." }
 *   - { type: "system", content: "..." } or { type: "system", content: [...] }
 */
export function getHookOutput(messages) {
  return messages
    .filter(
      (m) =>
        m.type === "system" &&
        (m.subtype === "hook_response" ||
          m.subtype === "hook_started" ||
          m.subtype === "init")
    )
    .map((m) => {
      const parts = [];

      // Hook-specific fields
      if (m.stdout) parts.push(m.stdout);
      if (m.output) parts.push(m.output);

      // Content field (string or array)
      if (typeof m.content === "string") {
        parts.push(m.content);
      } else if (Array.isArray(m.content)) {
        parts.push(
          m.content
            .map((c) => (typeof c === "string" ? c : c.text || ""))
            .join("\n")
        );
      }

      // If nothing else, stringify the whole message
      if (parts.length === 0) {
        parts.push(JSON.stringify(m));
      }

      return parts.join("\n");
    })
    .join("\n");
}

/**
 * Concatenate all assistant text blocks into a single string.
 * Handles both direct content and nested message.content (stream-json format).
 */
export function getAssistantText(messages) {
  const texts = [];
  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    const content = msg.content || msg.message?.content || [];
    for (const block of content) {
      if (block.type === "text") texts.push(block.text);
    }
  }
  return texts.join("\n");
}
