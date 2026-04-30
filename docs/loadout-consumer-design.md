# Loadout Consumer Design

**Status:** Proposed — scope locked, implementation pending.
**Author:** Iterative design session (openhive + claude-code-swarm + openteams)
**Date:** 2026-04-21
**Scope:** claude-code-swarm's consumer integration for openteams loadouts.

---

## TL;DR

openteams 0.3 introduced **loadouts** — reusable bundles of skills, capabilities, MCP servers, permissions, and prompt material that bind to roles on a team. claude-code-swarm materializes loadouts into per-role Claude Code sub-agent definitions.

The materialization is **fully non-invasive by default**: claude-code-swarm writes only to `.claude/agents/` (for sub-agent discovery) and `.swarm/claude-swarm/` (its own namespace). It never modifies `.mcp.json`, `.claude/settings.json`, or any user-global config without an explicit user command.

Per-role MCP scope and permissions enforcement lives in the sub-agent frontmatter (`mcpServers:`, `tools:`, `disallowedTools:`, `hooks:`). A bundled PreToolUse hook provides fine-grained scope enforcement without modifying session-level settings.

---

## Motivation

### What loadouts give us

Before loadouts, agent capabilities, MCP servers, permissions, and skill loadouts were all configured in disparate places — some in team YAML, some in plugin.json, some implicitly via capability manual lists. Users had no single place to customize what an agent could do, and no way to share that configuration across teams.

Loadouts collapse these concerns into a single first-class primitive with inheritance, scope declarations, and install specs separated cleanly. See the openteams `design.md` for the canonical shape.

### What claude-code-swarm must do

claude-code-swarm is the runtime consumer that translates loadouts into Claude Code's sub-agent mechanism. Its job:

1. Read the resolved loadout for each role from openteams.
2. Materialize per-role `AGENT.md` files with the right frontmatter and body.
3. Surface MCP install requirements without auto-installing.
4. Enforce per-role scope (which MCP tools a role may call) without touching global settings.
5. Provide explicit opt-in commands for users who want the traditional "install to `.mcp.json`" path.

### What we want to avoid

The prior approach would have been to auto-write `.mcp.json` and `.claude/settings.json` from every loadout. This is invasive:

- User-owned config gets mutated every team spawn.
- Two teams with overlapping MCP declarations create install conflicts.
- Permissions accumulated from many roles are hard to audit.
- Reversing the changes is manual and error-prone.

The non-invasive model is a deliberate tradeoff: we give up some convenience (no automatic runtime install) in exchange for predictability and user trust.

---

## Design Principles

