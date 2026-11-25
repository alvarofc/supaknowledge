# Notes for coding agents

## Interface copy

When you write or edit interface text, charts or screens in this project (mostly `apps/studio`):

- A heading says what the section is. No eyebrow label above it, no `01 //` numbering unless the order is real, no subtitle that repeats the heading, and no boilerplate footnote under a CTA or form ("No credit card required", "No spam").
- Never describe what is already visible: no "Click the button below", "This chart shows", "(updates in real time)".
- Badges, status dots and "Live" labels render from real state, or they are not there.
- No colored stripe on one edge of a card or panel for emphasis. A stripe that marks a real state stays.
- No decorative emoji, and no icon in a tinted square beside every item.
- Links and buttons: no `→` or arrow icon after the text, and no "Click here", "Learn more" or "Submit". Name the destination or the result.
- Edges line up: one text line per row of items, icons on one column, trailing items on one edge. Fix the container's padding, not a single item.
- Charts and KPIs: the title names the measure, not the chart type. No reading instructions, no legend where a direct label fits, hairline gridlines, and at most one line of context on a KPI card.
- Errors and empty states say what happened and what to do next, without "Oops" or an apology.
- No filler words: "seamless", "robust", "empower", "effortlessly". No em dashes: end the sentence or use a comma. Never invent a number, a customer count or a testimonial.

Studio-specific:

- Show one fact per metadata line. Don't chain facts with "·"; keep the one a person acts on and move the rest to the detail page.
- Never print raw ids (UUIDs) in prose. Link the thing they identify instead.
- Long, secondary detail (suggested fixes on handled flags, the curator's self-review) goes in a `<details>` that starts closed.

From [unslop-ui](https://github.com/felipebasurto/unslop-ui) (MIT).
