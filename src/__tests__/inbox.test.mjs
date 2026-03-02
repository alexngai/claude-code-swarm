import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { readInbox, clearInbox, writeToInbox, formatInboxAsMarkdown, formatAge } from "../inbox.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

describe("inbox", () => {
  let tmpDir;
  let inboxPath;
  beforeEach(() => {
    tmpDir = makeTmpDir();
    inboxPath = path.join(tmpDir, "inbox.jsonl");
  });
  afterEach(() => { cleanupTmpDir(tmpDir); });

  describe("readInbox", () => {
    it("returns empty array when file does not exist", () => {
      expect(readInbox(path.join(tmpDir, "nope.jsonl"))).toEqual([]);
    });

    it("returns empty array when file is empty", () => {
      fs.writeFileSync(inboxPath, "");
      expect(readInbox(inboxPath)).toEqual([]);
    });

    it("parses single NDJSON line", () => {
      fs.writeFileSync(inboxPath, JSON.stringify({ from: "a" }) + "\n");
      const msgs = readInbox(inboxPath);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].from).toBe("a");
    });

    it("parses multiple NDJSON lines", () => {
      const lines = [
        JSON.stringify({ from: "a" }),
        JSON.stringify({ from: "b" }),
      ].join("\n");
      fs.writeFileSync(inboxPath, lines);
      expect(readInbox(inboxPath)).toHaveLength(2);
    });

    it("skips malformed JSON lines without throwing", () => {
      fs.writeFileSync(inboxPath, `{"from":"a"}\nnot-json\n{"from":"b"}\n`);
      const msgs = readInbox(inboxPath);
      expect(msgs).toHaveLength(2);
    });

    it("skips blank lines", () => {
      fs.writeFileSync(inboxPath, `{"from":"a"}\n\n{"from":"b"}\n`);
      expect(readInbox(inboxPath)).toHaveLength(2);
    });
  });

  describe("writeToInbox", () => {
    it("creates file and writes first message as NDJSON", () => {
      writeToInbox({ from: "test" }, inboxPath);
      const content = fs.readFileSync(inboxPath, "utf-8");
      expect(content).toBe(JSON.stringify({ from: "test" }) + "\n");
    });

    it("appends subsequent messages on new lines", () => {
      writeToInbox({ id: 1 }, inboxPath);
      writeToInbox({ id: 2 }, inboxPath);
      const lines = fs.readFileSync(inboxPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
    });
  });

  describe("clearInbox", () => {
    it("empties an existing inbox file", () => {
      fs.writeFileSync(inboxPath, "some content");
      clearInbox(inboxPath);
      expect(fs.readFileSync(inboxPath, "utf-8")).toBe("");
    });

    it("does not throw when file does not exist", () => {
      expect(() => clearInbox(path.join(tmpDir, "nope.jsonl"))).not.toThrow();
    });
  });

  describe("round-trip", () => {
    it("write, read back, clear, read returns empty", () => {
      writeToInbox({ msg: "hello" }, inboxPath);
      writeToInbox({ msg: "world" }, inboxPath);
      const msgs = readInbox(inboxPath);
      expect(msgs).toHaveLength(2);
      clearInbox(inboxPath);
      expect(readInbox(inboxPath)).toEqual([]);
    });
  });

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

    it("formats string payload as blockquote", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: "hello world" }]);
      expect(md).toContain("> hello world");
    });

    it("formats typed payload with type and description", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: { type: "task", description: "Do X" } }]);
      expect(md).toContain("[task] Do X");
    });

    it("formats raw object payload as JSON", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: { foo: "bar" } }]);
      expect(md).toContain(JSON.stringify({ foo: "bar" }));
    });

    it("includes priority when not 'normal'", () => {
      const md = formatInboxAsMarkdown([{ from: "a", payload: "x", meta: { priority: "high" } }]);
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
