I maintain `chlog`, a small Node.js CLI tool we publish to npm that our teams use to generate changelog entries from git history. Right now it always looks at commits from the last git tag up to HEAD and prints a Markdown changelog section -- that's the default behavior and it needs to keep working exactly the same way for anyone who doesn't pass any flags.

What I want to add is a `--since` flag so people can generate a changelog for a custom date range instead of just "since last tag." It should take a date, like `2026-01-01`.

The output has to stay valid Markdown -- it gets pasted straight into CHANGELOG.md files across a dozen repos, so the format can't drift from what those files already expect.

A couple of nice-to-haves if there's time: a short `-s` alias for the flag, and it'd be great if the date parser also accepted full ISO 8601 timestamps with a time component, not just plain dates. If someone types a garbled date, the error message should tell them what formats are actually accepted instead of just failing silently or throwing a stack trace.

This has to run identically on Windows and Linux -- we run `chlog` in CI on both, and the last thing I want is someone filing a bug that says "works on my Mac but breaks the Windows runner."

One more thing: commits from our bot accounts (their usernames all end in `[bot]`, like `dependabot[bot]`) skew the commit count and shouldn't be counted or listed -- those already get excluded elsewhere in the codebase and this feature should follow the same rule. It'd also be nice if the tool printed a one-line summary like "42 commits since 2026-01-01" so people get quick confirmation it worked.

Oh, and since you're asking about constraints: the CI runners that execute `chlog` are air-gapped for security reasons, so absolutely nothing in this tool can make a network call -- everything has to work from the local git history alone. Also, this needs to land in the release going out this Friday, and that release is at most a minor version bump, so whatever I ship can't break anyone currently calling `chlog` without the new flag.
