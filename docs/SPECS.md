# Spesifikasi teknis: lima pilar berikutnya

Pasangan dari `docs/ROADMAP.md`. Roadmap menjawab **apa dan kenapa**; dokumen ini
menjawab **persis bagaimana** — tipe, nama file, bentuk JSON tool, algoritma, dan
assertion yang harus lulus. Semua nama yang sudah ada di repo dipakai apa adanya
(`buildToolSchemas`, `executeAction`, `ActionResult`, `#executeWithGate`,
`captureVerificationPlan`, `takeSnapshot`) supaya implementasinya menyambung,
bukan menulis ulang.

Aturan dokumen ini: setiap bagian berakhir dengan **Definition of done** yang
berupa file check dan assertion konkret. Kalau sebuah usulan tidak bisa ditulis
sebagai assertion, usulan itu belum siap dikerjakan.

---

## 1. Tool layer

### 1.1 Kontrak hasil (menggantikan `ActionResult` secara bertahap)

`ActionResult` di `server/src/tools.ts` sudah punya `ok`, `summary`, `detail`,
`nextActions`, `artifacts`, `remedy`, `followUp`. Tambahkan dua field dan
pertahankan sisanya agar check yang sudah ada tidak perlu diubah:

```ts
export type ToolErrorCode =
  | 'path_outside'      // argumen/redirect keluar workspace
  | 'binary_refused'    // di luar allowlist
  | 'jail_unavailable'  // sandbox diminta tapi tidak bisa dibuat
  | 'timeout'           // melewati COMMAND_TIMEOUT_MS
  | 'exit_nonzero'      // perintah jalan, keluar != 0
  | 'not_found'         // file/simbol/port tidak ada
  | 'denied_by_policy'  // policy engine menolak
  | 'needs_approval'    // menunggu manusia
  | 'invalid_args'      // argumen tidak cocok skema
  | 'upstream_error';   // model/endpoint gagal

export interface ActionResult {
  // …field yang sudah ada…
  /** Kode stabil untuk statistik, policy, dan remedy. */
  code?: ToolErrorCode;
  /** Boleh dicoba lagi tanpa mengubah apa pun? */
  retryable?: boolean;
  /** Biaya nyata call ini, untuk dashboard dan budget. */
  cost?: { ms: number; bytes: number };
}
```

`shell.ts` sudah tahu bedanya penolakan, timeout, dan exit code; `failures.ts`
memetakan `ToolErrorCode` → `FailureReason` supaya `/api/failures` bisa dipecah
per kode, bukan hanya per cause.

**Definition of done** — `scripts/tools-check.mjs`:
setiap cabang `executeAction` yang mengembalikan `ok: false` menghasilkan `code`;
`grep -c "ok: false"` di `tools.ts` ≤ jumlah `code:` + cabang `throw` yang
ditangkap; `/api/failures` mengembalikan `codes: [{code,count}]` untuk data uji.

### 1.2 Tool baru (skema yang dikirim ke model)

Semua mengikuti bentuk `LlmTool` yang sudah dipakai `toolSchemas.ts`.

