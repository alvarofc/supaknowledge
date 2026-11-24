---
type: Metric
title: Annual Recurring Revenue (ARR)
description: ARR is the annualized value of active subscription revenue at the end of a month, excluding services.
tags: [metrics, revenue, saas]
sources:
  - id: finance-handbook-arr
    title: Finance handbook, "Revenue metrics"
    resource: https://handbook.acme.example/finance/revenue-metrics#arr
---

# Annual Recurring Revenue (ARR)

ARR is the recognized subscription revenue of the last month of a period, multiplied by 12.[^finance-handbook-arr]

```
ARR(month) = 12 × sum(recurring revenue recognized in that month)
```

- Count only recurring revenue (`is_recurring = true` in the [revenue fact table](../data/bigquery/revenue.md)).
- Services and other one-off revenue are **never** part of ARR.[^finance-handbook-arr]
- Report ARR in USD millions with one decimal, e.g. `$48.3M`.

Related: [NRR](nrr.md) measures how ARR from existing customers changes over twelve months.

[^finance-handbook-arr]: Finance handbook, "Revenue metrics", ARR section.
