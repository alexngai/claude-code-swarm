/**
 * Unit tests for minimem → MAP sync bridge
 *
 * Tests the bridge command builder (map-events.mjs) that converts
 * minimem MCP tool usage into MAP sync commands.
 */

import { describe, it, expect } from "vitest";
import { buildMinimemBridgeCommand } from "../map-events.mjs";

describe("buildMinimemBridgeCommand", () => {
  describe("write operations (should emit)", () => {
    it("emits for memory_append tool", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__memory_append",
        tool_input: { text: "Decided to use Redis" },
        tool_output: '{"content":[{"text":"Appended to memory/2026-03-27.md"}]}',
      });

      expect(cmd).not.toBeNull();
      expect(cmd.action).toBe("bridge-memory-sync");
      expect(cmd.timestamp).toBeDefined();
    });

    it("emits for memory_upsert tool", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__memory_upsert",
        tool_input: { path: "memory/decision.md", content: "# Decision" },
      });

      expect(cmd).not.toBeNull();
      expect(cmd.action).toBe("bridge-memory-sync");
    });

    it("emits for tool names containing 'append'", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__appendToday",
        tool_input: { text: "some note" },
      });

      expect(cmd).not.toBeNull();
      expect(cmd.action).toBe("bridge-memory-sync");
    });

    it("emits for tool names containing 'upsert'", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__upsert_file",
        tool_input: { path: "memory/test.md" },
      });

      expect(cmd).not.toBeNull();
    });

    it("includes session_id as agentId", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__memory_append",
        tool_input: { text: "test" },
        session_id: "sess-abc-123",
      });

      expect(cmd.agentId).toBe("sess-abc-123");
    });

    it("defaults agentId to 'minimem' when no session_id", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__memory_append",
        tool_input: { text: "test" },
      });

      expect(cmd.agentId).toBe("minimem");
    });
  });

  describe("read operations (should NOT emit)", () => {
    it("does not emit for memory_search", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__memory_search",
        tool_input: { query: "redis caching" },
      });

      expect(cmd).toBeNull();
    });

    it("does not emit for memory_get_details", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__memory_get_details",
        tool_input: { results: [] },
      });

      expect(cmd).toBeNull();
    });

    it("does not emit for knowledge_search", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__knowledge_search",
        tool_input: { query: "database" },
      });

      expect(cmd).toBeNull();
    });

    it("does not emit for knowledge_graph", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__knowledge_graph",
        tool_input: { nodeId: "k-test" },
      });

      expect(cmd).toBeNull();
    });

    it("does not emit for knowledge_path", () => {
      const cmd = buildMinimemBridgeCommand({
        tool_name: "minimem__knowledge_path",
        tool_input: { fromId: "k-a", toId: "k-b" },
      });

      expect(cmd).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles missing tool_name", () => {
      const cmd = buildMinimemBridgeCommand({});
      expect(cmd).toBeNull();
    });

    it("handles empty tool_name", () => {
      const cmd = buildMinimemBridgeCommand({ tool_name: "" });
      expect(cmd).toBeNull();
    });
  });
});
