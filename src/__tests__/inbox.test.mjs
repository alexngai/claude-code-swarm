import { describe, it, expect } from "vitest";
import { formatInboxAsMarkdown, formatAge } from "../inbox.mjs";

describe("inbox", () => {
  describe("formatAge", () => {
    it("returns '<1s' for ms < 1000", () => {
      expect(formatAge(500)).toBe("<1s");
    });

    it("returns seconds for ms < 60000", () => {
      expect(formatAge(5000)).toBe("5s");
    });

    it("returns minutes for ms < 3600000", () => {
      expect(formatAge(120000)).toBe("2m");
    });

    it("returns hours for ms >= 3600000", () => {
      expect(formatAge(3600000)).toBe("1h");
    });

    it("rounds correctly at boundaries", () => {
      expect(formatAge(999)).toBe("<1s");
      expect(formatAge(1000)).toBe("1s");
      expect(formatAge(59999)).toBe("60s");
      expect(formatAge(60000)).toBe("1m");
    });
  });

  describe("formatInboxAsMarkdown", () => {
    it("returns empty string for empty messages array", () => {
      expect(formatInboxAsMarkdown([])).toBe("");
    });

    it("formats single message with from and age", () => {
      const md = formatInboxAsMarkdown([{ from: "agent-1", timestamp: new Date().toISOString(), payload: "hello" }]);
      expect(md).toContain("**From agent-1**");
      expect(md).toContain("1 external message");
    });

    it("formats agent-inbox style messages with sender_id and content", () => {
      const md = formatInboxAsMarkdown([{
        sender_id: "agent-2",
        created_at: new Date().toISOString(),
        content: { type: "text", text: "hello from inbox" },
      }]);
      expect(md).toContain("**From agent-2**");
      expect(md).toContain("> hello from inbox");
    });

    it("formats string payload as blockquote", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: "hello world" }]);
      expect(md).toContain("> hello world");
    });

    it("formats typed payload with type and description", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: { type: "task", description: "Do X" } }]);
      expect(md).toContain("[task] Do X");
    });

    it("formats text content type with text field", () => {
      const md = formatInboxAsMarkdown([{ from: "a", content: { type: "text", text: "hello" } }]);
      expect(md).toContain("> hello");
    });

    it("formats raw object payload as JSON", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: { foo: "bar" } }]);
      expect(md).toContain(JSON.stringify({ foo: "bar" }));
    });

    it("includes priority when not 'normal'", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: "x", meta: { priority: "high" } }]);
      expect(md).toContain("Priority: high");
    });

    it("includes importance when not 'normal'", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: "x", importance: "high" }]);
      expect(md).toContain("Priority: high");
    });

    it("omits priority when 'normal'", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: "x", meta: { priority: "normal" } }]);
      expect(md).not.toContain("Priority:");
    });

    it("pluralizes header for multiple messages", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: "x" }, { from: "b", payload: "y" }]);
      expect(md).toContain("2 external messages");
    });

    it("shows singular header for single message", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: "x" }]);
      expect(md).toContain("1 external message");
      expect(md).not.toContain("messages");
    });

    it("handles missing timestamp gracefully", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: "x" }]);
      expect(md).toContain("unknown");
    });

    it("handles missing from field", () => {
      const md = formatInboxAsMarkdown([{ payload: "x" }]);
      expect(md).toContain("unknown");
    });
  });
});
