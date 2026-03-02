/**
 * roles.mjs — Role reading, matching, and writing for claude-code-swarm
 *
 * Manages the roles.json file that maps openteams topology roles to MAP agent IDs.
 * Used by hooks (agent-spawning/completed) and team-loader.
 */

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { ROLES_PATH } from "./paths.mjs";

const require = createRequire(import.meta.url);

/**
 * Read roles.json for the current team.
 * Never throws — returns empty structure on any error.
 */
export function readRoles(rolesPath = ROLES_PATH) {
  try {
    return JSON.parse(fs.readFileSync(rolesPath, "utf-8"));
  } catch {
    return { team: "", roles: [], root: "", companions: [] };
  }
}

/**
 * Match a spawned agent name against topology roles.
 * Tries exact match, prefixed match (team-role), and suffix match (-role).
 * Returns the role name if matched, null otherwise.
 */
export function matchRole(agentName, roles) {
  if (!agentName || !roles.roles?.length) return null;
  return (
    roles.roles.find(
      (r) =>
        agentName === r ||
        agentName === `${roles.team}-${r}` ||
        agentName.endsWith(`-${r}`)
    ) || null
  );
}

/**
 * Parse team.yaml and write roles.json for MAP hook integration.
 * Requires js-yaml to be available.
 */
export function writeRoles(templatePath, outputPath = ROLES_PATH) {
  try {
    const yaml = require("js-yaml");
    const content = fs.readFileSync(`${templatePath}/team.yaml`, "utf-8");
    const manifest = yaml.load(content);

    const roles = {
      team: manifest.name || "",
      roles: manifest.roles || [],
      root: manifest.topology?.root?.role || "",
      companions: (manifest.topology?.companions || []).map(
        (c) => c.role || c
      ),
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(roles, null, 2));
    return roles;
  } catch (err) {
    process.stderr.write(
      `Warning: could not write roles.json: ${err.message}\n`
    );
    return null;
  }
}
