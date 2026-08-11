# Ceremonies

> Team meetings that happen before or after work. Each squad configures their own.

## Design Review

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | before |
| **Condition** | multi-agent task involving 2+ agents modifying shared systems |
| **Facilitator** | lead |
| **Participants** | all-relevant |
| **Time budget** | focused |
| **Enabled** | ✅ yes |

**Agenda:**
1. Review the task and requirements
2. Agree on interfaces and contracts between components
3. Identify risks and edge cases
4. Assign action items

**Definition-of-done template (issue #98):**
Issue #85's Definition of done named a "Known limitations" section of
`docs/security-report.md` that did not exist anywhere in the repository -- a
bullet naming a missing artifact cannot be executed and cannot fail either.
Only 2 of the last 16 closed issues (13%) carried a Definition of done at all
(#84, #85), so a before-work resolution *step* added to this ceremony would
fire on almost nothing; the actual defect is vagueness at authoring time, not
staleness at review time. The fix is this template, applied when a Definition
of done is written, not a new ceremony step:

> Each Definition-of-done bullet must name something that already resolves in
> this repository: a real file path (`docs/security-report.md`), a real
> document section (a heading that exists in that file today), or a real test
> name (one already in `test/`, or named exactly as it will appear once
> added). A bullet that cannot point at any of the three is not done, it is a
> wish -- rewrite it or drop it.

---

## Sprint closing convention (issue #97)
Issue #85 declared two sprints (WS-1, WS-2) and was closed on WS-1 alone; a
human reopened it, not a gate. Only 3 of the last 16 closed issues (19%)
carried a `## Sprints` section at all, and of those only #84 was an ordinary
(non-structural) issue -- a parser, a close-time gate, a script or a CI job
would be built and maintained for almost nothing. No automation, no script, no
workflow. The convention, applied by whoever closes a sprint-bearing issue:

> Before closing an issue that declares `## Sprints`, the closing comment must
> list each sprint ID against the PR number that merged it, e.g.:
> `WS-1: #95, WS-2: #96`. If a sprint has no merged PR yet, say so in the
> comment instead of closing.

---

## Retrospective

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | after |
| **Condition** | build failure, test failure, or reviewer rejection |
| **Facilitator** | lead |
| **Participants** | all-involved |
| **Time budget** | focused |
| **Enabled** | ✅ yes |

**Agenda:**
1. What happened? (facts only)
2. Root cause analysis
3. What should change?
4. Action items for next iteration

**Automatic durable record for a red `Tests` run:**
The condition above ("build failure, test failure ... ") had no mechanism that
actually fired it (issue #100) -- a red run on `main` or `dev` left no trace
once the next push went green. `.github/workflows/retro-action-on-red-tests.yml`
now opens a GitHub Issue labeled `retro-action` automatically whenever the
`Tests` workflow **fails** (not cancels) on a **push** to `main` or `dev` --
never for a pull request, never for a feature branch, and never twice for the
same run (deduped by run id). The issue names the run URL, the branch and the
failing job(s), so nobody has to remember to make one.

Closing that issue is part of THIS ceremony, not a separate step: once the
retrospective for that failure is logged (`.squad/log/` gains a fresh
retrospective entry, so `node scripts/retro-enforcement.js` reports "not
overdue"), close the corresponding `retro-action` issue and say so in the
retrospective log. `scripts/retro-action-closure.js` names, in pure logic
terms, which open `retro-action` issues qualify for that closure -- see its
tests in `test/retro-action-closure-unit.js` for the decision it makes.

---

## Retrospective with Enforcement

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | weekly |
| **Condition** | No *retrospective* log in .squad/log/ within the last 7 days |
| **Facilitator** | lead |
| **Participants** | all |
| **Time budget** | focused |
| **Enabled** | yes |
| **Enforcement check** | `node scripts/retro-enforcement.js` |

**Agenda:**
1. What shipped this week? (closed issues, merged PRs)
2. What did not ship? (open issues, blockers)
3. Root cause on any failures
4. Action items -- each MUST become a GitHub Issue labeled retro-action

**Coordinator integration:**
At round start, run `node scripts/retro-enforcement.js` (zero dependencies,
`scripts/retro-enforcement.js` in this repo -- reads `.squad/log/` directly, no
external skill required). It prints `OVERDUE` and exits 1 when no retrospective
log exists at all, or the newest one is more than 7 days old; otherwise it
prints `not overdue` and exits 0. If overdue, run this ceremony before the work
queue. This is a single, cheap filesystem read -- it does not block or slow
down ordinary work, only decides whether THIS ceremony is due.

**Why GitHub Issues, not markdown:**
Production data: 0% completion across 6 retros using markdown checklists, 100% after switching to GitHub Issues.
