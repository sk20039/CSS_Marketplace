# CSS Marketplace — Four-Role Build Workflow

Standing process for turning ideas into shipped features on the USA Cricket Equipment Marketplace (see `USA_Cricket_Marketplace_PRD.md` for product context: C2C bat/gear resale, escrow payments, Stripe, dispute handling, MVP scope in PRD §8).

This is not four permanent separate bots — Claude runs this as a sequential pipeline, spawning a subagent per role with a tailored brief, in this order: Architect → Coder → Tester → Manager. Each role's output feeds the next. Claude (the orchestrating session) keeps context across the whole run and relays Manager findings to Sal at the end, along with anything that needs a decision.

## Agent 1 — Architect

**Job:** Turn a raw idea or feature request into a concrete build plan.

**Process:**
1. Read the PRD and any prior charter/spec docs in this project for context.
2. Before writing the plan, ask Sal the key open questions that materially change the design — scope boundaries, data model decisions, which MVP pieces are in/out, integration choices (e.g. Stripe Connect vs. standard Stripe), anything ambiguous in the request. Uses `AskUserQuestion` rather than guessing.
3. Once answered, produce a build plan: scope, data model / schema, API or component list, sequencing, and explicit non-goals for this pass.

**Output:** A written plan document handed directly to the Coder. No code.

## Agent 2 — Coder

**Job:** Implement the Architect's plan as working code.

**Process:**
1. Follow the Architect's plan; does not re-litigate scope decisions Sal already made.
2. Writes real, runnable code files in the session workspace (stack per PRD §11 unless the plan says otherwise: React/Next.js frontend, Node.js or Python backend, PostgreSQL, Stripe for payments).
3. Notes any assumptions made where the plan under-specified something, rather than silently improvising.

**Output:** Working code files, delivered to Sal via file share, plus a short note of what was built and any assumptions made.

## Agent 3 — Tester

**Job:** Break what the Coder built. Nothing else.

**Scope:** Functional and edge-case testing — logic bugs, bad/malformed inputs, broken user flows, boundary conditions. Given this product's domain, priority areas include: escrow state transitions, the 24–48 hour confirmation/dispute window timing, payment amount/fee calculation (3% seller fee), dispute-reason validation (valid vs. invalid reasons per PRD §7), listing/search filter correctness, and race conditions around "buyer confirms vs. window expires."

**Out of scope (for now):** Security/adversarial pen-testing (auth bypass, injection, payment manipulation) — can be added as a second tester mode later if Sal wants it.

**Output:** A list of concrete failure cases found (input → wrong behavior), ranked by severity. No fixes — just findings, handed to the Manager.

## Agent 4 — Manager

**Job:** Review the Architect's plan, the Coder's implementation, and the Tester's findings together, and flag what actually matters to Sal.

**Process:**
1. Checks the implementation against the original plan (did the Coder build what was scoped, any silent deviations).
2. Triages the Tester's findings — which are real bugs vs. noise, which are launch-blockers vs. later cleanup.
3. Reports a short, prioritized punch list to Sal: what's solid, what's broken, what needs a decision.

**Output:** A concise status report — not a rewrite of the other three outputs, just the verdict and the flags.

## How to trigger a run

Sal hands Claude a specific feature or task (e.g. "build the seller listing upload flow" or "build the MVP escrow payment logic"). Claude runs Architect first (including its clarifying questions to Sal), then Coder, then Tester, then Manager, in that order, and reports the Manager's summary at the end along with the actual deliverables (plan doc + code files).

**Settings locked in with Sal (2026-07-25):**
- Coder produces real working code files in-session, not just pseudocode.
- Tester does functional/edge-case testing only, not security red-teaming (revisit later if needed).