1. **Zero invasive writes by default.** claude-code-swarm never modifies `.mcp.json`, `.claude/settings.json`, or user-global config unless the user explicitly requests it via a slash command.
2. **Sub-agent definitions are artifacts, not config.** Writing `.claude/agents/<team>-<role>.md` is an output of claude-code-swarm, namespaced per team. These files are markered, cleanable, and gitignore-friendly.
3. **All scope enforcement lives in sub-agent frontmatter.** `mcpServers:`, `tools:`, `disallowedTools:`, and `hooks:` handle per-agent restriction without session-level mutation.
4. **Install specs are advisory.** Team-declared `mcp_providers` are cached and reported, never auto-installed.
5. **Explicit opt-in for invasive writes.** `/swarm mcp install <name>` and `/swarm permissions sync` exist for users who want the traditional path — always with confirmation and diff preview.
6. **Health check as feedback, not gatekeeping.** SessionStart reports missing MCPs without blocking; PreToolUse hooks block individual out-of-scope calls with actionable error messages.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  /swarm <template>                                           │
│                                                              │
│  scripts/team-loader.mjs                                     │
│    ↓                                                         │
│  src/template.mjs : loadTeam()                               │
│    ↓ openteams TemplateLoader.load()                         │
│    → ResolvedTemplate { mcpProviders, loadouts, ... }        │
│    ↓ cache artifacts to .swarm/claude-swarm/tmp/teams/<t>/   │
│      ├── mcp-providers.json                                  │
│      ├── loadouts/<role>.json                                │
│      ├── scope/<role>.json          ← per-role scope file    │
│      └── missing-mcp.json                                    │
│    ↓                                                         │
│  src/loadout-materializer.mjs                                │
│    ↓ generateAgentFrontmatter(role, loadout, template)       │
│    ↓                                                         │
│  src/agent-generator.mjs : generateAgentMd()                 │
│    ↓ writes to .claude/agents/<team>-<role>.md               │
│    (or ~/.claude/agents/ with --scope=user)                  │
│                                                              │
│  SessionStart hook                                           │
│    ↓ src/mcp-health-checker.mjs                              │
│    → prints report: active / declared / missing              │
│                                                              │
│  Runtime                                                     │
│    ↓ Claude Code spawns agent via Agent() tool               │
│    ↓ Agent loads frontmatter (mcpServers, tools, hooks)      │
│    ↓ PreToolUse hook scope-check.mjs gates MCP calls         │
│      via per-role scope file                                 │
└──────────────────────────────────────────────────────────────┘
```

### Components

- **loadout-materializer** — pure function, loadout → frontmatter YAML
- **mcp-scope-resolver** — pure function, normalized scope → `mcpServers` / `tools` / `disallowedTools` lists
- **mcp-health-checker** — pure function, providers ∩ active set → report
- **scope-check hook** — generic PreToolUse, reads per-role scope JSON, gates tool calls
- **swarm-mcp skill** — slash commands for user-initiated operations

---

## Materialized Artifacts

### AGENT.md frontmatter (example)

```yaml
---
name: loadout-demo-reviewer
description: Reviewer role for loadout-demo team
team_name: loadout-demo
role: reviewer
generated_by: claude-code-swarm
generated_at: 2026-04-21T14:30:00Z
project_path: /absolute/path/to/project

# Native Claude Code tools — explicit allowlist
tools:
  - Read
  - Grep
  - Glob
  - Bash

# Per-agent MCP scope (string refs for session-level servers; inline for ephemeral)
mcpServers:
  - ast-grep
  - chrome-devtools

# MCP tool denies (from loadout exclude lists)
disallowedTools:
  - mcp__ast-grep__dangerous_replace

# Fine-grained scope enforcement via per-agent hook
hooks:
  PreToolUse:
    - matcher: "mcp__.*"
      hooks:
        - type: command
          command: ${CLAUDE_PLUGIN_ROOT}/hooks/scope-check.mjs
          env:
            SCOPE_FILE: .swarm/claude-swarm/tmp/teams/loadout-demo/scope/reviewer.json

# Loadout capabilities (informational to Claude Code; consumed by macro-agent)
capabilities:
  - file.read
  - git.diff
  - codebase.search
  - exec.test
  - task.update
---

# Reviewer — loadout-demo team

[role prompt body]

