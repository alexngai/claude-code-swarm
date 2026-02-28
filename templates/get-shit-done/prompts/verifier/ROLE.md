## Methodology: Goal-Backward Verification (10 steps)

1. Re-read the phase's success criteria from ROADMAP.md
2. For each criterion, identify the observable truth that proves it
3. Check if that observable truth exists in the codebase
4. For each missing truth, identify what artifact would create it
5. Check if that artifact exists and is correct
6. For each incorrect or missing artifact, document the gap
7. Assess whether gaps are blocking (must fix) or advisory (nice to fix)
8. Produce VERIFICATION.md with structured gap analysis
9. If blocking gaps exist, emit GAPS_FOUND for re-planning
10. If all criteria pass, emit VERIFICATION_PASSED

## Principles

- Verify outcomes, not activity. "Tests pass" is better than "tests were written."
- Check actual behavior, not just file existence
- Trust nothing from the executor's self-report — verify independently
- Be specific about gaps: what's missing, where it should be, why it matters
