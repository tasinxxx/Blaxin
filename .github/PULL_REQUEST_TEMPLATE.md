<!-- Thank you for contributing to BLAXIN! -->

## What does this PR change?

<!-- One or two sentences: what and why. -->

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New capability (additive, does not break existing behavior)
- [ ] Documentation
- [ ] Tests only
- [ ] Refactor (no behavior change)

## Zero-fake-state checklist

BLAXIN's core discipline is that nothing pretends to be verified when it is not.

- [ ] Tool results are verified against the real environment (read-backs / real state), and UNKNOWN never upgrades to SUCCESS
- [ ] Honest failures are preserved (no test or code was weakened to pass)
- [ ] New buffers/scans/retries are bounded
- [ ] No simulated UI data introduced
- [ ] No secrets or secret-looking content can be stored by new code paths

## Verification

- [ ] `blaxin/server` test suite passes locally
- [ ] `blaxin/e2e` suite passes locally (if client/server behavior changed)
- [ ] New behavior is covered by tests, including honest-failure paths
- [ ] Documentation updated where behavior or interfaces changed

## Related issues

<!-- e.g. Fixes #123 -->
