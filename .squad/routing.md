# Work Routing

How to decide who handles what.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Implementation | engineer | Daemon, hub service, CLI, web app, spikes that settle a premise |
| Tests and mutations | engineer | New assertions, and the mutation that proves each one bites |
| Code review | reviewer | Correctness, would-the-test-catch-it, regressions |
| Security review | security | Auth surfaces, credential scope, secret storage, isolation, fail-closed guards |
| Documentation | docs | README, docs/, capability matrices, failure modes, honest limits |
| Scope & priorities | lead | What to build next, sequencing, which premise to test first |
| An executor is stuck | advisor | Two defensible designs, a failing premise, or the same fix failing twice. Guidance only -- the executor keeps the work. |
| Session logging | Scribe | Automatic — never needs routing |
| RAI review | Rai | Content safety, bias checks, credential detection, ethical review |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Lead |
| `squad:{name}` | Pick up issue and complete the work | Named member |

### How Issue Assignment Works

1. When a GitHub issue gets the `squad` label, the **Lead** triages it — analyzing content, assigning the right `squad:{member}` label, and commenting with triage notes.
2. When a `squad:{member}` label is applied, that member picks up the issue in their next session.
3. Members can reassign by removing their label and adding another member's label.
4. The `squad` label is the "inbox" — untriaged issues waiting for Lead review.

## Rules

1. **Eager by default** — spawn all agents who could usefully start work, including anticipatory downstream work.
2. **Scribe always runs** after substantial work, always as `mode: "background"`. Never blocks.
3. **Quick facts → coordinator answers directly.** Don't spawn an agent for "what port does the server run on?"
4. **When two agents could handle it**, pick the one whose domain is the primary concern.
5. **"Team, ..." → fan-out.** Spawn all relevant agents in parallel as `mode: "background"`.
6. **Anticipate downstream work.** If a feature is being built, spawn the tester to write test cases from requirements simultaneously.
7. **Issue-labeled work** — when a `squad:{member}` label is applied to an issue, route to that member. The Lead handles all `squad` (base label) triage.


## Model Policy

The team runs the [advisor strategy][adv]: a cheaper model drives the work end to
end, and escalates to a frontier model only when it hits something it cannot
reasonably settle.

[adv]: https://claude.com/blog/the-advisor-strategy

| Tier | Model | Who | Why |
|------|-------|-----|-----|
| Advisor | `claude-opus-5` | advisor, lead, security, Rai, fact-checker | Roles that **judge** rather than execute. A bad call costs the team a cycle or blocks a release. |
| Executor | `claude-sonnet-5` | engineer, reviewer, ralph | Roles that **drive**: call tools, read results, iterate. They escalate rather than guess. |
| Scribe | `claude-haiku-4.5` | scribe, docs | High volume, low ambiguity. |

`.squad/config.json` sets `defaultModel` to the **executor** model and lists every
member explicitly, because Layer 0a beats Layer 0b and an unlisted agent is easy
to misread as deliberate. A new agent added later lands on the executor tier by
default rather than silently inheriting the frontier one.

### Escalating to the advisor

**Do** -- two defensible designs where the wrong one is expensive to unwind; a
failure suggesting the premise is wrong rather than the code; a security or
data-loss consequence you are unsure of; the same fix failing twice.

**Don't** -- you know what to do and it is merely tedious; a lookup would answer
it; to have work checked, which is the reviewer's job and happens after; or out
of caution, because an escalation you did not need teaches the team that
escalation is free.

**One honest limitation.** Anthropic's advisor tool performs the handoff inside a
single API request. Squad cannot: an agent needing another agent must end its turn
and let the coordinator bring one in. So each escalation costs a round trip, which
is precisely why the rule above matters.

## House rules for this repository

0. **Development work routes through Squad.**
1. **This project has zero dependencies.** Adding one is a decision for `lead`,
   not a convenience for whoever is mid-task.
2. **Assert the side effect, not the reply.**
3. **A passing test proves nothing until it has been seen to fail.** New
   behaviour gets a mutation in `test/mutate.js` that deletes it.
4. **Never commit while `test/mutate.js` is running** -- it edits real source in
   place and a forced kill leaves live mutations behind.
5. **Never put a private hostname or a real account name in the repository.**
   `test/docs-unit.js` enforces this; do not work around it.