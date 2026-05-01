/**
 * Loadout schema bridge — tripwire test.
 *
 * Asserts that the openteams `loadout.skills` schema (SkillsConfig) and
 * skilltree-client's bridge mapping stay in sync. skill-tree is the
 * mechanism; openteams' `loadout.skills` is the declaration that
 * dispatches into it.
 *
 * What this test catches:
 *   - openteams adds a new field to SkillsConfig and the bridge doesn't
 *     update OPENTEAMS_BRIDGED_FIELDS / mergeOpenteamsSkillsIntoCriteria.
 *   - The bridge claims to handle a field that openteams' schema no
 *     longer declares (drift the other direction).
 *   - The merge semantics regress (profile replace, include/exclude
 *     union-with-dedup, max_tokens → maxTokens rename).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import {
  OPENTEAMS_BRIDGED_FIELDS,
  mergeOpenteamsSkillsIntoCriteria,
} from "../skilltree-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate openteams' loadout schema. Prefers the sibling-repo layout used
 * by the openhive monorepo (`references/openteams/...`); falls back to a
 * node_modules install for cc-swarm checked out standalone.
 */
function findOpenteamsSchema() {
  const candidates = [
    // sibling repo layout (e.g. openhive's references/)
    path.resolve(__dirname, "../../../openteams/schema/loadout.schema.json"),
    // npm install in cc-swarm itself
    path.resolve(__dirname, "../../node_modules/openteams/schema/loadout.schema.json"),
    // npm install one level up
    path.resolve(__dirname, "../../../node_modules/openteams/schema/loadout.schema.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readSkillsConfigFields() {
  const schemaPath = findOpenteamsSchema();
  if (!schemaPath) {
    throw new Error(
      "openteams loadout.schema.json not found — install openteams or check out as a sibling repo",
    );
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const props = schema?.$defs?.SkillsConfig?.properties;
  if (!props) {
    throw new Error(`SkillsConfig.properties missing in ${schemaPath}`);
  }
  return Object.keys(props);
}

describe("loadout schema bridge — openteams ↔ skill-tree", () => {
  describe("schema convergence", () => {
    it("OPENTEAMS_BRIDGED_FIELDS matches openteams SkillsConfig.properties", () => {
      const schemaFields = readSkillsConfigFields();
      const bridged = [...OPENTEAMS_BRIDGED_FIELDS];
      expect(bridged.sort()).toEqual([...schemaFields].sort());
    });

    it("openteams SkillsConfig is closed (additionalProperties: false)", () => {
      // The bridge relies on `properties` being the complete set. If
      // openteams ever loosens this, the convergence guarantee breaks
      // and the test above can pass while real loadouts carry fields
      // we don't bridge.
      const schemaPath = findOpenteamsSchema();
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
      expect(schema.$defs.SkillsConfig.additionalProperties).toBe(false);
    });
  });

  describe("mergeOpenteamsSkillsIntoCriteria", () => {
    it("returns a copy when loadoutSkills is undefined", () => {
      const input = { profile: "baseline", tags: ["a"] };
      const out = mergeOpenteamsSkillsIntoCriteria(input, undefined);
      expect(out).toEqual(input);
      expect(out).not.toBe(input);
    });

    it("returns a copy when loadoutSkills is null", () => {
      const input = { profile: "baseline" };
      const out = mergeOpenteamsSkillsIntoCriteria(input, null);
      expect(out).toEqual(input);
      expect(out).not.toBe(input);
    });

    it("returns an empty object when both inputs are absent", () => {
      const out = mergeOpenteamsSkillsIntoCriteria(undefined, undefined);
      expect(out).toEqual({});
    });

    it("profile replaces (not merges) when set", () => {
      const out = mergeOpenteamsSkillsIntoCriteria(
        { profile: "baseline" },
        { profile: "security" },
      );
      expect(out.profile).toBe("security");
    });

    it("profile preserved when openteams.skills.profile is empty", () => {
      const out = mergeOpenteamsSkillsIntoCriteria(
        { profile: "baseline" },
        { include: ["x"] },
      );
      expect(out.profile).toBe("baseline");
    });

    it("include/exclude union-with-dedup", () => {
      const out = mergeOpenteamsSkillsIntoCriteria(
        { include: ["a", "b"], exclude: ["x"] },
        { include: ["b", "c"], exclude: ["x", "y"] },
      );
      expect([...out.include].sort()).toEqual(["a", "b", "c"]);
      expect([...out.exclude].sort()).toEqual(["x", "y"]);
    });

    it("max_tokens renames to maxTokens", () => {
      const out = mergeOpenteamsSkillsIntoCriteria({}, { max_tokens: 4000 });
      expect(out.maxTokens).toBe(4000);
      expect(out.max_tokens).toBeUndefined();
    });

    it("max_tokens replaces when set", () => {
      const out = mergeOpenteamsSkillsIntoCriteria(
        { maxTokens: 8000 },
        { max_tokens: 4000 },
      );
      expect(out.maxTokens).toBe(4000);
    });

    it("preserves criteria fields openteams does not declare", () => {
      // skill-tree's LoadoutCriteria is a superset — fields like `tags`,
      // `tagsAll`, `taskDescription`, `keywords` come from the
      // skilltree: extension or defaultProfile path, not from openteams.
      const out = mergeOpenteamsSkillsIntoCriteria(
        {
          profile: "baseline",
          tags: ["typescript"],
          tagsAll: ["safe"],
          taskDescription: "audit a flow",
          keywords: ["frontend"],
          maxSkills: 6,
        },
        { profile: "security", include: ["must-have"] },
      );
      expect(out.profile).toBe("security");
      expect(out.tags).toEqual(["typescript"]);
      expect(out.tagsAll).toEqual(["safe"]);
      expect(out.taskDescription).toBe("audit a flow");
      expect(out.keywords).toEqual(["frontend"]);
      expect(out.maxSkills).toBe(6);
      expect(out.include).toEqual(["must-have"]);
    });

    it("does not mutate the input criteria object", () => {
      const input = { profile: "baseline", include: ["a"] };
      const before = JSON.stringify(input);
      mergeOpenteamsSkillsIntoCriteria(input, {
        profile: "security",
        include: ["b"],
      });
      expect(JSON.stringify(input)).toBe(before);
    });
  });
});
