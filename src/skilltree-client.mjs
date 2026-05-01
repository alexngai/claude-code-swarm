/**
 * skilltree-client.mjs — Skill-tree loadout compilation for claude-code-swarm
 *
 * Compiles per-role skill loadouts from team.yaml skilltree extension.
 * Uses skill-tree's SkillBank + SkillGraphServer programmatically.
 * Results are cached per template alongside generated AGENT.md files.
 *
 * Never throws — returns empty results on any error (best-effort pattern).
 */

import fs from "fs";
import path from "path";
import { resolvePackage } from "./swarmkit-resolver.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger("skilltree");

let _skillTree = undefined;

/**
 * Load the skill-tree module. Returns null if not available.
 * Uses resolvePackage() for consistent global fallback resolution.
 */
async function loadSkillTree() {
  if (_skillTree !== undefined) return _skillTree;

  const mod = await resolvePackage("skill-tree");
  _skillTree = mod || null;
  return _skillTree;
}

/**
 * Parse the skilltree extension namespace from a team.yaml manifest.
 * Returns { defaults, roles } where defaults is a LoadoutCriteria
 * and roles is a map of roleName → LoadoutCriteria.
 *
 * team.yaml example:
 *   skilltree:
 *     defaults:
 *       profile: implementation
 *       maxSkills: 6
 *     roles:
 *       orchestrator:
 *         profile: code-review
 *       executor:
 *         profile: implementation
 *         tags: [development]
 *       verifier:
 *         profile: testing
 */
export function parseSkillTreeExtension(manifest) {
  const ext = manifest?.skilltree;
  if (!ext) return { defaults: {}, roles: {} };

  return {
    defaults: ext.defaults || {},
    roles: ext.roles || {},
  };
}

/**
 * Compile a skill loadout for a single role.
 * Creates a temporary SkillBank, sets the loadout via criteria or profile,
 * and returns the rendered markdown string.
 *
 * @param {string} roleName - Role name (for logging)
 * @param {object} criteria - LoadoutCriteria (profile, tags, maxSkills, etc.)
 * @param {object} config - Plugin config (skilltree section)
 * @returns {Promise<string>} Rendered loadout markdown, or empty string on failure
 */
export async function compileRoleLoadout(roleName, criteria, config) {
  const st = await loadSkillTree();
  if (!st?.createSkillBank) return "";

  try {
    // Determine skill bank base path
    const basePath = config?.basePath || ".swarm/skill-tree";

    // Only attempt if the base path exists
    if (!fs.existsSync(basePath)) return "";

    const bank = st.createSkillBank({
      storage: { basePath },
    });
    await bank.initialize();

    try {
      const { server } = await bank.createServingLayer({
        outputFormat: "markdown",
      });

      // Set loadout from profile or criteria
      if (criteria.profile) {
        try {
          await server.setLoadoutFromProfile(criteria.profile);
        } catch {
          // Profile not found — skip this role
          return "";
        }
      } else if (criteria.tags || criteria.include || criteria.taskDescription) {
        await server.setLoadout(criteria);
      } else {
        // No criteria specified
        return "";
      }

      return server.renderSystemPrompt();
    } finally {
      await bank.shutdown();
    }
  } catch (err) {
    log.warn("loadout compilation failed", { role: roleName, error: err.message });
    return "";
  }
}

/**
 * Role name → built-in profile auto-mapping.
 * Used as fallback when no explicit criteria or default profile is configured.
 */
const ROLE_PROFILE_MAP = {
  executor: "implementation",
  developer: "implementation",
  "quick-flow-dev": "implementation",
  debugger: "debugging",
  verifier: "testing",
  qa: "testing",
  "plan-checker": "code-review",
  "integration-checker": "code-review",
  "tech-writer": "documentation",
  architect: "refactoring",
  "ux-designer": "documentation",
  "security-auditor": "security",
};

/**
 * Infer a skill-tree profile from a role name.
 * Returns empty string if no match found.
 */
export function inferProfileFromRole(roleName) {
  // Direct match
  if (ROLE_PROFILE_MAP[roleName]) return ROLE_PROFILE_MAP[roleName];

  // Partial match (e.g., "senior-developer" matches "developer")
  for (const [pattern, profile] of Object.entries(ROLE_PROFILE_MAP)) {
    if (roleName.includes(pattern)) return profile;
  }

  return "";
}

// ────────────────────────────────────────────────────────────────
// Openteams ↔ skill-tree bridge
//
// The bridge between openteams `loadout.skills` (SkillsConfig in the
// schema) and skill-tree's LoadoutCriteria. skill-tree is the
// *mechanism*; openteams is the *declaration layer* that dispatches
// into it.
//
// Bridged fields are locked in by src/__tests__/loadout-schema-bridge.test.mjs
// which cross-references this list against openteams' SkillsConfig schema.
// Adding a field on either side without updating the other fails the test.
// ────────────────────────────────────────────────────────────────

/** Fields on openteams `loadout.skills` that the bridge maps into
 * LoadoutCriteria. Order is the order they appear in openteams'
 * `loadout.schema.json` $defs.SkillsConfig.properties. */
