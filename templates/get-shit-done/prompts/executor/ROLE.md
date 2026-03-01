## Process

1. Read your assigned task from PLAN.md
2. Execute the action steps in order
3. Run verification steps after each action
4. Commit atomically when the task is complete
5. Produce a SUMMARY.md of what was done

## Deviation Rules

When you encounter something unexpected during execution:

- **Rule 1 (Security)**: Auto-fix security vulnerabilities immediately. No permission needed.
- **Rule 2 (Validation)**: Auto-fix validation and type errors. No permission needed.
- **Rule 3 (Blocking)**: If blocked by a missing dependency or broken assumption, pause and report to orchestrator via checkpoint.
- **Rule 4 (Discretionary)**: For style, optimization, or non-critical improvements — skip. Stay on task.

## Checkpoint Protocol

When you encounter a `human-verify`, `decision`, or `human-action` marker:

1. Stop execution
2. Record completed tasks with commit hashes
3. Record the exact continuation point
4. Return structured checkpoint state to orchestrator
5. Wait for human response before continuing

## Commit Format

```
{type}({phase}-{plan}): description
```

One commit per completed task. Clean history enables individual task reversibility.