```jsonc
// apply_patch — satu-satunya cara menulis file multi-hunk
{ "name": "apply_patch",
  "parameters": { "type": "object", "required": ["diff"], "properties": {
    "diff": { "type": "string", "description": "Unified diff dengan header ---/+++ dan @@. Path relatif workspace." },
    "dry_run": { "type": "boolean", "description": "Hanya kembalikan diff yang akan diterapkan." } } } }

// search_symbol — dari code map, bukan regex
{ "name": "search_symbol",
  "parameters": { "type": "object", "required": ["query"], "properties": {
    "query": { "type": "string" },
    "kind": { "type": "string", "enum": ["function","class","method","type","const","any"] },
    "limit": { "type": "integer", "description": "1-100, default 20" } } } }

// find_references
{ "name": "find_references",
  "parameters": { "type": "object", "required": ["path","line"], "properties": {
    "path": { "type": "string" }, "line": { "type": "integer" } } } }

// run_check — hasil terstruktur, bukan stdout mentah
{ "name": "run_check",
  "parameters": { "type": "object", "properties": {
    "name": { "type": "string", "description": "Nama check yang sudah dikenal folder; kosong = semua." },
    "filter": { "type": "string", "description": "Hanya jalankan check yang namanya cocok." } } } }

// http_request — di atas guard SSRF yang sama dengan web_fetch
{ "name": "http_request",
  "parameters": { "type": "object", "required": ["url"], "properties": {
    "url": { "type": "string" }, "method": { "type": "string", "enum": ["GET","HEAD","POST","PUT","PATCH","DELETE"] },
    "headers": { "type": "object" }, "body": { "type": "string" },
    "expect_json": { "type": "boolean" } } } }

// read_media — input multimodal
{ "name": "read_media",
  "parameters": { "type": "object", "required": ["path"], "properties": {
    "path": { "type": "string" }, "pages": { "type": "string", "description": "mis. \"1-3\" untuk PDF" },
    "detail": { "type": "string", "enum": ["text","image","both"], "default": "both" } } } }

// browser_* — bukti interaktif, hanya jika OFFICE_BROWSER=1
{ "name": "browser_open",  "parameters": { "type": "object", "required": ["url"] } }
{ "name": "browser_act",   "parameters": { "type": "object", "required": ["action"], "properties": {
    "action": { "type": "string", "enum": ["click","type","press","wait_for","scroll"] },
    "target": { "type": "string", "description": "CSS selector atau teks yang terlihat" },
    "value": { "type": "string" } } } }
{ "name": "browser_read",  "parameters": { "type": "object", "properties": {
    "what": { "type": "string", "enum": ["text","console","network","screenshot"], "default": "text" } } } }
```

`run_check` mengembalikan `detail` berupa JSON:
`{ ok, ran: [{name, ok, ms}], failures: [{file, line, check, message}] }` — itu
yang dipakai model untuk memperbaiki, bukan 4.000 karakter log.

**Definition of done** — `check:tools`:
(a) `apply_patch` menerapkan diff 2 hunk dan menolak diff yang konteksnya tidak
cocok tanpa mengubah file; `dry_run` tidak menulis apa pun;
(b) `search_symbol` menemukan `buildSystemPrompt` di `agentRuntime.ts` dan
`find_references` mengembalikan ≥ 2 pemakaian;
(c) `run_check` pada fixture mengembalikan `failures[0].file` yang benar;
(d) `http_request` menolak `169.254.169.254` sebelum request;
(e) `browser_*` menghasilkan screenshot > 10 KB pada fixture HTML.

### 1.3 Capability router

`server/src/toolRouter.ts`:

```ts
export interface ToolPolicy {
  name: string;
  group: 'office' | 'fs' | 'shell' | 'process' | 'web' | 'browser' | 'data';
  risk: 'read' | 'write' | 'exec' | 'network';
  phases: ('plan' | 'build' | 'verify')[];
  /** Tool ini relevan kalau workspace punya file bertanda ini. */
  when?: (facts: WorkspaceFacts) => boolean;
}
export interface WorkspaceFacts {
  hasPackageJson: boolean; hasPython: boolean; hasRust: boolean;
  hasTests: boolean; hasHtml: boolean; serversRunning: number;
  lastFailure: FailureReason | null;
}
export function toolsFor(input: {
  phase: 'plan' | 'build' | 'verify';
  facts: WorkspaceFacts;
  availability: ToolAvailability;
  max?: number;          // default 12
}): LlmTool[];
```

Algoritma: filter `phases` → filter `when` → urutkan `(risk === 'write' ? 1 : 0, group)` →
ambil `max` → **selalu** sertakan `complete_task`, `add_note`, dan tool remedy
untuk `lastFailure`. `buildToolSchemas` tetap ada sebagai pembungkus
`toolsFor({phase:'build', …})` agar check lama tidak berubah.

