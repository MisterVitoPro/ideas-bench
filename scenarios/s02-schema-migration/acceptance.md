# Acceptance checklist -- s02-schema-migration

- [ ] Migrations are implemented as node-pg-migrate migrations against PostgreSQL 15, consistent with the existing repo convention.
- [ ] Case-variant duplicate email rows are resolved automatically before the uniqueness constraint is added, keeping the oldest account per colliding email.
- [ ] A case-insensitive uniqueness constraint on email is enforced after duplicates are resolved.
- [ ] The migration runs without taking the users table offline (no downtime for the 24/7 login path).
- [ ] Staging is migrated and verified before the migration is applied to production.
- [ ] Every email change made during the duplicate-merge process is written to an audit log table.
- [ ] The existing column order of the users table is preserved (a nightly job SELECT *s positionally against it).
- [ ] (Nice-to-have) An email_normalized generated/lower-cased column exists and is indexed.
- [ ] (Nice-to-have) Application code lower-cases emails at signup going forward.
- [ ] (Nice-to-have) The migration includes a working down/rollback migration.
- [ ] (Nice-to-have) A report or log of merged duplicate rows is produced for the support team.