## Review Mindset
[loadout.promptAddendum from inheritance chain]
```

### Per-role scope file

```json
{
  "role": "reviewer",
  "team": "loadout-demo",
  "scope": [
    { "server": "ast-grep", "exclude": ["dangerous_replace"] },
    { "server": "chrome-devtools", "tools": ["navigate", "screenshot", "get_page_text"] }
  ],
  "permissions": {
    "allow": ["Read(**)", "Bash(git diff:*)"],
    "deny": ["Bash(git push:*)", "Bash(rm -rf:*)"]
  }
}
```

The hook reads this file (path injected via `SCOPE_FILE` env var in the frontmatter hook declaration), parses the incoming tool name, and exits with code 2 if the tool is out of scope.

### Scope → frontmatter translation rules

Implemented in `mcp-scope-resolver.mjs`:

| Loadout scope entry | Frontmatter emission |
|---|---|
| `{ server: "opentasks" }` (bare) | `mcpServers: [opentasks]` — full server access; no explicit tool list |
| `{ server: "chrome-devtools", tools: ["navigate"] }` | `mcpServers: [chrome-devtools]` + per-agent hook narrows to `navigate` |
| `{ server: "ast-grep", exclude: ["dangerous"] }` | `mcpServers: [ast-grep]` + `disallowedTools: [mcp__ast-grep__dangerous]` |
| Install spec (`{ name, command, args }`) | `mcpServers: [{ inline install spec }]` — per-agent subprocess (advisory) |
| Symbolic ref (`{ ref: "@..." }`) | Skip (warn) unless resolved via bundled registry or hive DB |

When tools are specified as an allowlist (`tools: [...]`) rather than a denylist (`exclude: [...]`), we cannot use `tools:` frontmatter wildcards. Instead, the hook enforces the allowlist via the scope file. This keeps the materializer simple at the cost of one more hook invocation per tool call.

---

## The Non-Invasive Contract

### What claude-code-swarm writes (by default)

| Path | Contents | Invasiveness |
|---|---|---|
| `.swarm/claude-swarm/tmp/teams/<t>/` | Artifact cache (providers, loadouts, scope, missing-mcp) | Low — swarm namespace |
| `.claude/agents/<team>-<role>.md` | Generated sub-agent definitions | Low — namespaced, markered, cleanable |
| `~/.claude/agents/<project-slug>-<team>-<role>.md` | User-scoped variant (opt-in) | Low — same treatment, user-scoped |

### What claude-code-swarm never writes (by default)

| Path | Reason |
|---|---|
| `.mcp.json` | User-owned session config. Only written on `/swarm mcp install` with confirmation. |
| `.claude/settings.json` | User-owned session config. Committed to version control. Never modified. |
| `.claude/settings.local.json` | User-owned local override. Only written on `/swarm permissions sync` with confirmation. |
| `~/.claude/settings.json` | User-global. Never touched. |
| `~/.claude/mcp.json` | User-global. Never touched. |

### Markers on generated files

Every AGENT.md written by claude-code-swarm includes:

```yaml
generated_by: claude-code-swarm
generated_at: <ISO timestamp>
team_name: <template>
project_path: <absolute>
```

`/swarm clean` only removes files matching these markers — never touches hand-authored agents in `.claude/agents/`.

---

## Explicit Opt-In Commands

For users who want the traditional "install everything automatically" experience, four slash commands exist. All require confirmation and show a diff before writing.

### `/swarm mcp check`

Dry-run health report. Prints missing/extra/conflicting MCP servers; no filesystem changes.

### `/swarm mcp install <name>`

Writes the named provider (from `template.mcpProviders`) into project `.mcp.json`. Strips openteams-specific fields (`ref`, `description`, `disabled`). Confirms before writing. `--all` installs every declared provider not already active.

### `/swarm permissions sync`

Merges the union of all roles' permissions (loadout `permissions.{allow,deny,ask}` + scope-translated MCP patterns) into `.claude/settings.local.json`. Uses a clearly-namespaced block:

```jsonc
// .claude/settings.local.json
{
  "permissions": {
    "allow": [
      /* swarm:loadout-demo:start */
      "Read(**)",
      "Bash(git diff:*)",
      "mcp__opentasks__*",
      "mcp__chrome-devtools__navigate"
      /* swarm:loadout-demo:end */
    ]
  }
}
```

The markers let the command surgically update the block on subsequent runs without disturbing user-authored permissions.

### `/swarm clean`

Removes generated AGENT.md files and cached artifacts for the current team (or all teams with `--all`). Respects markers — never removes hand-authored agents.

### `/swarm mcp resolve-ref <ref>`

Resolves a symbolic ref against bundled registries or user-provided resolvers. Optional for PR 3; refs are skipped with a warning by default until this is implemented.

---

## Agent Scope Configuration

Default: **project-scoped** at `<project>/.claude/agents/<team>-<role>.md`.

### Rationale

- Team definitions are typically chosen for a specific project.
- `.swarm/claude-swarm/tmp/` is already project-scoped; keeping agents there matches.
- Name collisions between projects are impossible.
- Cleanup is trivial (`rm <project>`).
- Claude Code only sees the project's agents when running in that project.

### Opt-in: user-scoped

```jsonc
// .swarm/claude-swarm/config.json
{ "agentScope": "user" }
```

Or per-invocation: `/swarm <template> --scope=user`.

User-scoped behavior:
- Filenames get a project-slug prefix: `~/.claude/agents/<project-slug>-<team>-<role>.md`
- Frontmatter records `project_path:` to trace origin.
- `/swarm clean --scope=user` only removes files traceable to the current project.
- Same-named agents in both scopes: project-scoped wins (Claude Code precedence).

### Cleanup across scopes

- `/swarm clean` — defaults to the currently configured scope
- `/swarm clean --scope=project|user|all` — explicit

---

## SessionStart Health Check

A SessionStart hook invokes `mcp-health-checker.mjs` at team launch. Output is informational — never blocks session start.

```
╭─ loadout-demo team MCP status ──────────────────────╮
│                                                     │
│  ✓ opentasks           (plugin)                    │
│  ✓ agent-inbox         (plugin)                    │
│  ✓ ast-grep            (user ~/.claude/mcp.json)   │
│  ⚠ chrome-devtools     (declared, not active)      │
│     → /swarm mcp install chrome-devtools           │
│  ⚠ secrets-scanner     (ref deferred)              │
│     → /swarm mcp resolve-ref @openhive/secrets...  │
│                                                     │
│  Agents generated: 3 (at .claude/agents/)          │
│  Scope files:      3 (at .swarm/.../scope/)        │
╰─────────────────────────────────────────────────────╯
```

Discovery sources for the "active set":
- Plugin `.claude-plugin/plugin.json:mcpServers`
- Project `.mcp.json` (if present)
- User `~/.claude/mcp.json` (if present)
- Future: OpenHive hive DB via IPC

---

## macro-agent Consideration

macro-agent is an orchestration layer above claude-code-swarm. For Claude workers, it delegates to claude-code-swarm for spawning. For Codex/Gemini workers, it materializes loadouts to its own runtime formats.

The claude-code-swarm work in this document is upstream of macro-agent; macro-agent consumes the materialized artifacts indirectly.

macro-agent's additional responsibilities (not covered here):
- Reads `role.loadout.capabilities` for runtime tool filtering via `isToolAllowedForRole`.
- Optionally installs MCP servers from `template.mcpProviders` before spawning (explicit, opt-in).
- Implements its own materializers for non-Claude runtimes.

Per-role loadout enforcement in macro-agent rides the same primitives — `role.loadout.mcpScope` drives filter policy identically whether the runtime is Claude Code, Codex, or Gemini.

---

## Alternatives Considered

### Alternative 1: Auto-write `.mcp.json` and `.claude/settings.json`

**Rejected.** Mutates user-owned config on every team spawn; creates conflicts between overlapping teams; reversal is manual. The convenience isn't worth the loss of user trust.

### Alternative 2: Inline all agent definitions via `Agent({ prompt: ... })`, never write `.claude/agents/`

**Rejected.** Loses access to per-agent `mcpServers:`, `hooks:`, `tools:`, `disallowedTools:` frontmatter. Scope enforcement collapses back to session-level, which forces us to mutate settings.json (the thing we're trying to avoid).

### Alternative 3: Plugin-distributed sub-agents via claude-code-swarm plugin

**Rejected.** Plugin sub-agents cannot use `mcpServers:` (Claude Code security restriction). Loses per-agent MCP scope, which is a core loadout feature.

### Alternative 4: Full tool enumeration in `tools:` frontmatter (no hook)

**Rejected.** Requires introspecting MCP servers at generation time or shipping a stale tool registry. Fragile under MCP server upgrades. The hook approach is slightly slower but survives server evolution.

### Alternative 5: Session-level settings with per-team namespace

**Rejected.** Claude Code has no concept of per-team settings; all settings are session-global. Union across teams works but loses per-role precision and mutates settings.json.

---

## Open Verifications

Three behaviors worth confirming before cutting the materializer:

1. **Does Claude Code recurse into `.claude/agents/` subdirectories?**
   - If yes: use `.claude/agents/swarm/<team>/<role>.md` (cleaner namespacing, single gitignore rule).
   - If no: flat `.claude/agents/<team>-<role>.md`.

2. **Does inline `mcpServers:` in AGENT.md spawn a subprocess per-agent, or is it pooled?**
   - Affects viability of "inline everything" mode for advanced loadouts.
   - Default is advisory-only; inline is a power-user opt-in via a loadout-level flag.

3. **Exact `hooks:` frontmatter schema for per-agent PreToolUse hooks with env vars?**
   - Proposed shape in this doc is reasoned from research; need to confirm `env:` field is supported in sub-agent hook declarations specifically.
   - Fallback: pass scope file path via command-line argument rather than env var.

Verification target: a focused follow-up query to the claude-code-guide agent or direct Claude Code docs before step 1 of execution.

---

## Execution Plan

Order chosen to build pure functions first (easy to test), then integrate.

1. **`src/loadout-materializer.mjs`** + unit tests — loadout → frontmatter (pure function).
2. **`src/mcp-scope-resolver.mjs`** + unit tests — scope → mcpServers/tools/disallowedTools (pure function).
3. **`src/mcp-health-checker.mjs`** + unit tests — providers ∩ active set → report (pure function).
4. **`hooks/scope-check.mjs`** + integration tests — PreToolUse hook, runs as subprocess.
5. **Integrate into `src/template.mjs:loadTeam()`** — cache new artifacts alongside existing skill-loadouts.json.
6. **Update `src/agent-generator.mjs:generateAgentMd()`** — emit rich frontmatter via materializer.
7. **Update `src/skilltree-client.mjs`** — read `role.loadout.skills` before legacy path.
8. **Add `skills/swarm-mcp/SKILL.md`** with slash commands.
9. **SessionStart hook integration** — invoke health checker, print report.
10. **E2E manual test** against `examples/loadout-demo` from openteams.

### Go/no-go checkpoints

- **After step 1** — show generated frontmatter for loadout-demo, confirm shape.
- **After step 6** — inspect AGENT.md files on disk, confirm they're clean and markered.
- **After step 8** — walk through slash commands end-to-end.

---

## Future Work

### Deferred from PR 3

- **Symbolic ref registry** — bundled map for `@openhive/*` and other well-known refs. Current: warn-and-skip.
- **Tool introspection at session start** — enumerate MCP tools dynamically to enrich `tools:` frontmatter allowlists. Current: hook-based enforcement only.
- **Symlink mode opt-in** — `.claude/agents/*` → `.swarm/...` symlinks for users who want single-source-of-truth. Current: direct writes to both (project scope) or prefixed writes (user scope).
- **Plugin MCP conflict resolution** — detect plugin vs project MCP name collisions and warn. Current: silent (Claude Code handles via priority rules).

### Openhive integration (later)

- OpenHive hive DB becomes authoritative for MCP providers + ref resolution.
- `resolveExternalLoadout` hook lets OpenHive supply hive-stored loadout overrides.
- `findMissingMcpReferences` cross-references against hive-managed MCP registry.

### macro-agent integration (follow-on)

- Read `role.loadout.capabilities` for runtime tool filtering (no claude-code-swarm change).
- Own materializers for Codex/Gemini runtimes.
- Optional explicit MCP server lifecycle management at boot.

### Federation

- Multi-template consumption — how do cross-template MCP provider overlaps resolve?
- Current answer: consumer-layer policy decision; openteams permits overlap.
- Future consideration as openteams `federation.yaml` matures.

---

## References

- **openteams design** — `references/openteams/design.md`
- **openteams Loadout spec** — `references/openteams/schema/loadout.schema.json`
- **Claude Code sub-agent docs** — https://code.claude.com/docs/en/subagents
- **Claude Code MCP docs** — https://code.claude.com/docs/en/mcp-servers
- **Claude Code permissions docs** — https://code.claude.com/docs/en/permissions
- **loadout-demo example** — `references/openteams/examples/loadout-demo/`

---

## Changelog

- **2026-04-21** — Initial design captured from iterative session. Scope locked: fully non-invasive, project-scoped default with user-scope opt-in, hook-based scope enforcement.
- **2026-04-21** — Verifications complete.
  1. **No subdirectory recursion** in `.claude/agents/`. Decision: flat naming `<team>-<role>.md`.
  2. **Inline `mcpServers:` spawns subprocess per-agent-invocation** ("connected when subagent starts, disconnected when it finishes"). Decision: default to string refs (session-level servers); inline install specs become a power-user advisory with an explicit warning.
  3. **`hooks:` frontmatter supported** for `PreToolUse`/`PostToolUse`/`Stop`, with `matcher:`, `type: command`, stdin JSON, exit code 2 to block. `env:` field behavior in subagent hooks is unverified; materializer will use `env:` and fall back to CLI argument injection at step 4 if empirical testing fails.
