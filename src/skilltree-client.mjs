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
    process.stderr.write(`[skilltree] Warning: loadout compilation failed for ${roleName}: ${err.message}\n`);
    return "";
  }
}

/**
 * Compile skill loadouts for all roles in a team manifest.
 * Reads the skilltree extension from the manifest, compiles loadouts per role.
 *
 * @param {object} manifest - Parsed team.yaml manifest
 * @param {object} config - Plugin config (skilltree section)
 * @returns {Promise<object>} Map of roleName → loadout markdown
 */
export async function compileAllRoleLoadouts(manifest, config) {
  const { defaults, roles: roleOverrides } = parseSkillTreeExtension(manifest);
  const allRoles = manifest.roles || [];
  const result = {};

  for (const roleName of allRoles) {
    // Merge defaults with role-specific overrides
    const roleCriteria = roleOverrides[roleName]
      ? { ...defaults, ...roleOverrides[roleName] }
      : defaults;

    // Apply config-level default profile as final fallback
    if (!roleCriteria.profile && !roleCriteria.tags && !roleCriteria.include && !roleCriteria.taskDescription) {
      if (config?.defaultProfile) {
        roleCriteria.profile = config.defaultProfile;
      } else {
        continue; // No criteria at all — skip
      }
    }

    const loadout = await compileRoleLoadout(roleName, roleCriteria, config);
    if (loadout) {
      result[roleName] = loadout;
    }
  }

  return result;
}
