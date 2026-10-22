# Recorded failures

Every file here started as a mission that **blocked**, exported from a real
office state (`npm run failure:export`). Each `*.json` is machine-readable —
brief, notes, the ledger's cause, and the trace around it — and each `*.md` is
the same case as prose, ending with how to make it a regression.

```
npm run failure:export -- --list          # what has been recorded
npm run failure:export                    # newest blocked task
npm run failure:export -- --task task_ab12
```

## Turning one into an eval

An export is evidence, not a test. It becomes a test when a check can fail
again because of it:

1. Build the fixture under `evals/tasks.mjs` from the brief and the files the
   worker started from.
2. Write `accept` so it reads the artefact and runs it — never the worker's own
   summary. The three deliberately-wrong scripted plans in the suite exist to
   prove an `accept` can fail.
3. `npm run check:eval` first (scripted model, no credit), then `npm run eval`.
4. Delete the two exported files once the case is in `evals/tasks.mjs`: the
   suite is the source of truth, and a stale copy is a trap.

## Why the cause matters

`task.failureReason` is one of `no_progress`, `tool_loop`, `budget`,
`model_error`, `restart`, `synthesis_stalled`. The board ranks them
(`GET /api/failures`), so the top row is the thing worth fixing next — export
that one first.
