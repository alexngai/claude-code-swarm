/**
 * Loadout template shape — runtime-shape verification.
 *
 * Loads the openteams `loadout-demo` template via `TemplateLoader.load()`
 * and verifies that `template.roles.<name>.loadout.skills.*` keeps the
 * snake_case field names declared in the JSON schema. The bridge
 * (`mergeOpenteamsSkillsIntoCriteria`) reads `max_tokens` — if the loader
 * normalizes to camelCase server-side, the bridge would produce wrong
 * output silently.
 *
 * This test is the ground-truth check that the schema field names match
 * the runtime shape consumed by the bridge.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOADOUT_DEMO = path.resolve(
  __dirname,
  "../../../openteams/examples/loadout-demo",
);

function openteamsAvailable() {
  try {
    const cwd = path.resolve(__dirname, "../..");
    require.resolve("openteams", { paths: [cwd] });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !fs.existsSync(LOADOUT_DEMO) || !openteamsAvailable();

describe.skipIf(SKIP)("loadout template shape (openteams runtime)", () => {
  /** @type {import('openteams')} */
  let ot;
  /** @type {import('openteams').ResolvedTemplate} */
  let template;

  it("loads loadout-demo via openteams TemplateLoader", async () => {
    ot = await import("openteams");
    expect(ot.TemplateLoader).toBeDefined();
    template = ot.TemplateLoader.load(LOADOUT_DEMO);
    expect(template).toBeDefined();
    expect(template.roles).toBeDefined();
  });

  it("template.roles is a Map keyed by role name", () => {
    // Bridge code calls .get() — fail loudly if the runtime shape is plain object.
    expect(template.roles instanceof Map).toBe(true);
    expect(template.roles.has("reviewer")).toBe(true);
    expect(template.roles.has("implementer")).toBe(true);
  });

  it("reviewer role has a loadout with skills (extends chain resolved)", () => {
    const role = template.roles.get("reviewer");
    expect(role?.loadout).toBeDefined();
    expect(role.loadout.skills).toBeDefined();
  });

  it("loadout.skills retains snake_case field name max_tokens (NOT maxTokens)", () => {
    // This is the load-bearing assertion. The bridge in
    // skilltree-client.mjs reads `loadoutSkills.max_tokens`. If the
    // loader normalized to camelCase, the bridge would never see the
    // value and silently produce LoadoutCriteria with no maxTokens.
    const reviewer = template.roles.get("reviewer");
    const skills = reviewer.loadout.skills;

    expect(Object.prototype.hasOwnProperty.call(skills, "max_tokens")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(skills, "maxTokens")).toBe(false);
    expect(typeof skills.max_tokens).toBe("number");
  });

  it("reviewer's max_tokens is inherited from code-reviewer parent (30000)", () => {
    // Sanity check that `extends:` resolution flowed through; otherwise
    // the field-name test above could be a false positive on a
    // self-declared value.
    const skills = template.roles.get("reviewer").loadout.skills;
    expect(skills.max_tokens).toBe(30000);
  });

  it("loadout.skills.profile is camelCase-free string (no normalization)", () => {
    // Profile is single-word so it can't visibly normalize, but assert
    // the key is `profile` (not `Profile` or similar) and the value is
    // a string, just to lock the shape.
    const skills = template.roles.get("reviewer").loadout.skills;
    expect(typeof skills.profile).toBe("string");
    expect(skills.profile.length).toBeGreaterThan(0);
  });

  it("loadout.skills.include is an array of skill ids", () => {
    const skills = template.roles.get("reviewer").loadout.skills;
    expect(Array.isArray(skills.include)).toBe(true);
    // reviewer extends security-auditor (extends code-reviewer);
    // include is unioned across the chain.
    expect(skills.include.length).toBeGreaterThan(0);
  });
});
