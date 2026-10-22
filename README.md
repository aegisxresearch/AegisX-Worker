# AegisX-Worker

**A 3D virtual office where AI workers are visible characters.** Every agent is a
real model call against an OpenAI-compatible endpoint you control — you bring the
key, the office runs the show.

![AegisX-Worker: eleven workers at their desks, the task board on the right, the activity timeline at the bottom](docs/preview.png)

*Eleven workers on one isometric floor. The board on the right is the source of
truth: a card is `todo`, `doing`, `blocked` or `done`, and the worker you watch is
the one being billed for it.*

A **team mission** turns one sentence into their work: the lead splits the brief,
hands each part to the specialist whose role fits, the parts run in parallel, and
the lead is re-run once they settle to reconcile the result before the mission is
marked done. Nothing is claimed done because a worker said so — a check, an
independent reviewer and a merge gate stand in front of the board.

- **You bring the model.** Any OpenAI-compatible endpoint; the key lives in server
  memory for the session and never reaches the browser or the disk.
- **You keep the folder.** Every file, shell and preview tool is jailed to the
  folder you pick, with a path guard, a command allowlist and a `bwrap` sandbox.
- **You can audit it.** The prompts are readable (`GET /api/playbook`), every
  decision is a log line, and the checks that guard the workers are part of the
  suite you can run yourself.

## Contents

