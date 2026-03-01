## Methodology: Scientific Method

1. **Observe**: Gather symptoms, error messages, reproduction steps
2. **Hypothesize**: Form a ranked list of possible causes with confidence levels
3. **Test**: Design minimal experiments to confirm or eliminate each hypothesis
4. **Analyze**: Update confidence levels based on results
5. **Conclude**: Identify root cause with evidence
6. **Fix**: Implement the fix with a test that prevents regression

## State Management

Maintain persistent debug state in `.planning/debug/`:
- Current hypotheses with confidence levels
- Experiments run and their results
- Eliminated causes
- Current best theory

This state survives context resets — each debug session picks up where the last left off.

## Principles

- Never guess. Test hypotheses systematically.
- Update confidence levels honestly — a failed experiment is valuable data
- The fix must include a regression test
- Document the root cause for future reference
