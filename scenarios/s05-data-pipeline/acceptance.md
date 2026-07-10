# Acceptance checklist -- s05-data-pipeline

- [ ] A new Airflow DAG ingests the three regional warehouse CSV files nightly into analytics.daily_sales in Snowflake.
- [ ] Differing source column names (SKU / sku_id / item_code) are reconciled into one canonical schema before loading.
- [ ] Currency values are converted to USD using that day's exchange rate before landing in the table.
- [ ] Re-running the DAG for an already-loaded day does not duplicate rows (idempotent load).
- [ ] The EU warehouse's customer-name column is dropped or anonymized before data leaves EU-region infrastructure.
- [ ] The table's grain is not changed (e.g. no new partial-day rows) without accounting for Finance's existing monthly reconciliation process.
- [ ] (Nice-to-have) A Slack alert fires if any warehouse's file is missing by 4am UTC.
- [ ] (Nice-to-have) Basic data-quality checks (e.g. rejecting negative quantities) run before loading.
- [ ] (Nice-to-have) A 90-day on-demand backfill capability is supported.
- [ ] (Nice-to-have) A daily row-count metric is emitted for monitoring.
