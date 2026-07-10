# Hidden doc: --timeout flag for netfetch

I maintain netfetch, our internal Node.js CLI that the build system uses to download build
artifacts from our artifact store. Right now a hung connection can stall a build indefinitely,
so I want to add a --timeout flag.

It should take a value in whole seconds. If someone doesn't pass it, I want the existing default
behavior to stay exactly as it is today: a 30 second timeout. When a download does time out, the
process needs to exit with code 124 -- that's the same exit code the standard Unix `timeout`
command uses, and our CI scripts already have retry logic keyed off that code, so we can't pick
a different number.

A couple of things would be nice but aren't required for this release: a --retries flag for
automatically retrying a timed-out download, and a short -t alias for --timeout so it's faster
to type. If someone passes a really large timeout, more than an hour (3600 seconds), I'd rather
we just log a warning than reject it outright -- there might be a legitimate reason for a slow
connection. And when a download does time out, the error message should say which URL timed out,
not just "timed out" with no context -- that's saved people a lot of debugging time on other
tools I've used.

One hard constraint: netfetch is deliberately dependency-free -- zero npm packages -- and that
has to stay true. Whatever implements the timeout can only use Node's built-in APIs.

I haven't fully decided whether --timeout should accept fractional seconds like 2.5, whether a
value of 0 should mean "no timeout at all" or just be rejected as invalid, or whether the timeout
should apply per individual HTTP request or to the whole multi-file download as one clock. I'm
genuinely open on all three of those.
