# Agent Office

A 3D virtual office where AI workers are visible characters. Every agent is a
real model call against an OpenAI-compatible endpoint you control — you bring
the key, the office runs the show.

```
┌────────────────────────────── 3D floor ──────────────────────────────┐
│  Nadia ▸ lead       Aria ▸ frontend      Bimo ▸ backend            │
│  Raka ▸ mobile      Sinta ▸ AI           Yoga ▸ ML                 │
│  Citra ▸ qa         Tari ▸ security      Dimas ▸ data              │
│  Elma ▸ product     Fajar ▸ devops                                  │
│      task board ─┤ chat + roster ┤ activity timeline               │
└──────────────────────────────────────────────────────────────────────┘
```

Eleven workers, and a **team mission** turns one sentence into their work:
the lead splits the brief, hands each part to the specialist whose role fits,
the parts run in parallel, and the lead is re-run once they settle to reconcile
the result before the mission is marked done.

## What it does

- **Live 3D office** — isometric low-poly floor with desks, monitors, plants,
  a meeting table, a coffee corner and a whiteboard. Six seeded workers spawn at
  their desks, sit down facing the monitor, type and react.
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
- **The worker has to prove it** — `complete_task` is not taken at its word. The
  server runs the folder's own checks first (`tsc --noEmit`, `npm test`,
  `npm run build`, `go vet`, `pytest`, and a link check on any `index.html`). If
  a check fails, the task is reopened with the error text and the worker keeps
  going. It is only marked done when the checks pass or the repair attempts run
  out — and an unfixed failure is recorded on the task, never hidden.
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
  search file contents, run allowlisted shell commands, search the web and fetch
  pages. Tools are called through native OpenAI function calling, with the
  legacy JSON-action protocol kept as a fallback for endpoints that reject
  `tools`.
- **Pick any workspace folder** — the header shows the folder agents work in;
  **Settings → Browse…** walks the filesystem and hands the run over to the
  folder you choose. The choice survives a restart.
- **Bring your own key** — paste an API key in Settings; it is kept in server
  memory for the session and never written to disk or sent to the browser.
- **Free model by default** — `deepseek/deepseek-v4-1-flash` (free tier) is the
  default model, and the office automatically falls back to it when the model
  you selected runs out of credit or is not exposed by the endpoint.

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
| `OFFICE_GIT`            | `1`                                 | `0` disables automatic checkpoints               |
| `CHROME_PATH`           | auto-detected                       | Browser used by `preview_screenshot`             |
| `TAVILY_API_KEY`        | —                                   | Optional: higher-quality web search              |
| `BRAVE_API_KEY`         | —                                   | Optional: web search fallback                    |
| `SERPER_API_KEY`        | —                                   | Optional: web search fallback                    |

The model, the workspace folder and both tool switches can also be changed at
runtime in **Settings**; the free model stays pinned at the top of the list.

Web search needs no key: it goes through DuckDuckGo's HTML endpoint and falls
back to Bing RSS. Set one of the search keys above if you want the steadier,
paid API results.

## Architecture

```
client/          Vite + TypeScript + Three.js
  src/scene/     office room, characters, camera, status animation
  src/ui/        roster, task board, chat, activity log, settings
  src/core/      client store + HTTP/SSE transport
server/          Node + Express (native TS execution)
  src/llm.ts     OpenAI-compatible chat, streaming and tool calls
  src/agentRuntime.ts   agent loop: model → tool call → observation → model
  src/toolSchemas.ts    JSON schemas advertised to the model
  src/tools.ts   office actions + file/command tools (allowlist + path jail)
  src/verify.ts  completion gate: plan capture, check runner, asset check
  src/git.ts     workspace checkpoints and change summaries
  src/preview.ts headless Chrome screenshots of a rendered page
  src/workspace.ts      workspace root picker, path containment, persistence
  src/web.ts     keyless/paid web search + SSRF-guarded page fetch
  src/store.ts   office state, sessions, tasks, logs
  src/persistence.ts    mission board on disk: debounced atomic writes, restore
  src/routes/    REST + SSE endpoints
shared/types.ts  domain types shared by both sides
shared/usage.ts  token-meter math: mission roll-up and the office summary
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

Checkpoints use git only when the folder is not a repository yet (`git init` plus
one baseline commit, with `node_modules`, `dist` and `.agent-office` excluded via
`.git/info/exclude`). A folder that already belongs to a repo is left untouched
and the log says so.

The agent loop is the core: the model answers with native tool calls
(`read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`,
`run_command`, `web_search`, `web_fetch`, plus the office actions `move_to`,
`set_status`, `add_note`, `create_task`, `complete_task`), the server runs each
one and returns a structured observation (`status`, `summary`, `next_actions`,
`artifacts`). `MAX_ACTION_ROUNDS` (6) bounds each turn, and a spent budget gets
one closing turn so a task is never left in limbo.

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
- **Shell commands are checked, not fully jailed.** The binary must be on an
  allowlist (`ls`, `cat`, `grep`, `git`, `node`, `npm`, …), chaining
  metacharacters (`&&`, `|`, `;`, backticks, `$(`) are rejected, and absolute
  paths or `..` hops outside the root are refused. Allowlisted interpreters can
  still reach the filesystem through code, so point the workspace at a
  throwaway folder rather than your home directory.
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

One command runs all of it, plus the typecheck:

```bash
npm run check
```

Two scripted-model runs proved the loop and the team orchestration end to end (a
worker claiming success while its tests fail is reopened twice and then accepted
with the failure stamped; a stuck repeat is steered once and stopped; one brief
becomes two owned subtasks, both finish, and the lead reconciles exactly once).
They were run from a scratch harness that is **not checked in**, so they cannot
be re-run from this repo yet — rebuilding them under `scripts/` is the next step.

End-to-end behaviour (seated workers, folder picker, web search, sandboxed file
writes, task completion) is exercised in a headless Chromium run against a
built server.

The CLI path is verified on a real model call too: from an empty folder,
`aegisxworker "build a landing page …"` produced `index.html`, `styles.css` and
`script.js`, and the page rendered with zero console errors and no horizontal
overflow at 375 / 768 / 1440 px.
