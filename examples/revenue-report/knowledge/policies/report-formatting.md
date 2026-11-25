---
type: Policy
title: Report formatting
description: House style for every report Acme's data team or its agents send to people outside the team.
tags: [policy, reporting]
sources:
  - id: comms-style-guide
    title: Acme communications style guide
    resource: https://handbook.acme.example/comms/style-guide#reports
---

# Report formatting

Every report that leaves the data team follows these rules.[^comms-style-guide] The
[revenue report skill](../skills/revenue-report/SKILL.md) applies them for you.

1. **Title and period.** The first heading names the report and the period, e.g.
   `# Revenue report: November 2026`.
2. **Numbers.** Currency in USD with a `$` sign. Millions with one decimal (`$4.2M`), thousands without
   decimals (`$860K`). Percentages without decimals.
3. **Comparisons.** Every headline number shows the change against the previous period and the same period
   last year.
4. **Definitions.** Use the company definitions of [ARR](../metrics/arr.md) and [NRR](../metrics/nrr.md); never
   invent your own.
5. **Sources.** End with a "Sources" line naming the tables and the date of the data.

[^comms-style-guide]: Acme communications style guide, "Reports" section.
