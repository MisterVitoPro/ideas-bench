# Acceptance checklist -- s01-cli-flag

- [ ] `chlog` is a published Node.js CLI tool; the new feature is an additive flag, not a rewrite.
- [ ] Running `chlog` with no flags produces exactly the same behavior as before (last tag to HEAD).
- [ ] A `--since <date>` flag exists and accepts at least a plain date like `2026-01-01`.
- [ ] Output remains valid Markdown compatible with the existing CHANGELOG.md format.
- [ ] Commits authored by accounts ending in `[bot]` are excluded from `--since` output and any count.
- [ ] The feature works identically when run on Windows and Linux.
- [ ] The implementation makes no network calls (must work in an air-gapped CI runner).
- [ ] The change ships as a backward-compatible, non-breaking (at most minor version) release.
- [ ] (Nice-to-have) A `-s` short alias for `--since` is available.
- [ ] (Nice-to-have) The date parser also accepts full ISO 8601 timestamps, not just plain dates.
- [ ] (Nice-to-have) An invalid date produces an error message listing the accepted formats.
- [ ] (Nice-to-have) A one-line summary of the matched commit count is printed.
