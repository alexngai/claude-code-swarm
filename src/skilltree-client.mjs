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
import { createRequire } from "module";
import { getGlobalNodeModules } from "./swarmkit-resolver.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger("skilltree");

const require = createRequire(import.meta.url);

let _skillTree = undefined;

/**
 * Load the skill-tree module. Returns null if not available.
 * Tries local require first, then falls back to global node_modules.
 */
function loadSkillTree() {
  if (_skillTree !== undefined) return _skillTree;

  // 1. Local require (works if skill-tree is in node_modules or NODE_PATH)
  try {
    _skillTree = require("skill-tree");
    return _skillTree;
  } catch {
    // Not locally available
  }

  // 2. Global node_modules fallback (where swarmkit installs it)
  const globalNm = getGlobalNodeModules();
  if (globalNm) {
    const globalPath = path.join(globalNm, "skill-tree");
    if (fs.existsSync(globalPath)) {
      try {
        _skillTree = require(globalPath);
        return _skillTree;
      } catch {
        // require failed
      }
    }
  }

  _skillTree = null;
  return null;
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
  const st = loadSkillTree();
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

/**
 * Compile skill loadouts for all roles in a team manifest.
 * Reads the skilltree extension from the manifest, compiles loadouts per role.
 * Returns metadata alongside content for richer agent context.
 *
 * @param {object} manifest - Parsed team.yaml manifest
 * @param {object} config - Plugin config (skilltree section)
 * @returns {Promise<object>} Map of roleName → { content, profile }
 */
export async function compileAllRoleLoadouts(manifest, config) {
  const { defaults, roles: roleOverrides } = parseSkillTreeExtension(manifest);
  const allRoles = manifest.roles || [];
  const result = {};

  for (const roleName of allRoles) {
    // Merge defaults with role-specific overrides
    const roleCriteria = roleOverrides[roleName]
      ? { ...defaults, ...roleOverrides[roleName] }
      : { ...defaults };

    // Fallback chain for profile selection
    if (!roleCriteria.profile && !roleCriteria.tags && !roleCriteria.include && !roleCriteria.taskDescription) {
      if (config?.defaultProfile) {
        roleCriteria.profile = config.defaultProfile;
      } else {
        // Auto-infer from role name
        const inferred = inferProfileFromRole(roleName);
        if (inferred) {
          roleCriteria.profile = inferred;
        } else {
          continue; // No criteria at all — skip
        }
      }
    }

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
