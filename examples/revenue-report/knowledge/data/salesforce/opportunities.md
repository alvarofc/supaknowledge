---
type: Salesforce Object
title: Salesforce opportunities
description: Where Acme's bookings, renewals and expansion deals live, and which fields to use.
resource: salesforce://acme/Opportunity
tags: [salesforce, bookings, pipeline]
stale_after: "2027-03-01T00:00:00Z"
sources:
  - id: revops-field-guide
    title: RevOps field guide (Salesforce)
    resource: https://handbook.acme.example/revops/salesforce-fields
---

# Salesforce opportunities

Every deal is an `Opportunity` in Salesforce. Use it for bookings, pipeline and the expansion and churn
inputs of [NRR](../../metrics/nrr.md). For recognized revenue use the
[revenue fact table](../bigquery/revenue.md) instead.

## Fields

| Field | Meaning |
|---|---|
| `StageName` | `Closed Won` means booked. Ignore `Closed Lost`. |
| `CloseDate` | Booking date. Fiscal quarters follow calendar quarters. |
| `Type` | `New Business`, `Expansion`, `Renewal` or `Contraction`.[^revops-field-guide] |
| `Amount` | Total contract value in USD. |
| `ARR_Delta__c` | Change in ARR caused by this deal (negative for contractions and churn).[^revops-field-guide] |
| `AccountId` | Joins to `account_id` in the revenue fact table. |

## Example (SOQL)

```sql
SELECT Type, SUM(ARR_Delta__c)
FROM Opportunity
WHERE StageName = 'Closed Won' AND CloseDate = LAST_N_MONTHS:12
GROUP BY Type
```

## Pitfalls

- Renewals at the same price have `ARR_Delta__c = 0`; they still count as retained ARR.
- Multi-year deals: use `ARR_Delta__c`, never `Amount`, for anything ARR-related.

[^revops-field-guide]: RevOps field guide, section "Opportunity fields".
