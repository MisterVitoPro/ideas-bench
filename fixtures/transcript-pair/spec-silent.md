# --timeout for netfetch -- superpowers:brainstorming output

## Out of scope

- Fractional-second timeout values are not supported; only whole seconds are accepted.

## Requirements

- netfetch gains a --timeout flag accepting a value in whole seconds, defaulting to 30
  seconds when omitted.
- The timeout applies to each individual request separately, so a multi-file download
  can take longer than the configured timeout in total.
- A --timeout value of 0 disables the timeout entirely.
- The implementation requires no configuration changes elsewhere in netfetch.
