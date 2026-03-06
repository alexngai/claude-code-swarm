# claude-code-swarm

A Claude Code plugin that launches agent teams from [openteams](https://github.com/alexngai/openteams) YAML topologies.

## Overview

Define your multi-agent team structure as a YAML topology (roles, communication channels, spawn rules) using openteams, then let this plugin spin it up as a coordinated Claude Code agent team.

### Built-in topologies

| Template | Roles | Description |
|----------|-------|-------------|
| `get-shit-done` | 12 | Wave-based parallel execution with goal-backward verification and checkpoint management |
| `bmad-method` | 10 | Full agile development team across 4 phases: analysis, planning, solutioning, implementation |

## Installation

Install as a Claude Code plugin:

```bash
claude plugin add /path/to/claude-code-swarm
```

## Usage

### Option 1: Configure a default team

Create `.claude-swarm.json` in your project root:

```json
{
  "template": "get-shit-done"
}
```

The team context loads automatically on session start.

### Option 2: Launch on demand

```
/swarm get-shit-done
```

### Option 3: Use a custom topology

Point to any openteams template directory:

```json
{
  "template": "/path/to/my-team-template"
}
```

Or create your own using `openteams editor`:

```bash
npm install -g openteams
openteams editor
```

## Configuration

### Config resolution

Configuration is resolved with tiered fallthrough — each level overrides the one below:

```
SWARM_* env vars  >  project config  >  global config  >  defaults
```

### Project config

Lives in your project directory at `.swarm/claude-swarm/config.json` (or `.claude-swarm/config.json` with `--no-prefix`):

```json
{
  "template": "get-shit-done",
  "map": {
    "scope": "my-project",
    "systemId": "my-project-swarm"
  }
}
```

Project config is typically committed to the repo or gitignored per preference.

### Global config

Lives at `~/.claude-swarm/config.json`. Created by `swarmkit init` or manually. Sets user-wide defaults that apply to all projects unless overridden:

```json
{
  "map": {
    "server": "ws://my-map-server:8080",
    "sidecar": "session",
    "auth": {
      "token": "my-token"
    }
  },
  "sessionlog": {
    "enabled": true,
    "sync": "metrics"
  }
}
```

This is useful for settings you don't want to repeat in every project — MAP server address, auth tokens, sidecar mode, sessionlog preferences. Fields like `template` and `map.scope` are typically project-specific and belong in the project config.

### Environment variable overrides

All config values can be overridden via `SWARM_*` environment variables:

| Config field | Environment variable |
|---|---|
| `template` | `SWARM_TEMPLATE` |
| `map.server` | `SWARM_MAP_SERVER` |
| `map.enabled` | `SWARM_MAP_ENABLED` |
| `map.scope` | `SWARM_MAP_SCOPE` |
| `map.systemId` | `SWARM_MAP_SYSTEM_ID` |
| `map.sidecar` | `SWARM_MAP_SIDECAR` |
| `map.auth.token` | `SWARM_MAP_AUTH_TOKEN` |
| `map.auth.param` | `SWARM_MAP_AUTH_PARAM` |
| `sessionlog.enabled` | `SWARM_SESSIONLOG_ENABLED` |
| `sessionlog.sync` | `SWARM_SESSIONLOG_SYNC` |

## How it works

1. **SessionStart hook** ensures `openteams` is installed and reads your team configuration
2. **openteams generators** produce per-role SKILL.md files with prompts, communication config, and CLI references
3. **Agent bridge** converts those into Claude Code agent definitions
4. **Claude Code agent teams** spawns teammates according to the topology

Teams coordinate via openteams' shared state (SQLite-backed tasks, messages, and signal channels) alongside Claude Code's native team features.

## Creating custom topologies

See the [openteams documentation](https://github.com/alexngai/openteams) for the full template format. A minimal topology:

```yaml
name: my-team
version: 1
roles:
  - lead
  - researcher
  - implementer

topology:
  root:
    role: lead
    prompt: prompts/lead.md
  spawn_rules:
    lead: [researcher, implementer]
    researcher: []
    implementer: []

communication:
  enforcement: permissive
  channels:
    workflow:
      signals: [RESEARCH_DONE, IMPLEMENTATION_DONE]
  subscriptions:
    lead:
      - channel: workflow
  emissions:
    researcher: [RESEARCH_DONE]
    implementer: [IMPLEMENTATION_DONE]
```

## Requirements

- Claude Code with agent teams support (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)
- Node.js >= 18
- openteams (installed automatically)