---
type: Metric
title: Net Revenue Retention (NRR)
description: NRR is the share of ARR from customers a year ago that Acme still has today, including expansion, contraction and churn.
tags: [metrics, revenue, retention]
sources:
  - id: finance-handbook-nrr
    title: Finance handbook, "Revenue metrics"
    resource: https://handbook.acme.example/finance/revenue-metrics#nrr
---

# Net Revenue Retention (NRR)

NRR compares today's [ARR](arr.md) from a cohort of customers with their ARR twelve months ago.[^finance-handbook-nrr]

```
NRR = (starting ARR + net ARR change) / starting ARR
net ARR change = sum(ARR_Delta__c) over the cohort's Closed Won deals in the period
```

- The cohort is every account with ARR > 0 twelve months before the end of the period.
- New customers acquired during the period are excluded.
- Expansion, contraction and churn come from `ARR_Delta__c` on
  [Salesforce opportunities](../data/salesforce/opportunities.md). It is positive for expansion and already
  negative for contraction and churn, so add it as is: never subtract contraction or churn a second time.
- Report NRR as a percentage with no decimals, e.g. `112%`.

[^finance-handbook-nrr]: Finance handbook, "Revenue metrics", NRR section.
