# Squad Decisions

## Active Decisions

### 2026-10-09: Squad member models are gpt-6.1-sol, claude-sonnet-5.5 and claude-haiku-5.5

**By:** Brian (owner approval, issue #246), applied by engineer on the direct local owner route.

**What:**
- `gpt-6.1-sol` for the roles that judge rather than execute: lead, advisor, security, rai, fact-checker.
- `claude-sonnet-5.5` for the executors: engineer, reviewer, ralph. It is also `defaultModel` and `modelPolicy.executorModel`.
- `claude-haiku-5.5` for scribe and docs (`modelPolicy.scribeModel`). `modelPolicy.advisorModel` is `gpt-6.1-sol`.
- `.squad/config.json` `agentModelOverrides` keys are the exact lowercase member names (`rai`, `scribe`, `fact-checker`, ...): the same string as the `.squad/agents/<name>/` folder, the casting registry key and the spawn `name`. The key `Rai` is replaced by `rai`; no alias keys are added. `developer` and `devrel` are not members of this team, so they get no keys; documentation is `docs`.
- Every spawn passes the member's model explicitly, including the after-agent Scribe. `.github/agents/squad.agent.md` overrides the model hardcoded in the vendored `.squad/templates/after-agent-reference.md`.
- If a configured model is unavailable, stop and report; never downgrade silently or omit the `model` parameter.

**Why:** The earlier mapping named models that are no longer the approved ones, the mis-cased `Rai` key never matched and fell through to `defaultModel`, and Scribe had no explicit model so its spawn took the template default.

**Supersedes:** the 2026-08-04 model mapping below.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction

## Superseded Decisions

Kept as evidence; none of these apply any more.

### 2026-08-04: Advisor-strategy model mapping (superseded 2026-10-09 by issue #246)

**What:** `claude-opus-5` for advisor, security, Rai and fact-checker; `claude-opus-5.5` for lead; `claude-sonnet-5` for engineer, reviewer and ralph, and as `defaultModel` and executor; `claude-haiku-4.5` for scribe and docs. The agent override for Rai was keyed `Rai`. Model ids were verified against the Copilot CLI on 2026-08-04, when `claude-haiku-5` did not exist.

**Why superseded:** Replaced by the 2026-10-09 decision above.