**Definition of done:** `toolsFor` mengembalikan ≤ 12 tool untuk 6 kombinasi
fase×fakta; fase `plan` tidak pernah memuat `run_command`; setelah
`lastFailure = 'tool_loop'`, tool yang sama dengan pemicu loop tidak dikirim dua
kali berturut-turut.

### 1.4 Eksekusi paralel dengan kunci per path

Di `#runTurn`, kumpulan `toolCalls` dipecah:

```ts
// run_check sengaja tidak ada di sini: ia menjalankan proses dan bisa menulis
// artefak, jadi ia ikut jalur serial.
const READONLY = new Set(['read_file','list_directory','search_files','search_symbol',
  'find_references','http_check','http_request','port_status','process_logs']);
```

- read-only → `Promise.allSettled` dengan batas 4;
- write/exec → serial, dengan `Map<string, Promise<unknown>>` per path dari
  argumen `path`/redirect;
- hasil dikembalikan sesuai urutan `tool_call_id`.

**Definition of done:** 3 `read_file` paralel selesai < 1,5× satu read; dua
`write_file` ke path yang sama tidak pernah tumpang tindih (assert dari trace
`startedAt`/`finishedAt`); urutan observasi tetap sama dengan urutan call.

---

## 2. Multi-agent orchestration

### 2.1 Skema DAG

`shared/types.ts`:

```ts
export interface Task {
  // …yang sudah ada…
  dependsOn: string[];              // id task yang harus `done` dulu
  role: 'work' | 'review' | 'merge'; // node biasa, reviewer, atau penggabung
  attention: boolean;               // mission butuh manusia tapi tidak mati
}
export interface Handoff {
  files: string[];      // file yang dimiliki node ini (tidak boleh dipakai node lain)
  accept: string;       // perintah check yang membuktikan node selesai
  status: 'ready' | 'needs-review';
  notes: string;
}
```

`create_task` menerima `dependsOn` dan memvalidasi: tidak ada siklus, tidak ada
dua node dengan file yang sama, setiap `dependsOn` menunjuk task di mission yang
sama.

### 2.2 Scheduler

`server/src/scheduler.ts`:

```
ready(node)  = semua dependsOn berstatus done
run          = ambil ready, urut priority lalu createdAt, batasi OFFICE_MAX_PARALLEL (default 3)
on settle    = kalau done: tandai dependent; kalau blocked: dependent → todo (bukan blocked),
               node.mission.attention = true
merge        = setelah semua node `work` selesai, jalankan node `review`, lalu `merge`
```

`runTask` yang sekarang dipanggil langsung dari `createTask` diganti
`this.#scheduler.wake(missionId)`. Queue per-worker (`#queues`) tetap dipakai
untuk serialisasi per agent, bukan per mission.

### 2.3 Reviewer independen

Rubrik yang sama untuk kedua reviewer:

```ts
interface ReviewFinding { severity: 'high'|'medium'|'low'; file: string; line?: number; issue: string; fix: string }
interface ReviewVerdict { pass: boolean; findings: ReviewFinding[]; rubric: string[] }
```

Reviewer 1 = agent dengan peran berbeda dan **model berbeda**; reviewer 2 =
`run_check` repo (check yang sudah ada, dijalankan ulang pada tree hasil merge).
Lulus hanya jika `pass === true` dan `findings.filter(f => f.severity === 'high').length === 0`.
Penolakan mengembalikan task ke **pemilik file**, bukan ke lead.

### 2.4 Isolasi tulis dan merge queue

- Mission dengan ≥ 2 node `work` paralel: `git worktree add .agent-office/worktrees/<taskId> <base>`.
- Setiap node bekerja di worktree-nya; `workspaceRoot` diganti per-turn (sudah
  berupa setting, jadi cukup di-scope di `#runTurn`).
