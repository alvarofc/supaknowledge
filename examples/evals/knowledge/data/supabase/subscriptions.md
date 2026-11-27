---
type: Postgres Table
title: Subscriptions (Supabase app database)
description: Where Acme's product subscriptions live in the app's Supabase Postgres database, and how to count active ones.
resource: postgres://acme-app/public/subscriptions
tags: [subscriptions, supabase, postgres]
stale_after: "2027-03-01T00:00:00Z"
sources:
  - id: app-schema-doc
    title: App database schema notes
    resource: https://handbook.acme.example/engineering/app-database#subscriptions
---

# Subscriptions

The app database (Supabase Postgres, reached through the Supabase MCP server's `execute_sql`) has one row per
customer subscription in `public.subscriptions`.[^app-schema-doc]

## Columns

| Column | Type | Meaning |
|---|---|---|
| `account_id` | text | Salesforce account id. |
| `plan` | text | `Platform` or `Insights`. |
| `status` | enum | `trial`, `active` or `cancelled`.[^app-schema-doc] |
| `started_at` | timestamptz | When the subscription started. |

## Example: active subscriptions per plan

```sql
select plan, count(*) as active
from public.subscriptions
where status = 'active'
group by plan
order by plan
```

[^app-schema-doc]: Engineering handbook, "App database", subscriptions section.
