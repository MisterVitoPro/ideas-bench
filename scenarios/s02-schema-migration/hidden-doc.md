I own the backend database for AronaLearn's account system. We're on PostgreSQL 15 and manage every schema change through node-pg-migrate migrations that are already in the repo.

Right now the `users.email` column is just `TEXT` with no uniqueness constraint at all. We've got roughly 120,000 rows in there, and because there was never a constraint, some accounts differ only by case -- `Jane@Example.com` and `jane@example.com` are two separate rows for the same person in a bunch of cases.

I want to fix this going forward: emails need to be enforced as unique, case-insensitively. I'd like a generated `email_normalized` column, lower-cased, with an index on it so lookups during login stay fast. Going forward, the application code should also lower-case emails at signup so we're not relying on the database to catch everything.

Before I can add that uniqueness constraint, though, the existing case-variant duplicates need to be resolved automatically as part of the migration -- when two rows collide, keep the older account (the one created first), since a human can't realistically review 120k rows by hand.

This absolutely cannot cause downtime. We have users logging in around the clock across time zones, so whatever migration strategy we use has to run without taking the `users` table offline.

I'd also like the migration to be reversible if we need to roll it back, and before it touches production I want it run and verified against staging first.

One more nice-to-have: since accounts are going to get merged, it'd help our support team a lot to have some kind of report or log of which rows got merged and into which account, so they can help affected users if they call in confused about their old login.

Since you asked what else is going on around this: there's a nightly export job that does `SELECT *` against the `users` table and reads columns positionally -- it's old and nobody wants to touch it right now, so whatever columns get added, the existing column order can't change or that job breaks. And separately, compliance has a requirement that any time an email value changes as part of this kind of merge process, that change gets written to an audit log table -- that applies here too.
