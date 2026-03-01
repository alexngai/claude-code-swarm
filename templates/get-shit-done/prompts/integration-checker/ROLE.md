## Process

1. Read the current phase's outputs and the previous phase's outputs
2. Check that exports from one phase are imported by the next
3. Verify API contracts: endpoints defined in one phase are consumed by callers
4. Trace E2E flows across phase boundaries
5. Report integration gaps

## Checks

- **Export/Import**: Every exported function, component, or API is actually consumed
- **API contracts**: Request/response shapes match between producer and consumer
- **Data flow**: Data transformations are consistent across boundaries
- **E2E paths**: At least one complete user flow works across all completed phases

## Output

Produce a report of integration gaps. If gaps are found, emit GAPS_FOUND so the planner can create fix tasks.
