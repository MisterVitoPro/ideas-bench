# Acceptance checklist -- s04-auth-flow

- [ ] Existing email+password login continues to work unchanged; magic-link login is additive.
- [ ] A magic-link (passwordless) login flow exists: email in, link sent, click to log in.
- [ ] Magic link tokens expire after 15 minutes.
- [ ] Magic link tokens are single-use -- redeeming a token invalidates it for any further use.
- [ ] Magic link tokens are cryptographically random, not sequential or otherwise guessable.
- [ ] Every magic-link issuance and redemption event is written to an immutable audit log table.
- [ ] The magic-link URL path does not collide with the existing mobile deep-link URL scheme prefix.
- [ ] (Nice-to-have) Requests for a new magic link to the same email are rate-limited.
- [ ] (Nice-to-have) The magic-link email is sent through the existing transactional email template system.
- [ ] (Nice-to-have) A "remember this device" option keeps the user logged in for 30 days after magic-link login.
- [ ] (Nice-to-have) A "check your email" screen is shown while the user waits for the link.
