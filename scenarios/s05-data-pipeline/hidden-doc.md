I own a data pipeline that needs to land daily sales data from three regional warehouses into our central Snowflake warehouse. Everything else we run is orchestrated through Airflow already, so this needs to be a new DAG alongside our existing ones, scheduled to run nightly.

Each of the three regional warehouses drops a CSV file into its own path in S3 by 2am UTC -- that's already how they operate today, we're just not consuming those files yet. The destination is a table called `analytics.daily_sales` in Snowflake.

Here's the annoying part: the three warehouses don't use the same column names for the same thing. One calls it "SKU," another calls it "sku_id," the third calls it "item_code." Whatever we build needs to reconcile those into one canonical schema before loading.

Currency is another wrinkle -- each warehouse reports in its local currency, and everything needs to land in the table converted to USD using that day's exchange rate.

This has to be idempotent. If the DAG gets re-run for a day that already loaded successfully -- whether because of a retry or someone manually triggering it again -- it can't duplicate rows in `daily_sales`.

Nice-to-haves if we have bandwidth: a Slack alert if any of the three warehouses' files haven't shown up by 4am UTC, some basic data-quality checks before loading (like rejecting negative quantities), the ability to backfill the last 90 days of history on demand, and a daily row-count metric emitted somewhere a dashboard can pick it up for monitoring.

Since you're asking what else touches this data: the EU warehouse's raw export is subject to GDPR, and its files include a column with customer names in them -- that column has to be dropped or anonymized before the data leaves EU-region infrastructure, it can't just ride along into Snowflake as-is. Separately, Finance already runs a manual monthly reconciliation process against this same `daily_sales` table -- if the grain of the table changes, like adding rows for partial-day loads that didn't exist before, their existing report would break without anyone telling them.
