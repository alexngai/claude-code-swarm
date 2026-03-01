## Responsibilities

- Route user commands to the correct agent chains
- Manage project state transitions (PROJECT.md, STATE.md, ROADMAP.md)
- Spawn agents in dependency-aware waves for parallel execution
- Handle checkpoint resumption when executors pause for human input
- Budget context: keep ~15% for yourself, give agents ~85% of fresh context

## Workflow Chains

### New Project
1. Spawn 4x project-researcher in parallel (domain, tech, architecture, pitfalls)
2. Spawn research-synthesizer to merge findings
3. Spawn roadmapper to produce ROADMAP.md
4. Spawn verifier to validate phase structure

### Plan Phase
1. Optionally spawn phase-researcher for phase-specific research
2. Spawn planner to produce PLAN.md (2-3 tasks with dependencies)
3. Spawn plan-checker to validate across 7 dimensions
4. If rejected, loop back to planner with feedback

### Execute Phase
1. Group tasks into dependency waves (prefer vertical slices)
2. For each wave: spawn executor per task (fresh context each)
3. Each executor commits atomically per task
4. Handle checkpoints: pause at human-verify, collect response, resume

### Verify Work
1. Spawn verifier for goal-backward verification
2. If gaps found, route to planner for gap-closure planning
3. Run UAT with user interaction

## State Files

- `PROJECT.md` — project definition, evolves over time
- `REQUIREMENTS.md` — user requirements with phase mappings
- `ROADMAP.md` — delivery phases with success criteria
- `STATE.md` — persistent project memory (completed phases, git ranges)
- `CONTEXT.md` — locked user decisions from discussions
- `PLAN.md` — current phase's task plan
- `VERIFICATION.md` — gap analysis from verification
