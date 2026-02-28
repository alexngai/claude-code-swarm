# claude-code-swarm

Claude Code plugin that launches agent teams from openteams YAML topologies.

## What this plugin does

This plugin bridges [openteams](https://github.com/alexngai/openteams) team templates with Claude Code's agent teams feature. It provides:

1. **SessionStart hook** (`scripts/team-loader.sh`) — Runs on session start to ensure openteams is installed, reads the configured team template, and injects team context
2. **`/swarm` skill** (`skills/swarm/SKILL.md`) — User-invocable skill to select and launch a team topology
3. **Agent generator** (`scripts/generate-agents.mjs`) — Converts openteams YAML templates into Claude Code AGENT.md files

## Plugin structure

```
claude-code-swarm/
├── .claude-plugin/plugin.json    # Plugin manifest
├── hooks/hooks.json              # SessionStart hook configuration
├── scripts/
│   ├── team-loader.sh            # Hook script: installs openteams, loads team context
│   └── generate-agents.mjs       # Bridge: openteams templates → AGENT.md files
├── skills/swarm/SKILL.md         # /swarm skill definition
├── templates/                    # Bundled team topology templates
│   ├── get-shit-done/            # GSD: wave-based parallel execution team
│   └── bmad-method/              # BMAD: full agile development team
├── settings.json                 # Enables agent teams, allows openteams commands
└── .generated/                   # Generated artifacts (gitignored)
```

## How to use

### Quick start
1. Create `.claude-swarm.json` in your project root:
   ```json
   { "template": "get-shit-done" }
   ```
2. Start a Claude Code session — the hook loads the team automatically
3. Or use `/swarm get-shit-done` to launch manually

### Available templates
- **get-shit-done** — 12-role system with wave-based parallel execution, goal-backward verification
- **bmad-method** — 10-role agile team across 4 phases (analysis, planning, solutioning, implementation)

### Custom templates
Point to any openteams template directory:
```json
{ "template": "/path/to/your/template" }
```

## Key dependencies
- **openteams** (npm package) — installed automatically by the SessionStart hook
- **Claude Code agent teams** — enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json

## Development notes
- Templates in `templates/` are copied from openteams' `examples/` directory
- The generate-agents script has a fallback mode when openteams isn't installed (basic YAML parsing)
- Generated artifacts go in `.generated/` which should be gitignored
