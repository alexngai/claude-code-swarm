/**
 * Full integration e2e — openteams declaration → cc-swarm bridge →
 * skill-tree compile → rendered output.
 *
 * Sets up a real (file-backed) skill-tree skill bank in a temp dir,
 * populates it with a couple of skills, then drives `compileAllRoleLoadouts`
 * with a hand-built openteams ResolvedTemplate. Asserts that the bridge
 * actually produces content for the role and that openteams field values
 * (include, max_tokens) survive the chain into skill-tree's compile.
 *
 * This closes the seam between the unit-tested bridge and the existing
 * cacheLoadoutArtifacts e2e — the compile path through skill-tree is
 * never exercised by either of those.
 *
 * Skips when skill-tree is unavailable.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { compileAllRoleLoadouts } from "../skilltree-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function skillTreeAvailable() {
  try {
    const cwd = path.resolve(__dirname, "../..");
    require.resolve("skill-tree", { paths: [cwd] });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !skillTreeAvailable();

function makeSkill(id, overrides = {}) {
  const now = new Date();
  return {
    id,
    name: overrides.name ?? id.replace(/-/g, " "),
    version: "1.0.0",
    description: overrides.description ?? `Test skill ${id}`,
    instructions:
      overrides.instructions ??
      `# ${id}\n\nThis is a test skill body for ${id}.`,
    author: "test",
    tags: overrides.tags ?? ["test"],
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...overrides,
  };
}

describe.skipIf(SKIP)(
  "loadout compile e2e — openteams → cc-swarm → skill-tree",
  () => {
    /** @type {string} */
    let basePath;
    /** @type {any} */
    let bank;

    beforeAll(async () => {
      // Sanity: importing skill-tree lazily mirrors how cc-swarm uses it.
      const st = await import("skill-tree");
      expect(st.createSkillBank).toBeDefined();
    });

    beforeEach(async () => {
      basePath = fs.mkdtempSync(
        path.join(os.tmpdir(), "loadout-compile-e2e-"),
      );
      const st = await import("skill-tree");
      bank = st.createSkillBank({ storage: { basePath } });
      await bank.initialize();
      await bank.saveSkill(makeSkill("alpha-skill"));
      await bank.saveSkill(makeSkill("beta-skill"));
      await bank.saveSkill(makeSkill("gamma-skill"));
      await bank.shutdown();
    });

    afterEach(() => {
      fs.rmSync(basePath, { recursive: true, force: true });
    });

    it("openteams loadout.skills.include reaches skill-tree compile and produces content", async () => {
      const manifest = { name: "test-team", roles: ["worker"] };
      const template = {
        roles: new Map([
          [
            "worker",
            {
              loadout: {
                skills: { include: ["alpha-skill"] },
              },
            },
          ],
        ]),
      };

      const result = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        template,
      );

      expect(result.worker).toBeDefined();
      expect(result.worker.content).toBeTruthy();
      expect(result.worker.content.length).toBeGreaterThan(0);
      // The included skill's id (or name) should appear somewhere in the
      // rendered system prompt.
      expect(result.worker.content.toLowerCase()).toContain("alpha");
    });

    it("openteams loadout.skills.max_tokens flows through to skill-tree's compiler", async () => {
      // Verifies plumbing, not skill-tree's own budgeting algorithm.
      // The strong claim is: a low budget must produce strictly less
      // content than a high budget. If `max_tokens` were silently dropped
      // by the bridge, both runs would render identically.
      const manifest = { name: "test-team", roles: ["worker"] };
      const include = ["alpha-skill", "beta-skill", "gamma-skill"];
      const buildTemplate = (max_tokens) => ({
        roles: new Map([
          ["worker", { loadout: { skills: { include, max_tokens } } }],
        ]),
      });

      const low = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        buildTemplate(1),
      );
      const high = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        buildTemplate(100000),
      );

      const lowLen = low.worker?.content?.length ?? 0;
      const highLen = high.worker?.content?.length ?? 0;
      expect(highLen).toBeGreaterThan(lowLen);
    });

    it("openteams loadout.skills.exclude filters skills out at compile time", async () => {
      const manifest = { name: "test-team", roles: ["worker"] };
      const templateWithExclude = {
        roles: new Map([
          [
            "worker",
            {
              loadout: {
                skills: {
                  include: ["alpha-skill", "beta-skill", "gamma-skill"],
                  exclude: ["beta-skill"],
                },
              },
            },
          ],
        ]),
      };

      const result = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        templateWithExclude,
      );
      expect(result.worker).toBeDefined();
      const content = result.worker.content.toLowerCase();
      expect(content).toContain("alpha");
      expect(content).toContain("gamma");
      expect(content).not.toContain("beta");
    });

    it("returns empty result for role with no loadout, no skilltree extension, no inferable profile", async () => {
      const manifest = { name: "test-team", roles: ["nonsense-role-xyz"] };
      const result = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        null,
      );
      expect(result["nonsense-role-xyz"]).toBeUndefined();
    });

    it("openteams loadout.skills overlays skilltree extension when both present", async () => {
      const manifest = {
        name: "test-team",
        roles: ["worker"],
        skilltree: {
          roles: { worker: { include: ["beta-skill"] } },
        },
      };
      const template = {
        roles: new Map([
          [
            "worker",
            {
              loadout: { skills: { include: ["alpha-skill"] } },
            },
          ],
        ]),
      };

      const result = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        template,
      );
      expect(result.worker).toBeDefined();
      // Both skills should appear — the bridge unions includes from
      // both sources rather than replacing.
      const content = result.worker.content.toLowerCase();
      expect(content).toContain("alpha");
      expect(content).toContain("beta");
    });
  },
);