| Section | What is inside |
| --- | --- |
| [What it does](#what-it-does) | The capabilities, one line each, with the check behind it |
| [The playbook, on screen](#the-playbook-on-screen) | What each worker is told, and what the reviewer refuses |
| [Requirements](#requirements) · [Run it](#run-it) | From `git clone` to a worker writing in your folder |
| [Configuration](#configuration) | Every environment variable and what it changes |
| [Architecture](#architecture) | The file map, the completion gate, isolation, two languages |
| [Verification](#verification) | The checks, what they cost, and what they cannot prove |
| [Security notes](#security-notes) | The trust boundary, stated plainly |
| [Roadmap](#roadmap) | Done, in progress, and what is deliberately not here |
| [License](#license) | MIT — use it, fork it, ship it |

## What it does

- **Live 3D office** — isometric low-poly floor with desks, monitors, plants,
  a meeting table, a coffee corner and a whiteboard. The eleven seeded workers
  spawn at their desks, sit down facing the monitor, type and react.
- **Status on the avatar** — `idle`, `working`, `blocked`, `error`, `meeting`
  are shown in the scene (posture + colour) and on the roster.
- **Chat from inside the office** — pick a worker, talk to them, watch the
  answer stream in. They keep working on their task while you chat.
- **Task board** — create, assign and prioritise work. The assigned worker
  picks it up automatically and can delegate to a colleague.
- **One prompt, a whole team** — tick **Team** (or pass `--team`) and the lead
  plans, delegates to several specialists at once, and reconciles their output.
  Subtasks are capped and de-duplicated, a lead that stops to wait is not marked
  blocked, and a mission that never converges is blocked with a reason instead
  of hanging forever.
- **Quick-start missions** — five chips above the board (*Build an app*,
  *Build a website*, *Fix a bug*, *Write docs*, *Audit the code*) fill in a real
  brief and pick the worker whose role fits, so nobody has to write a prompt
  from scratch.
- **A playbook, not a vibe** — every worker runs under a named role pack: the
  craft bar for that role, what counts as done, and what the independent
  reviewer refuses. A shared team doctrine sits above it — briefing a teammate
  as prompt engineering, evidence over assertion, small steps, contract at the
  handoff. Both are the text the model really receives, readable in the
  **Playbook** tab and at `GET /api/playbook`, not a paraphrase of it. A pack is
  chosen by the lead (`role_pack`), by the worker's role, or — for a generic
  role — by what the brief is about, so a migration handed to an engineer is
  still judged as data work. The guess is weighted, not first-match: a file the
  brief names (`.sql`, `.tsx`) outweighs any number of keywords, and two words
  in one signal outweigh one. The card shows the playbook a task runs under and
  who chose it, the activity log records the evidence, and the Playbook tab
  ranks the refusals each pack has earned together with the rule the reviewer
  cited — so a rule that is vague is found from the board instead of argued
  about.
- **The brief is judged before the task exists** — `create_task` refuses a
  delegation that names no file, command, endpoint or explicit read-only scope,
  and says exactly what to add. A thin but usable brief is accepted with one
  advisory line (no acceptance test / no boundary). The lead sees the refusal in
  the tool result and fixes the handoff instead of the worker guessing.
- **The worker has to prove it** — `complete_task` is not taken at its word. The
  server runs the folder's own checks first (`tsc --noEmit`, `npm test`,
  `npm run build`, `go vet`, `pytest`, and a link check on any `index.html`). If
  a check fails, the task is reopened with the error text and the worker keeps
  going. It is only marked done when the checks pass or the repair attempts run
  out — and an unfixed failure is recorded on the task, never hidden.
- **The folder remembers** — a finished task leaves durable facts behind (the
  `remember` lines the worker chose plus the checks the folder really has). The
  next mission starts with them in its prompt instead of re-discovering the
  same thing, and the file is plain Markdown you can edit. See *The folder
  remembers* below.
- **Checkpoint + diff** — before the first action the folder gets a git baseline
  (only when it is not already a repo, so your own history is never touched),
  and the closing note lists exactly what changed.
- **Windowed reads, tolerant edits** — `read_file` pages through long files
  with `offset`/`limit` instead of flooding the context, and `edit_file` still
  applies when only indentation or trailing whitespace drifted.
- **Sees the page it built** — `preview_screenshot` renders the HTML in headless
  Chrome at any width and saves a PNG, so a web mission can be judged on the
  real layout instead of a guess.
- **Follow camera** — lock the camera to one worker and watch the desk.
- **Activity timeline** — every model call, action, file write and command is
  logged in the UI and streamed to the browser over SSE.
- **Full agent toolkit** — read/write/edit/append/delete files, list folders,
  search file contents, apply unified patches, find a symbol's definition and
  its call sites, run the folder's own check, run allowlisted shell commands,
  send HTTP requests, search the web and fetch pages. Tools are called through
  native OpenAI function calling, with the legacy JSON-action protocol kept as
  a fallback for endpoints that reject `tools`.
- **One gate in front of every tool** — `server/src/policy.ts` decides allow /
  review / deny before the tool runs (path containment, secret files, provenance
  after a web read, token budget, process cap, publishing), and every
  observation passes through `server/src/redact.ts` so a key cannot become model
  context.
- **Tasks that wait on each other** — `create_task` takes `depends_on`; the
  scheduler queues the task and wakes it when its last dependency is done, so a
  lead declares the order once instead of serialising the team by hand.
- **A phase router** — a worker is sent the tools for the phase it is in
  (inspect → edit → verify → wrap), not all 29 every round: 56% fewer schema
  tokens on a measured 12-round mission.
- **An independent reviewer** — after the checks pass, a second model call reads
  the diff and can refuse the change, sending the worker back with the reasons.
  In a repository the diff comes from the task's own checkout, so review runs
  there too instead of approving everything the operator happened to version.
- **Images the model can see** — `read_media` attaches a PNG/JPEG/WebP as a
  content part, so a screenshot or a design reference is evidence, not a path.
- **A visual critic** — after the checks and the code review, an independent
  pass looks at the screenshot the task left behind and can refuse a page that
  works but looks broken.
- **Writes that cannot silently collide** — a per-file lock is held for the
  duration of a mutating call, so two workers editing `app.ts` get one write and
  one retryable `path_locked`, never a last-writer-wins surprise. A write based
  on a stale read is refused with `stale_read` until the file is read again, and
  a shell command takes a folder-wide lock so it cannot run against a file
  another worker is rewriting.
- **A merge gate** — the files a task verified are hashed, and the completion
  re-checks them after the reviewer and critic have looked; if another worker
  changed them in between, the task is sent back instead of claiming a green
  tree that no longer exists.
- **A checkout per task** — when the folder is a git repository the operator
  owns, every task works in its own worktree built from `HEAD` plus the files
  that are not committed yet, so two workers editing one file cannot erase each
  other. The work lands through the merge queue only after the checks pass: a
  file someone else changed meanwhile is refused by name, the worker's copy is
  refreshed to the current text, and its earlier version is kept for reference.
  Office-owned files (screenshots, shadow-repo state) never land: they belong
  to the office, not to the task. A folder that is not a repository — or one the
  office created for its own checkpoints — runs shared, with one line in the log
  saying why. Checkouts of blocked tasks are kept, then reclaimed by age and by
  a cap at the next run, never one belonging to a running task.
- **Guarded observations** — every tool result is validated before it becomes
  model context: an empty summary, an unknown `next_actions` entry or an
  unknown error code is fixed or logged, never passed through.
- **Per-tool result contracts** — shape is not enough, so each tool declares
  what a *success* owes the model: `read_file` must carry the file's text,
  `read_media` must attach the image, a write must name its artifact, and
  `complete_task` must end the turn. A call that reports success without its
  payload is rejected and shown to the model as a failure, not as evidence.
  `check:outputs` proves both halves and runs real tool calls — reads, writes,
  listings, a patch, a command, a failed fetch — against their contracts.
- **Arguments checked against the tool's own schema** — a mistyped enum is
  refused with the accepted values instead of being coerced to a default and
  reported as success.
- **Pick any workspace folder** — the header shows the folder agents work in;
  **Settings → Browse…** walks the filesystem and hands the run over to the
  folder you choose. The choice survives a restart.
- **Bring your own key** — paste an API key in Settings; it is kept in server
  memory for the session and never written to disk or sent to the browser.
- **Free model by default** — `deepseek/deepseek-v4-1-flash` (free tier) is the
  default model, and the office automatically falls back to it when the model
  you selected runs out of credit or is not exposed by the endpoint.

## The playbook, on screen

![The Playbook tab: the team doctrine, then one card per role pack with its craft bar and the rules the reviewer refuses](docs/preview-playbook.png)

*The Playbook tab is not documentation about the prompts — it is the text each
worker receives, read from the same source the server sends to the model.*

Each role runs under a **pack**: the craft bar for that role, the evidence that
closes a task, and the failure the independent reviewer should refuse. Above
them sits one shared **team doctrine** — briefing a teammate as prompt
engineering, evidence over assertion, small steps, contract at the handoff — so
the prefix every worker pays for is identical and cacheable.

A pack is chosen in three steps, and the choice is visible rather than buried in
a prompt:

1. the lead names one (`role_pack` on `create_task`) — the one explicit override;
2. otherwise the worker's job title decides;
3. for a generic role, the brief decides — **weighted**, not first-match: a file
   the task names (`.sql`, `.tsx`, `Dockerfile`) is worth three points, a word
   about the work one point, and a second distinct word one more. An artefact
   beats any pair of adjectives; two words beat one; a tie is named instead of
   hidden.

The card shows the playbook (`Frontend Engineer playbook`) and who chose it, the
activity log records the evidence (`the brief points there (site/index.html)`),
and the reviewer is told the same field — so the bar the work was judged against
cannot drift from the bar the card claims. When the reviewer refuses, the
refusal is kept as data: the Playbook tab ranks refusals per pack and names the
rule the reviewer cited most, which is how a vague line gets found and rewritten
from evidence instead of taste.

## Requirements

- Node.js >= 22.6 (uses native TypeScript execution)
- Chrome/Chromium for the 3D scene (WebGL)

## Run it

```bash
npm install
cp .env.example .env      # paste your key here
npm link                  # makes the `aegisxworker` command available
```

### From any folder — `aegisxworker`

The command you will actually use. `cd` into the project you want to work on and
type `aegisxworker`: that folder becomes the workspace, the office boots, the
browser opens, and every file/shell/preview tool runs inside it.

```bash
cd ~/projects/my-site
aegisxworker                       # open the office in this folder
```

Give it a mission and it works while you watch:

```bash
aegisxworker "build a landing page for a specialty coffee shop"
```

The CLI prints a timestamped log of every action (`write_file`, `read_file`,
`web_search`, …), the worker's notes, and the final result, then shuts the
server down. Add `--keep` to leave the office open afterwards.

```bash
aegisxworker --team "build a booking app with an AI assistant"
aegisxworker -C ~/projects/api "add a /health endpoint and a test"
aegisxworker --agent Bimo "fix the broken mobile nav"
aegisxworker --demo "try the office without burning credit"
aegisxworker --no-open          # start it without touching the browser
```

`--team` routes the brief through the lead and the whole roster; `--solo` forces
one worker. Without either flag the CLI decides: a brief that spans two
disciplines (say UI **and** API, or an app **with** an AI assistant) goes to the
team, everything else to a single specialist.

Options: `-C/--dir`, `-p/--port` (auto-bumps when busy), `--team`, `--solo`,
`--agent`, `-k/--key`, `--endpoint`, `-m/--model`, `--demo`, `--no-tools`,
`--no-web`, `--no-open`, `--keep`, `-t/--timeout` (minutes, default 20 — or 30
for a team mission), `-v/--verbose`, `-h`.

### Recipe: a website from an empty folder

```bash
mkdir my-landing && cd my-landing
aegisxworker "build a landing page for a specialty coffee shop named Kopi Senja"
```

1. The CLI builds the UI if sources changed, picks a port and starts the server
   with `OFFICE_WORKSPACE` set to the folder you are standing in.
2. It connects to the endpoint in `.env`, creates the task on the board and
   assigns it to the worker whose role matches the mission (a web mission goes
   to the frontend engineer; `--agent` overrides the choice).
3. The worker lists the folder, writes `index.html`, `styles.css` and
   `script.js`, reads them back, and only then calls `complete_task`.
4. You get a runnable static site — no build step, no `npm install`. Open
   `index.html` or serve it with `python3 -m http.server`.

The mission brief itself carries the delivery contract (semantic HTML, real
copy, inline SVG favicon, responsive layout, no placeholders), so the result is
a finished page rather than a skeleton.

### Dev server and production build

```bash
npm run dev               # API on :8787, client on :5173
```

Open <http://127.0.0.1:5173>, click **Settings**, paste your API key, press
**Connect**. Without a key the office still runs in demo mode with scripted
workers, so you can try the 3D scene immediately.

Production-ish build (one process serves the API and the built client):

```bash
npm run build
npm start                  # http://127.0.0.1:8787
```

## Configuration

| Variable                | Default                             | Meaning                                          |
| ----------------------- | ----------------------------------- | ------------------------------------------------ |
| `OFFICE_ENDPOINT`       | `https://ai.sinarcloud.com/v1`      | Any OpenAI-compatible base URL                   |
| `OFFICE_API_KEY`        | —                                   | Key for the endpoint (in-memory only)            |
| `OFFICE_MODEL`          | `deepseek/deepseek-v4-1-flash`      | Model id for the workers (free tier by default)  |
| `OFFICE_TOOLS`          | `0`                                 | `1` enables sandboxed file/shell tools at boot   |
| `OFFICE_PORT`           | `8787`                              | API port                                          |
| `OFFICE_CLIENT_ORIGIN`  | `http://127.0.0.1:5173`             | Allowed browser origin in dev                    |
| `OFFICE_WORKSPACE`      | `workspace`                         | Default workspace folder (overridable in the UI) |
| `OFFICE_STATE_DIR`      | `.agent-office`                     | Where the mission board is saved across restarts |
| `OFFICE_MAX_ROUNDS`     | `40`                                | Model/tool round trips allowed per turn          |
| `OFFICE_TOKEN_BUDGET`   | `400000`                            | Token ceiling per turn; the loop stops cleanly   |
| `OFFICE_VERIFY`         | `1`                                 | `0` disables the completion gate                 |
| `OFFICE_VERIFY_ATTEMPTS`| `2`                                 | Repair attempts before a failing check is recorded|
| `OFFICE_LOCALE`         | `en`                                | Language the team writes in until a browser overrides |
| `OFFICE_GIT`            | `1`                                 | `0` disables automatic checkpoints               |
| `OFFICE_JAIL`           | `1`                                 | `0` runs shell tools without the bwrap sandbox   |
| `OFFICE_JAIL_NET`       | `0`                                 | `1` gives `run_command` network access           |
| `CHROME_PATH`           | auto-detected                       | Browser used by `preview_screenshot`             |
| `TAVILY_API_KEY`        | —                                   | Optional: higher-quality web search              |
| `BRAVE_API_KEY`         | —                                   | Optional: web search fallback                    |
| `SERPER_API_KEY`        | —                                   | Optional: web search fallback                    |

The model, the workspace folder and both tool switches can also be changed at
runtime in **Settings**; the free model stays pinned at the top of the list.

Web search needs no key: it goes through DuckDuckGo's HTML endpoint and falls
back to Bing RSS. Set one of the search keys above if you want the steadier,
paid API results.

## Roadmap

`docs/ROADMAP.md` tracks what is done and what is next — the phase router, the
independent reviewer, the policy gate, multimodal input, a checkout per task and
the three-tier memory each carry the check that proves them, and the plan
sections list the remaining work with its acceptance criteria.

The documentation is checked like code: `npm run check:docs` compares the file
map above with what is on disk in both directions, and refuses an evidence row
that names a `check:…` which does not exist or is not part of `npm run check`.

## Architecture

```
client/          Vite + TypeScript + Three.js
  src/main.ts    bootstrap: store wiring, SSE subscription, scene mount
  src/styles.css design tokens, layout and component styles
  src/scene/     office room, characters, camera, status animation
  src/ui/        roster, task board, chat, activity log, costs, playbook, settings
  src/core/      client store + HTTP/SSE transport
server/          Node + Express (native TS execution)
  src/index.ts   server bootstrap: express app, static client, listen
  src/config.ts  env-derived settings, resolved once per process
  src/events.ts  in-process event bus behind the SSE stream
  src/llm.ts     OpenAI-compatible chat, streaming and tool calls
  src/agentRuntime.ts   agent loop: model → tool call → observation → model
  src/toolSchemas.ts    JSON schemas advertised to the model
  src/tools.ts   office actions + file/command tools (allowlist + path jail)
  src/policy.ts  one allow/review/deny decision in front of every tool
  src/redact.ts  masks secret-shaped values before they reach the model
  src/patch.ts   unified diff: atomic, context-matched, dry-run
  src/codeMap.ts symbol index behind search_symbol / find_references
  src/taskGraph.ts  dependency waves and "what is ready now"
  src/router.ts  phase → tool slice, and the token cost it saves
  src/reviewer.ts independent diff review: prompt, strict parser, one call
  src/rolePacks.ts  team doctrine + per-role playbook behind the system prompt
  src/brief.ts   the delegation gate: a brief names a file, a check or a boundary
  src/visionCritic.ts  screenshot → verdict, same strict contract
  src/argGuard.ts      tool args validated against the schema the model saw
  src/fileLocks.ts     per-path write lock, folder lock for commands
  src/readTracker.ts   read hashes: refuse a write based on a stale read
  src/mergeQueue.ts    serialised completion + verified-file hash gate
  src/worktrees.ts     per-task git checkout: baseline, landing, conflicts
  src/outputGuard.ts   observation shape checked before the model sees it
  src/resultSchemas.ts per-tool result contract: what a success owes the model
  src/shell.ts   mini shell: parses pipes/redirects/chains, runs argv arrays
  src/jail.ts    bubblewrap sandbox: namespaces, read-only toolchain, rw workspace
  src/processes.ts      managed dev servers: start, logs, port, stop
  src/httpCheck.ts      page + asset check: status, expected text, broken links
  src/verify.ts  completion gate: plan capture, check runner, asset check
  src/scratch.ts scratch-file scan the completion gate uses for housekeeping
  src/git.ts     workspace checkpoints and change summaries
  src/preview.ts headless Chrome screenshots of a rendered page
  src/workspace.ts      workspace root picker, path containment, persistence
  src/web.ts     keyless/paid web search + SSRF-guarded page fetch
  src/store.ts   office state, sessions, tasks, logs
  src/persistence.ts    mission board on disk: debounced atomic writes, restore
  src/projectMemory.ts  what the workers learned about a folder, injected next mission
  src/snapshots.ts      per-turn shadow-repo snapshots, revert and regression restore
  src/routes/    REST + SSE endpoints
shared/          tables and types both bundles import
  types.ts      domain types shared by the server and the browser
  packs.ts      pack names on the board, the reason a task runs under one
  i18n.ts       english/indonesian dictionary behind `t()`
  wording.ts    activity-log templates, one per log kind
  failures.ts   failure reasons, their labels and the drill-down summary
  usage.ts      spend arithmetic behind the token meter
shared/usage.ts  token-meter math: mission roll-up and the office summary
shared/failures.ts  the failure ledger: cause codes, labels, next steps, ranking
shared/i18n.ts   the English/Indonesian dictionary and its typed lookup
shared/wording.ts  redraws the English activity log and task notes in the operator's language
client/src/core/locale.ts  language boot, persistence and DOM translation
evals/tasks.mjs  sixteen eval missions with fixtures and acceptance tests
evals/playbook.mjs  one mission per role pack, each with a good and a bad yardstick
```

### The completion gate

A task is only `done` when the folder's own tooling agrees. When a task starts,
the server snapshots which checks apply (a `tsconfig.json` with a local `tsc`, a
real `npm test`, `npm run build`, `go.mod`, `pytest`) — snapshotting up front
means a script the worker writes mid-task can never enter the gate. On
`complete_task` the checks run **before** the task is marked done, so the UI and
the CLI never report success while a check is still running. A failure reopens
the task with the error tail attached; after `OFFICE_VERIFY_ATTEMPTS` the work is
accepted but stamped with the unfixed failure. A page that links to a stylesheet
it never wrote is caught by the asset check even when the folder has no tooling
at all.

The gate also checks housekeeping. A completion that leaves probe scripts in the
folder (`probe-*`, `qa-*`, `tmp-*`, `verify-*`, `*.log`, `*.pid`, `*.bak`,
`out.txt`) is sent back with the list, twice at most; after that the work is
accepted and the leftovers are recorded in the task notes. The server never
deletes anything itself — only the worker knows which file was its own scrap —
and the name rule lives in `server/src/scratch.ts`, not in prose.

Workers are told to check a page the way a careful engineer would:
`preview_screenshot` for the render, and `http_check` for the status, the copy
and every same-origin asset. The sandbox has no `curl` — the refusal points at
`http_check` instead — and hunting the filesystem for a Chrome binary is ruled
out in the prompt by name, because that search is what burned a 40-round turn.

Checkpoints use git only when the folder is not a repository yet (`git init` plus
one baseline commit, with `node_modules`, `dist` and `.agent-office` excluded via
`.git/info/exclude`). A folder that already belongs to a repo is left untouched
and the log says so.

The agent loop is the core: the model answers with native tool calls
(`read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`,
`run_command`, `web_search`, `web_fetch`, plus the office actions `move_to`,
`set_status`, `add_note`, `create_task`, `complete_task`), the server runs each
one and returns a structured observation (`status`, `summary`, `detail`,
`next_actions`, `artifacts`). `detail` is the payload the summary points at —
file contents, command output, the gate's file list — and is sent on both the
native tool-call path and the JSON fallback. `MAX_ACTION_ROUNDS` (40) bounds
each turn, and a spent budget gets one closing turn so a task is never left in
limbo.

### Undo a turn

Every turn starts with a snapshot of the workspace, taken into a *shadow* bare
repo under `.agent-office/snapshots/` (one per workspace, keyed by folder path).
Nothing is committed into the operator's repository, and a folder that is not a
repo at all still gets an undo. `node_modules`, `dist`, `.next`, `__pycache__`,
`.venv`, `*.log` and the office's own state are excluded.

The worker can call `revert_turn` when its own edits made things worse: the
folder goes back to the tree the turn started from, files it created are
removed, and the observation lists what was restored. Two details make that a
real undo rather than a cosmetic one: the current state is committed to the
shadow repo first, so files created during the turn are tracked and therefore
deleted by the reset, and writes are serialised per workspace, so two workers
finishing at once cannot corrupt the index.

The completion gate uses the same machinery against regressions. When a task's
checks pass, that tree is marked green. If a later turn makes a check that used
to pass fail, the folder is restored to the last green tree *before* the repair
attempt, and the reopened task is told its recent edits are gone. Two guards
keep that from doing damage: a revert only fires for a check that previously
passed, and it is skipped entirely while another task is writing in the same
folder.

### A bad turn does not end the mission

A turn can fail in ways that say nothing about the work: the model answers in
prose, the endpoint returns a 500, the socket resets. Every one of those used to
land in `blocked`, which is terminal — only a human pressing Start continues it.

Three rules now stand between a bad moment and a dead task:

- **A prose answer is nudged, not punished.** If a worker ends a turn without
  `complete_task` and without handing the work to a teammate, it gets one
  message in the same conversation asking it to finish or hand off. Only a
  second silent stop blocks the task.
- **A transient failure is retried once.** 5xx, 408, timeouts and reset sockets
  repeat the same call; a 4xx does not, because repeating it would spend tokens
  on the same answer. The partial reply is discarded and files already written
  stay put.
- **A failed turn is still billed.** Usage is written in `finally`, so a turn
  that dies after two rounds appears in the meter for what it actually cost
  instead of nothing.

What still blocks, deliberately: a restart (nothing is alive to continue), an
error that survives the retry, a mission the lead never reconciles, and a spent
budget.

### Mission budget

`OFFICE_MISSION_TOKEN_BUDGET` caps what one mission may spend — the lead plus
every subtask, checked before each model round. At the cap the task is blocked
with a note naming the numbers, so an office left running cannot spend without
limit. `0` (the default) means no cap. It is a token cap rather than a currency
one because the office cannot know what an endpoint charges.

When a folder has no test to run, the gate asks once for evidence: if the turn
changed nothing and ran no command, the completion is sent back asking for the
change or for a note explaining why none was needed. It does not judge quality;
it rules out "done" with no work at all, which is the failure a folder without
checks cannot catch.

### Two languages

The interface ships in English and Indonesian, chosen in Settings and restored
on the next visit. `?lang=id` forces a language for a shared link, and the
choice lives in `localStorage` — it is a display preference, not office state.

`shared/i18n.ts` holds both columns; `MessageKey` is derived from that table, so
a typo is a compile error rather than an English word on an Indonesian screen.

Agent prompts stay English on purpose — they are instructions to a model, not
text for a person. The activity log stays English *on the server* for the same
kind of reason: the checks and scripts in this repo match on its exact wording,
and a log line is evidence. The browser still reads it in Indonesian, because
`shared/wording.ts` recognises each line by the `kind` it was filed under plus
the shape of its arguments and redraws it from the dictionary. A line nobody
recognises is shown exactly as written, never mangled, and `check:wording` fails
until the table catches up.

Task notes work the same way for the three notes the office writes itself (a
restart, the evidence gate, a checkpoint diff).

A note an agent authored is different: it is the agent's own words, so it is
shown as written — and it is written in the language the operator reads. The
browser tells the server which language that is (`POST /api/session/locale`),
and the office puts one paragraph into the agent's system prompt: write notes,
`complete_task` summaries and replies in Indonesian; leave code, file names,
paths and commands exactly as they are. The setting is persisted with the rest
of the office state, so a mission started from a script or the CLI writes in
`OFFICE_LOCALE` (default `en`) until a browser says otherwise. The instruction
is about prose only — the work, the tools and the checks are unchanged.

Two tabs in different languages is one office: the last one to send its choice
sets the language for the whole team. Demo mode's scripted lines stay English —
they are fixtures, not model output.

```bash
npm run check:i18n      # keys used vs. keys defined, both columns filled, none dead
npm run check:wording   # every log kind translated; the table matches the server
npm run check:language  # the prompt really carries the chosen language, and persists
```

The page itself is checked in a real browser — the built app is loaded with
`?lang=id` and `?lang=en` and the rendered labels are read back. It needs Chrome
and a build, so it is a separate command:

```bash
npm run build && npm run check:i18n:browser
```

### Token meter

Every model turn is booked against the worker that ran it and against the task
it worked on, in one place (`OfficeStore.recordUsage`) so the roster and the
board can never disagree. A card shows its own spend; a mission card shows the
lead plus every subtask rolled up, and the expanded card breaks that down per
worker. The topbar pill is the office total — the sum of the roster, with the
prompt/completion split and the busiest workers in its tooltip.

Nothing is estimated: the numbers come from the endpoint's own `usage` block
(`prompt_tokens` / `completion_tokens`). A turn that never reported usage is not
counted, and demo turns are counted from their scripted length so the meter
still moves without a key. `GET /api/usage` returns the same data for scripts:

```bash
curl -s localhost:8787/api/usage | jq '.total, .agents[0], .missions[0]'
```

Each step of a turn is in the activity log with its own bill: one line per model
round trip (`Nadia · step 2 · create_task — 140 tok`). The round is the smallest
unit an endpoint prices, so several tool calls inside one round share that number
instead of each pretending to own it, and the step lines add up to exactly what
the task reports. The costliest step on screen carries a `top cost` flag.

The bottom panel has two tabs. **Activity** is the live log; **Costs** is the cost
history — finished missions grouped by the day they finished, each with its
rolled-up total, plus the day's total in the header. The topbar token pill opens
it directly, and the panel widens while it is showing so the table fits. It
reads `GET /api/usage/history`, so a script sees the same numbers: `days[]`
(newest first, `YYYY-MM-DD` in local time) and `missions[]`.

Run its checks with `npm run check:usage` (roll-up math, the history buckets, a
live demo mission, and a mocked model that proves per-step billing adds up).

### The folder remembers

A worker that finishes a task can leave behind what it learned. `complete_task`
takes an optional `remember` list — the command that builds the project, where
the styles live, the gotcha that cost it twenty minutes — and the server adds
what it can see for itself: the checks the folder actually has.

Those facts are written to `<workspace>/.agent-office/knowledge.md` in plain
Markdown, one line each, newest first, deduplicated, capped at 60. Every later
turn reads that file fresh and puts it in the system prompt under **Project
memory**, capped at 2,000 characters, so mission B does not re-discover what
mission A already paid for. Editing or deleting a line by hand is expected; a
line that no longer parses is simply ignored.

The write happens **before** the task flips to `done`. That ordering matters:
the CLI exits when the mission is done, and a write still in flight would be
lost — the board would say finished while the lesson vanished.

```bash
npm run check:memory   # format, dedup, cap, concurrent writers, A → B round trip
```

### Prove it: the eval suite

Sixteen missions, each in a throwaway folder, each with an acceptance test the
worker never sees. A task passes when that test passes — not when the office says so.

```bash
npm run eval                        # real model, from .env or OFFICE_ENDPOINT / OFFICE_API_KEY
npm run eval -- --baseline <file>   # compare two runs
npm run eval -- --only css-tokens,receipt
npm run eval -- --task-timeout 600000   # give a slow model longer per task
npm run check:eval                  # scripted model: tests the harness itself
```

The key comes from `.env` (the same file the launcher hands the server) or from
the environment, with an exported value winning. Per task the report records
pass/fail and the reason, the time from handing the task over to the board
showing it finished, the tokens the server attributed to
the task and its subtasks, and the cost those tokens imply. Tokens are measured;
dollars are `tokens × rate`, with the rate an explicit input (`--price-in` /
`--price-out`, or `EVAL_PRICE_IN` / `EVAL_PRICE_OUT`, $0.15 / $0.60 per million
by default) and stored in the report so two runs stay comparable.

Reports land in `.agent-office/evals/<mode>-<stamp>.json`. With `--baseline`
the run prints the per-task verdict change (`FIXED` / `BROKEN` / `same`) plus the
deltas in pass rate, cost and time — which is what turns "this feels better"
into a number. `--min-pass-rate 0.8` makes a run usable as a gate.

The sixteen tasks cover a bug fix with frozen tests, a new module, a rename
across files, CSS custom properties, an accessible form, deleting a module, a
test suite that must actually catch a bug, a broken npm script, money
formatting across two files, one mission that is already correct — where the
right answer is to change nothing — and one **team handoff**: the lead must
create a subtask for the frontend engineer, stop instead of claiming the
mission, and reconcile once she reports. That last one checks the board too:
the subtask has to be assigned to Aria, finish, and its spend has to appear in
the mission's rolled-up total.

Five of them exist to pin the recovery rules below: a worker that answers in
prose is nudged into finishing, a 500 is retried once, a turn that dies mid-way
still reports its spend, a mission budget stops the run with a note, and a
"done" in an untested folder with nothing changed is asked for evidence. Two of
those legitimately end **blocked**, and the report says so.

Acceptance is independent of the worker: the test-suite task copies the folder,
stubs `parseList` to `[]` and requires the new tests to fail.

Before each task the harness checks that the office is working in the folder it
just created and refuses to start otherwise, so an eval on a machine whose owner
has already picked a real project can never write there.

`npm run check:eval` runs the same sixteen against a scripted model in which
three plans are wrong on purpose (the colours are moved into `:root` but the
rule still hard-codes them, the new test only covers the empty case, and working
code is rewritten for no reason). It asserts the office reported every task
`done` while the acceptance checks still failed those three — the evidence that
the harness measures the work rather than the office's self-report — and that
the delegated mission's total includes both workers' turns.

### Missions survive a restart

The board, the roster and recent history are written to
`.agent-office/office-state.json` shortly after every change — debounced, so a
streaming turn does not rewrite the file per token — and flushed on `SIGINT` /
`SIGTERM`. Each write goes to a temp file first and is renamed into place, so
a kill during a write leaves the previous good file rather than half of one.
On boot the office restores that file instead of seeding a fresh board.

What comes back is honest rather than optimistic:

- tasks, notes, assignees, the token meter and the activity log are restored;
- a worker's identity (id, name, desk) is restored, so assignments still point
  at the same people — the roster is never re-seeded on top of it;
- a task that was `doing` when the process died is marked **blocked** with a
  note saying the office restarted. Nothing survived that could finish it, and
  no model call is re-run (or billed) silently: press **Start** to continue from
  the notes that were kept;
- an unreadable or foreign state file is moved to
  `office-state.json.corrupt-<timestamp>` and the office boots clean instead of
  dying on it.

Open tasks are always kept; finished ones are capped at the newest 300, together
with any mission they belong to, so the file cannot grow without bound. The API
key is never written. `npm run check:restore` proves the whole thing by killing
a live server with `SIGKILL` and asserting the board returns.

### API

| Method | Path                   | Purpose                                  |
| ------ | ---------------------- | ---------------------------------------- |
| GET    | `/api/session`         | Full snapshot (settings, agents, tasks, meter) |
| GET    | `/api/usage`           | Token meter: total, per worker, per mission |
| GET    | `/api/usage/history`   | Finished missions grouped by day, with day totals |
| POST   | `/api/session/connect` | Verify + store endpoint, key and model   |
| POST   | `/api/session/demo`    | Toggle demo mode                         |
| POST   | `/api/session/model`   | Switch model at runtime                  |
| POST   | `/api/session/tools`   | Toggle file/shell tools                  |
| POST   | `/api/session/web`     | Toggle web search + fetch                |
| POST   | `/api/session/workspace` | Set the agents' workspace folder       |
| GET    | `/api/session/workspace/list` | List sub-folders for the folder picker |
| GET    | `/api/agents`          | Agents and their live status             |
| GET    | `/api/playbook`        | Team doctrine and every role pack, verbatim |
| POST   | `/api/agents`          | Hire a new worker                        |
| GET    | `/api/tasks`           | Task board                               |
| POST   | `/api/tasks`           | Create / assign a task                   |
| POST   | `/api/missions`        | One brief → lead plans, team works, lead reconciles |
| POST   | `/api/tasks/:id/run`   | Start a task on an agent                 |
| POST   | `/api/chat`            | Send a message to an agent               |
| GET    | `/api/events`          | SSE stream of every office event         |

## Security notes

- **Never commit a key.** `.env` is git-ignored; `.env.example` is the only
  key-shaped file in the repo.
- **Keys live in server memory only.** They are never written to disk, never
  logged, and never included in an API response — the browser only ever sees a
  masked form (`sk-ab…9f2c`).
- **File tools are jailed to the chosen folder.** Every path is resolved
  against the workspace root, `..` hops and absolute escapes are rejected, and
  symlinks that point outside the root are refused. `delete_file` will not
  remove the root itself.
- **Shell commands are parsed, not handed to `sh -c`.** `server/src/shell.ts`
  understands pipes, `>`/`>>`/`<`, `2>`, `2>&1`, `&>` and `&&`/`||`/`;`, then
  runs each stage as an argv array — so a worker can write the shell it knows
  without opening a command-injection surface. There is no `$VAR` expansion, no
  `$(...)`, no globbing and no background `&`. The binary must be on an
  allowlist (`ls`, `cat`, `grep`, `sed`, `git`, `node`, `npm`, `mkdir`, …), a
  refusal names the tool that replaces it (`curl` → `http_check`, `rm` →
  `delete_file`), and every argument and redirect target is resolved against the
  workspace root: `..` hops, absolute paths outside it and redirects elsewhere
  are refused. Allowlisted interpreters can still reach the filesystem through
  code, so point the workspace at a throwaway folder rather than your home
  directory.
- **Shell tools run inside bubblewrap.** With `bwrap` installed (the default),
  every `run_command` and `start_process` gets its own mount and pid
  namespaces: the workspace is the only writable tree, the toolchain is
  read-only, the operator's home is not mounted at all, and `run_command` has
  no network (`OFFICE_JAIL_NET=1` opts in). `scripts/jail-check.mjs` proves it
  by trying to read `~/.bashrc` and write `/etc` from inside. Without `bwrap`
  the office still runs, logs that commands are not sandboxed, and the
  allowlist plus path guard are the only boundary — the check says so instead
  of pretending.
- **Web access is SSRF-guarded.** Only `http(s)` URLs are fetched, and every
  hop — including redirects — is re-resolved and rejected when it lands on
  loopback, private, link-local or cloud-metadata addresses.
- **The gate runs the project's own scripts.** `npm test` and friends execute
  code from the folder. Only scripts that existed when the task started are
  run, so a script the model writes mid-task cannot enter the gate — but a
  folder whose tests already do something hostile is still hostile. Run
  untrusted projects in a container.
- **The worker writes into your folder.** Besides the deliverables it creates
  `.agent-office/previews/*.png`, and on a folder that was not a repo yet it
  creates `.git` with one baseline commit (excluded: `node_modules`, `dist`,
  `.agent-office`, `*.log`). Nothing else is written outside the workspace.
- **Tools are opt-in.** File/shell and web access are separate switches that
  can be flipped off at any time from Settings.
- **Rotate any key that leaks.** A key pasted into a chat, a screenshot or a
  commit should be considered compromised.

## Verification

```bash
npm run typecheck     # tsc --noEmit for client and server
npm run build         # production client bundle
```

The modules that guard the worker have direct checks that need no model, aimed
at the **failure** paths: a failing check reopens the work with the error tail,
a script the worker writes mid-task cannot enter the captured plan, npm's
placeholder test script is not mistaken for a suite, a page linking a stylesheet
it never wrote is caught, a folder that is already a repo is left untouched, a
`..` hop or an absolute path outside the folder is refused, a fetch at loopback
or the cloud-metadata address is blocked before any request, and a page really
renders to a PNG:

```bash
npm run check:gate    # 19 assertions, ~2 s, no model
```

The token meter and the restart behaviour have their own checks:

```bash
npm run check:usage     # roll-up math, history buckets, a live demo mission,
                        # and a mocked model proving per-step billing adds up
npm run check:restore   # SIGKILL a live server, assert the board returns
```

The per-turn snapshots, `revert_turn` and the regression revert have their own
check, which ends with three real missions against a scripted model: a finished
task leaves a verified tree, the next turn that breaks a check is restored to
that tree instead of repaired on top of the damage, and `revert_turn` removes
what the turn created.

```bash
npm run check:snapshot   # exact restore, ignored paths, parallel turns, live reverts
npm run check:i18n       # both language columns complete and actually used
npm run check:wording    # every log kind and system note has a translation
npm run check:language   # the chosen language reaches the model prompt
npm run check:docs       # the README map and the ROADMAP evidence rows match reality
npm run check:cleanup    # scratch files are refused; the page-check prompt is real
npm run check:failure    # every blocked task carries a cause; the ranking is stable
npm run check:jail       # the sandbox hides the home dir, blocks /etc and the network
npm run check:prompt     # shared prefix cached and inside budget, every role has its pack
npm run check:playbook   # one mission per pack; each yardstick passes a good tree,
                         # refuses a bad one, and the pack choice is weighted
```

The playbook suite scores one mission per role pack against that pack's own
definition of done, and is opt-in because it spends credit:

```bash
npm run eval:playbook              # live: one mission per pack, scored by accept
npm run eval:playbook -- --mock   # the scripted plans, no credit
npm run eval:playbook -- --save evals/playbook-baseline.json      # record a baseline
npm run eval:playbook -- --baseline evals/playbook-baseline.json  # fail on a regression
```

A baseline recorded with `--save` is a measurement, not a claim: `--baseline`
only fails when a mission that passed before fails now. Keep the JSON in the
repo and a run becomes comparable across machines — the per-mission reason and
wall time matter as much as the pass count, because a suite that only remembers
its wins cannot tell you what changed. A live run needs credit and a model that
answers inside the task timeout; the suite is opt-in for that reason.

The eval suite measures the thing all of the above exists for — finished work,
cost and time on sixteen fixed missions — and checks itself:

```bash
npm run eval            # sixteen missions against the real model
npm run check:eval      # the harness, against a scripted model (no credit spent)
```

One command runs all of it, plus the typecheck:

```bash
npm run check
```

Two earlier scripted-model runs proved the loop and the team orchestration end to
end (a worker claiming success while its tests fail is reopened twice and then
accepted with the failure stamped; a stuck repeat is steered once and stopped;
one brief becomes two owned subtasks, both finish, and the lead reconciles
exactly once). Those two runs came from a scratch harness that is **not checked
in**, so they cannot be re-run from this repo yet. The eval suite now covers a
single worker and a delegated team mission; it does not yet cover the reopen
loop or the stuck-repeat steering.

End-to-end behaviour (seated workers, folder picker, web search, sandboxed file
writes, task completion) is exercised in a headless Chromium run against a
built server.

The CLI path is verified on a real model call too: from an empty folder,
`aegisxworker "build a landing page …"` produced `index.html`, `styles.css` and
`script.js`, and the page rendered with zero console errors and no horizontal
overflow at 375 / 768 / 1440 px.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it; keep the copyright and
permission notice with any copy. The name and logo are not part of the grant.

If you run the office against your own endpoint, your model provider's terms
apply to what the workers send and receive; this licence covers the software,
not the model or its output.
