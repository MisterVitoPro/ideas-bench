# Spec: --timeout flag for netfetch (produced by /ideas:interview)

One-line summary: adds a --timeout flag to netfetch with a preserved default and a
documented, CI-compatible failure mode.

## Requirements

- netfetch gains a --timeout flag accepting a value in whole seconds.
- Omitting --timeout preserves the existing default of 30 seconds.
- A timed-out download exits the process with code 124, matching the Unix `timeout`
  command convention that CI's retry logic already keys off.
- A -t short alias for --timeout is included as a stretch goal.
- A --retries flag is included as a stretch goal, not required for this release.
- The timeout error message names the URL that timed out.
- The implementation adds zero new npm dependencies.

## Assumptions

- We assume --timeout applies to the whole multi-file download as a single clock,
  not to each individual request separately -- this was not resolved during the
  interview and should be confirmed before implementation starts.
- We assume --timeout values over 3600 seconds should log a warning rather than be
  rejected, per the stated preference, even though this wasn't explicitly re-confirmed
  in the final review.

## Out of scope

- Fractional-second timeout values (e.g. 2.5) are out of scope for this release; only
  whole seconds are accepted.
- A --timeout value of 0 is rejected as invalid input rather than treated as "no
  timeout" -- flagged here as an assumption pending confirmation.
