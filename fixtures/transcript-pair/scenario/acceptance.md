# Acceptance checklist: --timeout flag for netfetch

- [ ] netfetch gains a --timeout flag accepting a value in whole seconds.
- [ ] Omitting --timeout preserves the existing default of 30 seconds.
- [ ] A timed-out download exits the process with code 124.
- [ ] The implementation adds zero new npm dependencies.
- [ ] Passing a --timeout value over 3600 seconds logs a warning instead of failing.
- [ ] The timeout error message names the URL that timed out.
- [ ] (Stretch, not required this release) A --retries flag exists.
- [ ] (Stretch, not required this release) A -t short alias for --timeout exists.
