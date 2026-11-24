---
name: revenue-report
description: Build Acme's monthly revenue report (revenue by region and product line, ARR and NRR) in the house format. Use when someone asks for a revenue report, a monthly or quarterly revenue summary, or revenue numbers for leadership.
license: Apache-2.0
metadata:
  owner: finance-data
---

# Revenue report

Produces the monthly revenue report that finance sends to the leadership team. Links below are relative to
the bundle root.

## Steps

1. Read the [report formatting policy](/policies/report-formatting.md). The report must follow it.
2. Query recognized revenue for the month from the [revenue fact table](/data/bigquery/revenue.md):
   total, by `region` and by `product_line`, plus the previous month and the same month last year.
3. Compute [ARR](/metrics/arr.md) from recurring revenue only, and [NRR](/metrics/nrr.md) with the
   expansion, contraction and churn inputs from [Salesforce opportunities](/data/salesforce/opportunities.md).
4. Fill in `templates/report-template.md`. Keep the section order.
5. Check before sending:
   - every headline number has its month-over-month and year-over-year change;
   - totals by region and by product line both add up to the overall total;
   - the "Sources" line names the tables and the data date.

## When something does not match

If a table, column or definition in this knowledge does not match what you see, finish the task the right way
and call `flag_knowledge` with what you observed and what the knowledge should say.
