# BLAXIN Specialists & Missions

How BLAXIN delegates work, keeps every delegation bounded and honest, and
coordinates multi-step missions across specialists.

Everything in this subsystem reports **real state only**: an objective
exists because a tool really activated, a verification level comes only
from real observed evidence, and a mission is VERIFIED only when every
completed step carried real verification evidence.

## Specialist ownership (bounded objectives)

The first REAL tool activation in a task claims that task's objective as a
**specialist objective** owned by the specialist role derived from the tool
that actually ran (`browser` → BROWSER, `filesystem` → FILES, `terminal` →
TERMINAL, …). One objective per task — budgets cannot be cycled by starting
"new" objectives mid-task.

Each objective carries explicit budgets:

| Budget | Default | Meaning |
|---|---|---|
| `maxActions` | 16 | distinct tool actions the specialist may execute |
| `maxRecoveries` | 8 | deterministic recovery attempts across the objective |
| `maxReplans` | 1 | deterministic re-plans for the objective |
| `deadlineMs` | 300000 | wall-clock deadline from assignment |

**These are user-configurable** in the persisted config
(`blaxin-config.json`, edited via `PUT /api/config` or the settings
surface):

```json
{
  "agent": {
    "specialist": { "maxActions": 16, "maxRecoveries": 8, "maxReplans": 1, "deadlineMs": 300000 },
    "recovery":   { "maxRecoveryAttempts": 2, "maxReplansPerTask": 1, "baseBackoffMs": 300, "maxBackoffMs": 2000 }
  }
}
```

An older config file without these keys back-fills the defaults per key —
a partial edit can never silently drop a budget to `undefined`.

### Honest settlement

A specialist objective settles exactly once, into one of:

- `COMPLETED_VERIFIED` — every completed action carried a real
  verification payload with `status: SUCCESS` (e.g. the browser observed
  the expected URL + title);
- `COMPLETED_UNVERIFIED` — actions completed but nothing was verified
  (e.g. a filesystem listing has no verification payload by design);
- `FAILED` — a real failure, or budget/deadline exhaustion with nothing
  verified;
- `TIMED_OUT` — the wall-clock deadline stopped the loop mid-run;
- `CANCELLED` / `BLOCKED` — the task was cancelled or a confirmation was
  denied.

The rule enforced everywhere downstream: **UNVERIFIED is never upgraded**.
A Jarvis report for an unverified specialist (or an unverified mission) is
capped at PARTIAL — never SUCCESS.

## Mission coordination

`server/src/orchestrator/mission-coordinator.ts` adds coordination on top
of the mission store **without replacing anything**: the store stays the
source of truth for step lifecycle; the coordinator adds:

1. **Evidence attribution** — a real `specialist-assigned` /
   `specialist-result` event is attributed to the mission step whose
   queue task is currently running (execution is strictly serial, so the
   binding is exact). No binding → no attribution; events are never
   guessed onto a step.
2. **Verification aggregation** — `MissionStore.settleStep` stores each
   step's real verification level and recomputes the mission-level value:
   every completed step VERIFIED → mission VERIFIED; some verified →
   PARTIAL; none verified → UNVERIFIED; nothing completed → NONE. This
   lives in the store (persisted, restart-safe) — a single source of
   truth the coordinator, scheduler, HUD and Jarvis all read.
3. **Template expansion** — a step objective may reference earlier
   evidence with `{{evidence:stepId}}`. It resolves ONLY from real
   VERIFIED evidence; unknown or unverified references become explicit
   markers (`{{evidence:stepId — UNVERIFIED}}`), never fabricated values.
4. **Shared context** — later steps receive earlier verified evidence and
   real failed-step results as a bounded prompt block rendered as
   BACKGROUND data (the current instruction always outranks it).
5. **Cancellation propagation** — cancelling a mission cancels its
   queued/running queue tasks, so no specialist objective survives the
   mission's terminal state.

The MISSIONS panel in the HUD shows each mission's real status, progress,
per-step state and the aggregated verification badge
(✓ VERIFIED / ◐ PARTIAL / ◌ UNVERIFIED) — computed on the server from
real evidence, never client-side.

## Where the evidence lives

- `specialist-assigned` / `specialist-result` WS events carry the
  objectiveId, budgets, live usage and the honest verification level;
- the mission journal records `DELEGATED → ACTION → OBSERVATION →
  VERIFICATION → RESULT` per real action, bound to the objectiveId;
- `GET /api/journal` and the Journal page expose the same trail.

See `server/src/__tests__/orchestrator/` (specialist-ownership,
browser-specialist, mission-coordinator suites) for the pinned contract,
and `server/scripts/probe-browser-specialist.mjs` for a real end-to-end
proof against a live Chrome (`BLAXIN_REAL_CHROME=1`).
