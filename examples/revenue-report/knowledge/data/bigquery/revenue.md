---
type: BigQuery Table
title: Revenue fact table (finance.revenue_daily)
description: Daily recognized revenue per invoice line in BigQuery; the source for every revenue number Acme reports.
resource: bigquery://acme-prod/finance/revenue_daily
tags: [revenue, bigquery, finance]
stale_after: "2027-03-01T00:00:00Z"
sources:
  - id: dbt-revenue-daily
    title: dbt model finance.revenue_daily
    resource: https://github.example/acme/analytics/blob/main/models/finance/revenue_daily.sql
  - id: data-catalog
    title: Data catalog entry for finance.revenue_daily
    resource: https://catalog.acme.example/tables/acme-prod.finance.revenue_daily
x-acme-owner: finance-data
---

# Revenue fact table

`acme-prod.finance.revenue_daily` holds recognized revenue, one row per invoice line per day.[^dbt-revenue-daily]
Use it for revenue by month, region or product line, and as the input to [ARR](../../metrics/arr.md) and
[NRR](../../metrics/nrr.md). Bookings and pipeline are not here; they live in
[Salesforce opportunities](../salesforce/opportunities.md).

## Columns

| Column | Type | Meaning |
|---|---|---|
| `invoice_date` | DATE | Day the revenue was recognized (UTC). Partition column. |
| `account_id` | STRING | Salesforce account id (18 characters). |
| `region` | STRING | `NA`, `EMEA`, `APAC` or `LATAM`. |
| `product_line` | STRING | `Platform`, `Insights` or `Services`. |
| `revenue_usd` | NUMERIC | Recognized revenue in USD, net of discounts and credits.[^data-catalog] |
| `is_recurring` | BOOL | `true` for subscription revenue, `false` for one-off services. |

## Example: revenue by region for a month

```sql
select region, sum(revenue_usd) as revenue_usd
from `acme-prod.finance.revenue_daily`
where invoice_date between '2026-11-01' and '2026-11-30'
group by region
order by revenue_usd desc
```

## Pitfalls

- Always filter on `invoice_date`: the table is partitioned and a full scan costs about $40.
- Revenue for the current day is incomplete until the 06:00 UTC load finishes.
- Amounts are already in USD; do not convert them again.

[^dbt-revenue-daily]: dbt model `finance.revenue_daily`, owned by the finance data team.
[^data-catalog]: Data catalog entry for `acme-prod.finance.revenue_daily`.
