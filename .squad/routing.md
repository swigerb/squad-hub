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
| Session logging | scribe | Automatic — never needs routing. Spawned with its explicit model; see Model Policy. |
| RAI review | rai | Content safety, bias checks, credential detection, ethical review |

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

1. **Lean by default** — spawn only the members the task needs. A typical change is one owner (usually `engineer`) plus one `reviewer` pass. No anticipatory, speculative or parallel downstream agents.
2. **Scribe always runs** after substantial work, always as `mode: "background"`. Never blocks. Spawn it as `name: "scribe"` with `model: "claude-haiku-5.5"` (`agentModelOverrides.scribe`) — never a template default.
3. **Quick facts → coordinator answers directly.** Don't spawn an agent for "what port does the server run on?"
4. **When two agents could handle it**, pick the one whose domain is the primary concern.
5. **"Team, ..." → fan-out only on request.** Spawn several agents in parallel only when the maintainer explicitly asks the team, and only for independently deliverable outcomes.
6. **Judgement roles on demand, not by default.** `security` only for auth, credentials, tokens, isolation or fail-closed guards; `rai` only for content safety or user-facing AI output; `fact-checker` only for release notes or claims of measured results; `advisor` only per Escalating to the advisor below.
7. **Issue-labeled work** — when a `squad:{member}` label is applied to an issue, route to that member. The Lead handles all `squad` (base label) triage.
8. **One review round.** The reviewer reviews once; the owner fixes what is required. No re-review unless the fix changes behaviour beyond what was asked. Remaining disagreements go in the pull request for the maintainer, not into another review cycle.


## Model Policy

The team runs the [advisor strategy][adv]: a cheaper model drives the work end to
end, and escalates to a frontier model only when it hits something it cannot
reasonably settle.

[adv]: https://claude.com/blog/the-advisor-strategy

| Tier | Model | Who | Why |
|------|-------|-----|-----|
| Advisor | `gpt-6.1-sol` | advisor, security, rai, fact-checker | Roles that **judge** rather than execute, called on demand (rule 6). A bad call costs the team a cycle or blocks a release. |
| Executor | `claude-sonnet-5.5` | lead, engineer, reviewer, ralph | Roles that **drive**: call tools, read results, iterate. They escalate rather than guess. `lead` coordinates every session, so it runs on this tier and escalates hard calls to `advisor` (2026-10-19). |
| Scribe | `claude-haiku-5.5` | scribe, docs | High volume, low ambiguity. |

`.squad/config.json` sets `defaultModel` to the **executor** model and lists every
member explicitly, because Layer 0a beats Layer 0b and an unlisted agent is easy
to misread as deliberate. A new agent added later lands on the executor tier by
default rather than silently inheriting the frontier one.

The names in the **Who** column are the exact config keys: the lowercase
`.squad/agents/<name>/` folder, which is also the casting registry key and the
spawn `name`. Display names such as `Rai` or `Scribe` are not keys; a lookup under
one never matches and silently falls through to `defaultModel`.

Every spawn — including the after-agent Scribe — passes the member's model from
`agentModelOverrides` explicitly; see Per-Agent Model Selection in
`.github/agents/squad.agent.md`, which overrides any template default. If the
configured model is unavailable, stop and report which member and model. Do not
retry on another model and do not omit the `model` parameter.

This table supersedes the earlier model mapping (2026-10-09, issue #246). The
earlier mapping is preserved as a superseded entry in `.squad/decisions.md`.

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
6. **A Squad on ACA session has one hour.** Commit and end the turn within 45
   minutes; anything unfinished goes in a `Remaining:` checklist. Work that will
   not fit is split into smaller issues, not squeezed in.
7. **In-session testing is targeted.** Run the test files for what you touched,
   and `node test/mutate-probe.js` for new mutations. In a Squad on ACA session do
   not run the full `npm test`, `test/mutate.js` across the catalogue,
   `test/acceptance.js`, repeat or stress loops, and do not sleep-poll background
   runs: the pull request's CI (the Tests matrix and Windows candidate
   acceptance) is the proof. A maintainer may still run them locally.