export const OPENTEAMS_BRIDGED_FIELDS = Object.freeze([
  "profile",
  "include",
  "exclude",
  "max_tokens",
]);

/**
 * Overlay an openteams `loadout.skills` block onto a skill-tree
 * `LoadoutCriteria`. Pure function — returns a new object, does not
 * mutate the input.
 *
 * Mapping:
 *   profile     → criteria.profile     (replace if set)
 *   include     → criteria.include     (union, deduped)
 *   exclude     → criteria.exclude     (union, deduped)
 *   max_tokens  → criteria.maxTokens   (replace if set)
 *
 * Passing null/undefined for `loadoutSkills` returns a shallow copy of
 * the input criteria unchanged.
 */
export function mergeOpenteamsSkillsIntoCriteria(criteria, loadoutSkills) {
  const merged = { ...(criteria ?? {}) };
  if (!loadoutSkills) return merged;
  if (loadoutSkills.profile) merged.profile = loadoutSkills.profile;
  if (loadoutSkills.include?.length) {
    merged.include = mergeUnique(merged.include, loadoutSkills.include);
  }
  if (loadoutSkills.exclude?.length) {
    merged.exclude = mergeUnique(merged.exclude, loadoutSkills.exclude);
  }
  if (typeof loadoutSkills.max_tokens === "number") {
    merged.maxTokens = loadoutSkills.max_tokens;
  }
  return merged;
}

/**
 * Resolve the LoadoutCriteria for a single role. Pure function — no I/O.
 * Returns null when no criteria can be derived (signals to the caller
 * that the role should be skipped).
 *
 * Priority order:
 *   1. team.yaml `skilltree:` extension defaults
 *   2. team.yaml `skilltree:` extension per-role override (replaces step 1)
 *   3. openteams `role.loadout.skills` overlay via mergeOpenteamsSkillsIntoCriteria
 *      (this is the openteams ↔ skill-tree bridge — declarations dispatch
 *      into the mechanism)
 *   4. If no skill-bearing criteria exists yet:
 *      a. config.defaultProfile, else
 *      b. ROLE_PROFILE_MAP auto-inference from role name, else
 *      c. return null (no criteria — caller skips this role)
 *
 * @param {string} roleName
 * @param {object} manifest - Parsed team.yaml manifest
 * @param {object} [config] - Plugin config (skilltree section)
 * @param {object} [template] - Optional openteams ResolvedTemplate
 * @returns {object|null} LoadoutCriteria or null when role has no criteria
 */
export function computeRoleCriteria(
  roleName,
  manifest,
  config = {},
  template = null,
) {
  const { defaults, roles: roleOverrides } = parseSkillTreeExtension(manifest);
  const templateRoles = normalizeRolesMap(template?.roles);

  // Step 1+2: skilltree extension defaults + per-role override
  let roleCriteria = roleOverrides[roleName]
    ? { ...defaults, ...roleOverrides[roleName] }
    : { ...defaults };

  // Step 3: openteams loadout.skills overlay (canonical bridge — openteams wins)
  const loadoutSkills = templateRoles?.get(roleName)?.loadout?.skills;
  roleCriteria = mergeOpenteamsSkillsIntoCriteria(roleCriteria, loadoutSkills);

  // Step 4: fallback chain — only fires when nothing skill-bearing is set yet
  if (
    !roleCriteria.profile &&
    !roleCriteria.tags &&
    !roleCriteria.include &&
    !roleCriteria.taskDescription
  ) {
    if (config?.defaultProfile) {
      roleCriteria.profile = config.defaultProfile;
    } else {
      const inferred = inferProfileFromRole(roleName);
      if (inferred) {
        roleCriteria.profile = inferred;
      } else {
        return null;
      }
    }
  }

  return roleCriteria;
}

/**
 * Compile skill loadouts for all roles in a team manifest. Thin
 * orchestrator over `computeRoleCriteria` + `compileRoleLoadout`.
 *
 * @param {object} manifest - Parsed team.yaml manifest
 * @param {object} config - Plugin config (skilltree section)
 * @param {object} [template] - Optional openteams ResolvedTemplate
 * @returns {Promise<object>} Map of roleName → { content, profile }
 */
export async function compileAllRoleLoadouts(manifest, config, template = null) {
  const allRoles = manifest.roles || [];
  const result = {};

  for (const roleName of allRoles) {
    const roleCriteria = computeRoleCriteria(roleName, manifest, config, template);
    if (!roleCriteria) continue;

    const loadout = await compileRoleLoadout(roleName, roleCriteria, config);
    if (loadout) {
      result[roleName] = {
        content: loadout,
        profile: roleCriteria.profile || "",
      };
    }
  }

  return result;
}

function normalizeRolesMap(roles) {
  if (!roles) return null;
  if (roles instanceof Map) return roles;
  if (typeof roles === "object") return new Map(Object.entries(roles));
  return null;
}

function mergeUnique(a, b) {
  const out = new Set();
  for (const x of a ?? []) out.add(x);
  for (const x of b ?? []) out.add(x);
  return [...out];
}
