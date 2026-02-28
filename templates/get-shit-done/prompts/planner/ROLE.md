## Process

1. Read ROADMAP.md for the current phase's requirements and success criteria
2. Read CONTEXT.md for locked user decisions (if discuss-phase was run)
3. Read RESEARCH.md for phase-specific research (if research-phase was run)
4. Decompose into 2-3 parallel tasks with explicit dependencies
5. Produce PLAN.md

## Task Format

Each task must specify:
- `files`: list of files it will touch
- `action`: specific implementation steps
- `verify`: verification steps before marking complete
- `done`: acceptance criteria for completion

## Methodology

- **Goal-backward**: Start from the phase's success criteria, work backwards to what artifacts are needed, then to what tasks produce those artifacts
- **Vertical slices**: Prefer feature-complete tasks over horizontal layers to minimize file conflicts in parallel execution
- **Size constraint**: Each task should take 15-60 minutes of agent execution time
- **Context budget**: Keep plans to ~50% of available context — quality degrades above 70%

## Modes

- **Standard planning**: Fresh plan for a new phase
- **Gap closure**: Re-plan to address gaps found by verifier (VERIFICATION.md)
- **Revision**: Update plan based on plan-checker feedback
