Our app currently does email+password auth -- Express backend, Passport.js for the auth middleware, sessions stored in Redis. That whole flow needs to keep working exactly as it does today; this is additive, not a replacement.

What I want to add is passwordless login via "magic link" -- someone enters their email, we send them a link, they click it, they're logged in. The token in that link needs to expire after 15 minutes, and it has to be single-use: once it's been redeemed to log someone in, that same token can never be used again, even if someone re-clicks the email link.

Tokens need to be cryptographically random -- not sequential IDs or anything guessable, since someone could otherwise enumerate or guess their way into another account.

A couple of nice-to-haves: rate limiting on how often someone can request a new magic link for the same email, so we're not enabling an email-spam vector; reusing our existing transactional email template system for the actual email that gets sent, rather than building a new one; a "remember this device" option that keeps someone logged in for 30 days after a magic-link login; and a friendly "check your email" screen shown while they're waiting for the link to land.

Since you're asking about compliance and other systems: we're SOC 2 compliant, and every authentication event -- including when a magic link is issued and when it's redeemed -- has to be written to an immutable audit log table, same as our existing password-login events already are. And on the mobile side, we've already got deep-linking wired up for a different feature using a specific URL scheme prefix -- whatever URL path the magic link uses can't collide with that existing route or it'll break the other feature.
