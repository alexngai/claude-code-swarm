#!/usr/bin/env node
/**
 * sync-version.mjs — Sync version from package.json to plugin.json and marketplace.json
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).version;

const files = [
  path.join(root, ".claude-plugin", "plugin.json"),
  path.join(root, ".claude-plugin", "marketplace.json"),
];

for (const file of files) {
  const json = JSON.parse(fs.readFileSync(file, "utf-8"));
  json.version = version;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  console.log(`Updated ${path.relative(root, file)} → ${version}`);
}