// ────────────────────────────────────────────────────────────────
// Composite e2e — uses a real openteams template fixture, populates the
// skill bank with skills tagged to match skill-tree's built-in profiles,
// loads the template via TemplateLoader.load(), and runs the full chain.
//
// Closes three sub-gaps that the include-only tests above don't cover:
//   1. Profile-resolution path (setLoadoutFromProfile in compileRoleLoadout)
//   2. TemplateLoader → compileAllRoleLoadouts composite (no hand-built
//      template — the input is what openteams' loader produces)
//   3. `extends:` chain resolution feeding the compile (auditor extends
//      base-reviewer; child profile + inherited max_tokens both reach
//      skill-tree)
// ────────────────────────────────────────────────────────────────

const FIXTURE_TEAM_DIR = path.resolve(
  __dirname,
  "fixtures",
  "loadout-compile-team",
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

const SKIP_COMPOSITE =
  !skillTreeAvailable() ||
  !openteamsAvailable() ||
  !fs.existsSync(FIXTURE_TEAM_DIR);

describe.skipIf(SKIP_COMPOSITE)(
  "loadout compile e2e — TemplateLoader + extends + profile composite",
  () => {
    /** @type {string} */
    let basePath;

    beforeEach(async () => {
      basePath = fs.mkdtempSync(
        path.join(os.tmpdir(), "loadout-composite-e2e-"),
      );
      const st = await import("skill-tree");
      const bank = st.createSkillBank({ storage: { basePath } });
      await bank.initialize();

      // Skills tagged so skill-tree's built-in profiles select different
      // subsets, letting the extends-resolution test confirm the child
      // profile genuinely replaces the parent:
      //   - "code-review" profile (tags: review/quality/security/best-practices)
      //     → matches review-style, security-audit, best-practice-checker (3)
      //   - "security" profile (tagsAll: ['security'])
      //     → matches security-audit only (1)
      //
      // makeSkill's auto-derived name (id with hyphens → spaces) is what
      // skill-tree's markdown renderer puts in the table; assertions
      // match on the lowercase form.
      await bank.saveSkill(makeSkill("review-style", { tags: ["review", "quality"] }));
      await bank.saveSkill(makeSkill("security-audit", { tags: ["security", "review"] }));
      await bank.saveSkill(makeSkill("best-practice-checker", { tags: ["quality", "best-practices"] }));
      await bank.shutdown();
    });

    afterEach(() => {
      fs.rmSync(basePath, { recursive: true, force: true });
    });

    it("Gap 1 — built-in profile from openteams loadout reaches setLoadoutFromProfile and selects matching skills", async () => {
      // reviewer role → base-reviewer loadout → profile: code-review.
      // compileRoleLoadout dispatches to setLoadoutFromProfile (profile is
      // set), which uses the built-in code-review criteria (tags include
      // 'review' / 'quality' / 'best-practices'). All three fixture
      // skills should match.
      const ot = await import("openteams");
      const template = ot.TemplateLoader.load(FIXTURE_TEAM_DIR);
      const manifest = readManifestFromTemplate(template);

      const result = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        template,
      );

      expect(result.reviewer).toBeDefined();
      expect(result.reviewer.profile).toBe("code-review");
      expect(result.reviewer.content.length).toBeGreaterThan(0);

      const lower = result.reviewer.content.toLowerCase();
      // code-review profile picks up all three skills via tag-match.
      // The renderer shows skill `name` in the table; makeSkill defaults
      // name = id.replace('-', ' '), so we match on the spaced form.
      expect(lower).toContain("review style");
      expect(lower).toContain("best practice checker");
      expect(lower).toContain("security audit");
    });

    it("Gap 2 — full TemplateLoader.load() → compileAllRoleLoadouts composite produces content for every loadout-bearing role", async () => {
      const ot = await import("openteams");
      const template = ot.TemplateLoader.load(FIXTURE_TEAM_DIR);
      const manifest = readManifestFromTemplate(template);

      const result = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        template,
      );

      // Every role in the fixture has a loadout, so every role should
      // produce content.
      expect(result.reviewer).toBeDefined();
      expect(result.auditor).toBeDefined();
      expect(result["inline-extender"]).toBeDefined();

      // Profile selection per role
      expect(result.reviewer.profile).toBe("code-review");
      expect(result.auditor.profile).toBe("security");
      expect(result["inline-extender"].profile).toBe("code-review");
    });

    it("Gap 3 — extends: chain resolves into the compile path (auditor's child profile wins, parent max_tokens inherited)", async () => {
      const ot = await import("openteams");
      const template = ot.TemplateLoader.load(FIXTURE_TEAM_DIR);
      const manifest = readManifestFromTemplate(template);

      // Sanity at the load layer: auditor's resolved skills carry the
      // child's profile (security) AND the parent's max_tokens (30000).
      const auditorRole = template.roles.get("auditor");
      expect(auditorRole.loadout.skills.profile).toBe("security");
      expect(auditorRole.loadout.skills.max_tokens).toBe(30000);

      const result = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        template,
      );

      // auditor uses the security profile (replaces parent's code-review).
      // security has tags: ['security'] + tagsAll: ['security'], so only
      // security-audit (tagged 'security') matches — review-style and
      // best-practice-checker do not.
      expect(result.auditor).toBeDefined();
      expect(result.auditor.profile).toBe("security");
      const auditorContent = result.auditor.content.toLowerCase();
      expect(auditorContent).toContain("security audit");
      expect(auditorContent).not.toContain("review style");
      expect(auditorContent).not.toContain("best practice checker");

      // reviewer (parent profile = code-review) selects the broader set.
      // Proves the two profiles compile differently and the extends
      // override at load time genuinely reaches skill-tree.
      const reviewerContent = result.reviewer.content.toLowerCase();
      expect(reviewerContent).toContain("review style");
      expect(reviewerContent).toContain("best practice checker");
      // Reviewer's set is a strict superset of auditor's
      expect(reviewerContent.length).toBeGreaterThan(auditorContent.length);
    });

    it("Gap 3 — inline extends: composes capabilities + inherits skills.profile + max_tokens through compile", async () => {
      const ot = await import("openteams");
      const template = ot.TemplateLoader.load(FIXTURE_TEAM_DIR);
      const manifest = readManifestFromTemplate(template);

      // inline-extender's loadout is declared inline as `extends: base-reviewer`
      // with capabilities_add. Resolved skills should be base-reviewer's
      // (no inline override).
      const inlineRole = template.roles.get("inline-extender");
      expect(inlineRole.loadout.skills.profile).toBe("code-review");
      expect(inlineRole.loadout.skills.max_tokens).toBe(30000);
      // capabilities_add merged into capabilities at load time
      expect(inlineRole.loadout.capabilities).toContain("exec.run");
      expect(inlineRole.loadout.capabilities).toContain("file.read"); // inherited

      const result = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        template,
      );

      // Compiled with parent's profile, same as reviewer
      expect(result["inline-extender"]).toBeDefined();
      expect(result["inline-extender"].profile).toBe("code-review");
      const inlineContent = result["inline-extender"].content.toLowerCase();
      const reviewerContent = result.reviewer.content.toLowerCase();
      // Same profile → same selected skill ids
      expect(inlineContent).toContain("review style");
      expect(inlineContent).toContain("best practice checker");
      // Cross-check: same profile selects the same set. Compare key
      // markers rather than byte-equality so whitespace/ordering doesn't
      // make this brittle.
      for (const marker of [
        "review style",
        "best practice checker",
        "security audit",
      ]) {
        expect(inlineContent.includes(marker)).toBe(
          reviewerContent.includes(marker),
        );
      }
    });
  },
);

/**
 * Build a minimal team manifest from a ResolvedTemplate so the existing
 * compileAllRoleLoadouts signature (which expects a manifest with
 * `roles: string[]`) keeps working. The composite test loads via
 * TemplateLoader, so no team.yaml roundtrip is needed for the manifest.
 */
function readManifestFromTemplate(template) {
  return {
    name: template.manifest?.name ?? "fixture",
    roles: [...template.roles.keys()],
  };
}