- Merge queue: satu per satu, `git rebase <base>`, jalankan `accept` node, baru
  fast-forward. Konflik → node kembali ke pemilik dengan `failureReason:
  'no_progress'` dan catatan konflik file+baris.

**Definition of done** — `check:orchestration`:
(a) DAG `A→C, B→C, C→D` selesai dengan urutan `A,B` sebelum `C` sebelum `D`;
(b) dua node paralel menulis file berbeda, trace tidak menunjukkan path sama;
(c) reviewer menolak satu temuan `high` → task pemilik file kembali `doing`;
(d) satu node `blocked` → sibling tetap selesai, mission `attention`, dependent `todo`;
(e) mission 5 node paralel memakai token ≤ 80% mission serial ekuivalen.

---

## 3. Guardrails & output parsers

### 3.1 Policy engine

`server/src/policy.ts`:

```ts
export type Effect =
  | { effect: 'allow' }
  | { effect: 'deny'; code: ToolErrorCode; hint: string }
  | { effect: 'review'; reason: string };
export interface PolicyContext {
  workspace: string; spend: { missionTokens: number; budget: number };
  provenance: 'user' | 'plan' | 'web' | 'file';
  running: number;
}
export function evaluate(call: { action: string; args: Record<string, unknown> }, ctx: PolicyContext): Effect;
```

Aturan awal (12, semuanya harus punya test):

| # | Kondisi | Efek |
|---|---|---|
| 1 | path/redirect di luar workspace | deny `path_outside` |
| 2 | binary di luar allowlist | deny `binary_refused` + remedy |
| 3 | `delete_file` untuk folder root | deny |
| 4 | `delete_file` > 50 file | review |
| 5 | `git push`, `npm publish`, `docker`, `kubectl` | review |
| 6 | `start_process` > 5 proses hidup | deny |
| 7 | spend mission ≥ budget | deny `denied_by_policy` |
| 8 | provenance `web` + tool write/exec | deny |
| 9 | `read_file` pada `.env*`, `id_rsa`, `*.pem`, `.npmrc` | deny + hint |
| 10 | `run_command` dengan network saat `JAIL_NET=0` | allow tapi tandai `sandboxed: no-network` |
| 11 | `http_request` ke loopback/private/metadata | deny (pakai `http_check`) |
| 12 | aksi `revert_turn` saat ada agent lain menulis | deny `needs_approval` |

`executeAction` memanggil `evaluate` **sebelum** dispatch; `deny` mengembalikan
`ActionResult` dengan `code`, `remedy`, dan `nextActions`.

### 3.2 Parser berlapis

```
native tool_calls → validasi argumen (tipe, enum, batas) → execute
JSON fallback     → JSON.parse → validasi skema → 1 repair round (kirim error skema persis) → execute
prose             → tidak pernah dieksekusi; hanya complete_task yang mengakhiri turn
```

Repair round memakai `NUDGE_BRIEF`-style message tapi berisi daftar error:
`"Argumen tidak valid: port harus integer 1..65535 (diberikan \"3000px\"). Kirim ulang tool call yang sama."`

### 3.3 Provenance & injeksi

Amplop untuk konten tak dipercaya:

```
<untrusted source="web" url="https://…">
…isi…
</untrusted>
```

