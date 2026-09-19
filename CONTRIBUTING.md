# Contributing to BLAXIN

Thanks for your interest in improving BLAXIN. This document covers what to know before opening issues or pull requests.

**Note**: v1.4.0 is the final public release. The repository remains open for bug fixes, documentation, maintenance, and non-release improvements — but no subsequent public version is planned, and contributors should not prepare or propose new numbered releases. Releases are maintainer-owned.

## Reporting bugs

[Open a bug report](https://github.com/tasinxxx/Blaxin/issues/new?template=bug_report.yml) and include:

- Your distro, desktop environment, and display server (X11 / Wayland)
- How you installed BLAXIN (installer / .deb / AppImage / from source)
- Steps to reproduce and what you expected vs. what happened
- If a task misbehaved: the **Mission Journal** excerpt (Journal page in the HUD) — it records what really happened, which makes diagnosis far faster

Security vulnerabilities: please **do not** open a public issue — see [SECURITY.md](SECURITY.md).

## Development setup

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full guide. Short version:

```bash
cd blaxin
./start.sh                 # backend :3001 + client :5173

cd server && npm test      # full test suite (~900 tests)
cd ../e2e && npm test      # real-stack E2E (backend + vite + Chrome)
```

## The project doctrine — please read

BLAXIN's core discipline is **zero fake state**, and contributions are expected to uphold it:

1. **Never fabricate success.** Tool results are verified against the real environment (read-backs, page transitions, process tables). Verification is tri-state — SUCCESS / FAILURE / UNKNOWN — and UNKNOWN must never upgrade to success.
2. **Honest failures are a feature.** If a test "fix" requires weakening an honest failure, that is the wrong fix — the implementation or the test is wrong, and it is almost never the implementation.
3. **Bounded everything.** New buffers, scans, retries, and budgets need explicit caps.
4. **No simulated UI data.** HUD panels render real runtime state only.
5. **Secrets never stored.** The memory store refuses secret-looking content; keys live only in the encrypted credential store.

## Pull requests

- Keep changes minimal and focused; one logical change per PR
- Add or update tests for behavior changes — the suite pins real behavior, so new behavior needs new pins
- Run the full server suite and the E2E suite before submitting; CI (`.github/workflows/e2e.yml`) runs both on every PR
- Do not modify `blaxin/update/latest.json`, release workflows, or version constants unless your change is part of a release — releases are maintainer-owned
- Update the relevant documentation (`README.md`, `docs/`, `blaxin/README.md`) in the same PR
- Follow the existing commit style: conventional prefixes (`fix:`, `feat:`, `docs:`, `chore:`, `perf:`) with a scope when useful

### PR checklist

- [ ] Tests pass locally (`blaxin/server` suite + `blaxin/e2e`)
- [ ] New behavior is covered by tests (including honest-failure paths)
- [ ] No secrets, credentials, or machine-specific paths introduced
- [ ] Docs updated where behavior or interfaces changed
- [ ] The zero-fake-state doctrine is preserved

## Questions & feature ideas

- [Feature request](https://github.com/tasinxxx/Blaxin/issues/new?template=feature_request.yml)
- [Browse existing issues](https://github.com/tasinxxx/Blaxin/issues)

By participating in this project you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).
