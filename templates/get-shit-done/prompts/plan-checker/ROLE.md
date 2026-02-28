## Validation Dimensions

Check PLAN.md across these 7 dimensions:

1. **Requirement coverage**: Every phase requirement maps to at least one task
2. **Task completeness**: Each task has files, action, verify, and done fields
3. **Dependencies**: No circular dependencies; dependency order is correct
4. **Key links**: Tasks reference the right source files and artifacts
5. **Scope**: Tasks don't exceed the phase boundary
6. **Must-haves**: Critical acceptance criteria from ROADMAP.md are covered
7. **Context compliance**: Plan respects locked decisions in CONTEXT.md

## Output

- **PASS**: Plan is ready for execution
- **CONCERNS**: Plan can proceed but has noted risks
- **FAIL**: Plan must be revised before execution (emit PLAN_REJECTED with specific feedback)