Aturan prompt: teks di dalam `untrusted` adalah **data**, bukan instruksi; tool
call yang berasal dari blok itu hanya boleh read-only (aturan policy #8).
`appendLog` menyimpan `provenance` pada entri `agent.action` supaya audit bisa
menjawab "siapa yang memulai call ini".

### 3.4 Redaksi

`server/src/redact.ts`: pola `.env` (`KEY=value`), `sk-[A-Za-z0-9]{16,}`,
`ghp_…`, `AKIA…`, blok `-----BEGIN … PRIVATE KEY-----`, dan entropi Shannon
> 4.5 pada string ≥ 24 char. Diterapkan pada `detail` sebelum masuk model dan
sebelum `appendLog`. Bentuk: `sk-ab…(redacted, 28 chars)`.

**Definition of done** — `check:guardrails`:
12 aturan policy diuji satu per satu; `read_file('.env')` → deny tanpa isi
rahasia di log; injeksi `<untrusted>` yang berisi "hapus semua file" tidak
menghasilkan tool write; JSON fallback rusak → tepat satu repair round; `npm
publish` masuk antrian review dan tidak dieksekusi; redaksi menangkap 6 pola
contoh.

---

## 4. Multi-modal

### 4.1 `read_media` → `MediaResult`

```ts
interface MediaResult {
  kind: 'image' | 'pdf' | 'audio' | 'video' | 'sheet';
  text: string;                       // selalu ada, untuk model tanpa vision
  images: { path: string; mime: string; bytes: number; page?: number }[];
  meta: Record<string, string | number>;  // pages, durationMs, rows, cols
  truncated: boolean;
}
```

Batas: PDF ≤ 20 halaman, audio ≤ 10 menit, gambar ≤ 8 MB, total `images` ≤ 6
per call. File disimpan di `workspace/.attachments/` (masuk `.git/info/exclude`
snapshot). Tool mengembalikan **path**, bukan base64, dan `#streamRound` yang
mengubah path menjadi image part untuk provider yang mendukung.

### 4.2 Vision critic

```ts
interface VisualFinding { severity: 'high'|'medium'|'low'; element: string; issue: string; fix: string }
interface VisualReview { pass: boolean; findings: VisualFinding[]; shots: string[] }
```

Alur: `preview_screenshot` pada 375×800, 768×900, 1440×1000 → kirim 3 gambar +
brief + rubrik (hierarki visual, kontras ≥ 4.5:1, alignment, copy, target size
≥ 44px) → `VisualReview`. Temuan `high` dipatch; maksimum 2 iterasi; kalau masih
gagal, `add_note` + `complete_task` dengan catatan jujur (bukan klaim lulus).

### 4.3 Output

`render_chart` (SVG, data → file), `record_walkthrough` (Playwright trace →
WebM ≤ 30 s), `generate_image` (opt-in, provider image API). Semua menulis ke
`.agent-office/artifacts/<missionId>/` dan mengembalikan path.

**Definition of done** — `check:multimodal`:
PNG 3 breakpoint terkirim sebagai image part (mock provider mencatat `images:
3`); PDF 2 halaman → `meta.pages === 2` dan `text` memuat kata kunci; audio 5 s
→ transkrip tidak kosong; vision critic menolak fixture kontras rendah; WebM
> 0 byte dan `ffprobe` membaca durasinya.

---

## 5. Memory

### 5.1 Skema

```ts
interface Fact {
  id: string; text: string;
  kind: 'build' | 'test' | 'layout' | 'convention' | 'gotcha';
  source: { file?: string; line?: number; commit?: string } | null;
  confidence: number;         // 0..1
  createdAt: number; lastUsedAt: number;
  supersedes?: string;        // id fakta yang dikoreksi
}
interface CodeSymbol {
  path: string; name: string; kind: 'function'|'class'|'method'|'type'|'const';
  line: number; endLine: number; exported: boolean;
}
interface CodeMapEntry { path: string; hash: string; symbols: CodeSymbol[]; imports: string[]; }
interface Episode {
  missionId: string; title: string; outcome: 'done'|'blocked';
  files: string[]; checks: string[]; failureReason?: FailureReason; summary: string;
}
```

Penyimpanan: `.agent-office/memory/facts.jsonl`, `code-map.json`,
`episodes.jsonl` — append-only untuk facts/episodes, snapshot penuh untuk code map.

### 5.2 Retrieval

```
score = 0.55 * bm25(query, fact.text)
      + 0.30 * cosine(embed(query), embed(fact.text))   // opsional, fallback 0
      + 0.10 * recency(fact.lastUsedAt)
      + 0.05 * confidence
pack  = greedy by score sampai 600 token, maks 8 fakta
```

Tanpa embedding (default, tanpa API tambahan): bobot dipindah ke bm25 + recency.
`lastUsedAt` diperbarui saat fakta terpakai. Fakta tanpa `source` dan lebih tua
dari 30 hari **tidak** diinjeksi, tapi tetap disimpan.

### 5.3 Kontradiksi dan promosi

- Fakta baru yang mirip (cosine > 0.9 atau bm25 > threshold) dan lebih baru:
  set `supersedes` pada fakta lama; yang lama tidak diinjeksi.
- Entri `MEMORY.md` berformat invariant **wajib** punya pasangan: nama check atau
  id aturan policy. `check:memory` gagal kalau ada invariant tanpa pasangan.
- Inspector UI: daftar fakta + sumber + tombol hapus; perubahan dicatat sebagai
  episode `memory.edited`.

**Definition of done** — `check:memory` diperluas:
500 fakta → blok ≤ 600 token; precision@5 ≥ 0.6 pada fixture 20 query; fakta
bertentangan → hanya yang baru diinjeksi; code map untuk 3 file sampel cocok
dengan `tsc`/grep; fakta > 30 hari tanpa sumber hilang dari prompt; setiap
invariant `MEMORY.md` punya pasangan check/policy.

---

## 6. Peta file (siapa menyentuh apa)

| Fase | File baru | File yang berubah |
|---|---|---|
| F1 guardrails | `server/src/policy.ts`, `server/src/redact.ts`, `scripts/guardrails-check.mjs` | `tools.ts`, `agentRuntime.ts`, `failures.ts`, `shared/types.ts` |
| F2 tools | `server/src/toolRegistry.ts`, `toolRouter.ts`, `patch.ts`, `scripts/tools-check.mjs` | `toolSchemas.ts` (`buildToolSchemas` → `toolsFor`), `tools.ts`, `agentRuntime.ts` |
| F3 DAG | `server/src/scheduler.ts`, `evals/dag.mjs` | `shared/types.ts`, `store.ts`, `agentRuntime.ts`, `routes/tasks.ts` |
| F4 reviewer | `server/src/review.ts`, `worktrees.ts` | `agentRuntime.ts`, `git.ts`, `scripts/snapshot-check.mjs` |
| F5 memory | `server/src/codeMap.ts`, `server/src/memoryRetrieval.ts`, `server/src/memoryInspector.ts`, `scripts/memory-check.mjs` | `projectMemory.ts`, `shared/types.ts`, client panel |
| F6 multimodal | `server/src/media.ts`, `visionCritic.ts`, `artifacts.ts`, `scripts/multimodal-check.mjs` | `llm.ts` (image parts), `preview.ts`, `toolSchemas.ts` |

Urutan aman: **F1 → F2 → F5 → F3 → F4 → F6**. F5 sebelum F3 karena reviewer dan
scheduler memakai `search_symbol` untuk memutuskan pemilik file.

---

## 7. Yang tidak dilakukan (dan alasannya)

- **Bukan** menambah tool sebanyak mungkin: tool yang tidak pernah dipanggil
  menambah token dan salah-pilih. Setiap tool baru harus lolos aturan
  "dipakai ≥ 1× di eval, atau tidak dikirim".
- **Bukan** `sh -c` untuk kenyamanan shell: parser sendiri (`shell.ts`) yang
  membuat `>`/pipe aman; menggantinya dengan `sh -c` akan menghapus seluruh
  jaminan itu.
- **Bukan** auto-approve untuk operasi destruktif: policy `review` sengaja
  memblokir `git push`, publish, dan hapus massal sampai manusia menekan tombol.
- **Bukan** embedding wajib: retrieval harus berguna tanpa API tambahan, karena
  produk ini sudah berjalan dengan satu endpoint model.
