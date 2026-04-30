---
name: swarm-mcp
description: Inspect and optionally install MCP providers declared by the current swarm team. Non-invasive by default — reports status without modifying user MCP configuration unless explicitly requested.
user_invocable: true
argument: optional
---

# /swarm-mcp — Inspect and Manage Team MCP Providers

You manage the **MCP (Model Context Protocol) surface** for the configured swarm team. Your role is to inspect declared providers, report health, and optionally install or sync with explicit user consent.

## Design principles

- **Non-invasive by default.** Do NOT modify `.mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`, or user-global config without explicit user opt-in.
- **Check-and-notify over auto-install.** Surface discrepancies. Let the user decide.
- **Confirmation before any write.** Always show a diff preview and wait for explicit approval.

## Artifact sources

The swarm team loader (`scripts/team-loader.mjs`) has already populated the following cache files (one pass, at session start):

- `.swarm/claude-swarm/tmp/teams/<template>/mcp-providers.json` — team-declared provider install specs
- `.swarm/claude-swarm/tmp/teams/<template>/mcp-health.json` — pre-computed health report (regenerated each session)
- `.swarm/claude-swarm/tmp/teams/<template>/scope/<role>.json` — per-role scope files consumed by the PreToolUse hook
- `.swarm/claude-swarm/tmp/teams/<template>/loadouts/<role>.json` — debug view of resolved per-role loadout

Do NOT regenerate these files. They're owned by the team-loader.

## Subcommands

Parse `$ARGUMENTS` as the first token to determine which subcommand to run.

### `check` — Dry-run health report

Purpose: show declared providers vs active set, flag missing / refs / disabled / orphaned scope references.

Steps:
1. Read `.swarm/claude-swarm/tmp/teams/<template>/mcp-health.json`. If missing, ask the user to reload the team (`/swarm <template>`) — the loader populates this file.
2. Render the report using the classification fields:
   - `ok[]`   — servers declared AND active (checkmark + source)
   - `missing[]` — declared, not active (warning + suggest `install`)
   - `refs[]` — symbolic refs deferred to consumer (inform)
   - `disabled[]` — declared with `disabled: true`
   - `activeOnly[]` — active but not declared (informational)
   - `orphanedReferences[]` — loadout scope references not backed by anything
3. Print a compact table. Do NOT write any files.

### `install [name]` — Explicit MCP install

Purpose: append a team-declared provider (from `mcp-providers.json`) to the project `.mcp.json` after explicit user confirmation. If `[name]` is omitted, list installable entries and ask the user to pick.

Steps:
1. Read `.swarm/claude-swarm/tmp/teams/<template>/mcp-providers.json`.
2. Read (or initialize) project-root `.mcp.json`.
3. For each requested `name`:
   a. Strip openteams-specific fields (`ref`, `description`, `disabled`) from the provider spec.
   b. If `.mcp.json` already contains the same name, diff the specs and show both to the user. Ask whether to overwrite.
   c. Show the full diff that would land in `.mcp.json`.
   d. Wait for explicit user approval (`yes` / `install` / `y`) before writing.
4. Write `.mcp.json` atomically. Inform the user they will need to restart Claude Code for the new server to connect.

Refuse to proceed if:
- The provider has `disabled: true` (skip with a message)
- The provider has `ref:` but no bundled registry to resolve it (skip with a suggestion to run `/swarm-mcp resolve-ref`)
- The user hasn't confirmed

### `permissions-sync` — Explicit permissions sync

Purpose: merge loadout-driven permissions into `.claude/settings.local.json` under a clearly-marked swarm block. `settings.local.json` is user-owned and typically gitignored, so we never touch `.claude/settings.json`.

Steps:
1. Collect the union of all roles' permissions:
   - `.swarm/claude-swarm/tmp/teams/<template>/scope/<role>.json` → `permissions.{allow,deny,ask}`
   - Scope entries → translated to `mcp__<server>__*` (for bare server access) and `mcp__<server>__<tool>` (for exclude entries)
2. Read `.claude/settings.local.json` (or initialize an empty object if absent).
3. Locate or create a marked block:
   ```json
   "permissions": {
     "allow": [
       "/* swarm:<template>:start */",
       "...",
       "/* swarm:<template>:end */"
     ]
   }
   ```
   (If JSON doesn't tolerate comments, use a sentinel entry like `"// swarm:<template>:start"`.)
4. Replace the marked block's contents; preserve everything outside the sentinel fences.
5. Show the diff, wait for confirmation, write atomically.

### `clean` — Remove swarm-generated agents

Purpose: remove `.claude/agents/<team>-*` files written by swarm, respecting the `generated_by: claude-code-swarm` marker. Never touches hand-authored agents.

Steps:
1. Scan `.claude/agents/*.md` (or `~/.claude/agents/<project-slug>-<team>-*.md` if the current team uses user scope).
2. Filter to files whose frontmatter contains:
   - `generated_by: claude-code-swarm` AND
   - `team_name: <current-template>` (if `--team` given) or any swarm team (default)
3. Show the list and confirm with the user before deleting.
4. Optionally also delete `.swarm/claude-swarm/tmp/teams/<template>/` cache files when `--with-artifacts` is given.

### `resolve-ref <ref>` — (Deferred)

For future use. Currently prints a stub message indicating ref resolution requires an OpenHive hive connection or a bundled registry (not yet shipped).

## Default behavior when no subcommand given

If `$ARGUMENTS` is empty, run the `check` subcommand — the safest and most informative default.

## What you must NOT do

- Do not modify `.mcp.json` without explicit user confirmation
- Do not modify `.claude/settings.json` (committed project settings) — only `.claude/settings.local.json`
- Do not touch user-global config in `~/.claude/` without explicit opt-in
- Do not invoke `install` or `permissions-sync` without a clear user yes
- Do not re-run the team-loader from inside this skill (`/swarm` or `loadTeam` does that)
