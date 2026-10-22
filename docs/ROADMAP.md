# Roadmap: dari "office yang jalan" ke agent OS

Dokumen ini adalah rencana kerja, bukan daftar keinginan. Setiap bagian punya
**masalah nyata** di repo ini, **bentuk teknis** yang cocok dengan kode yang ada,
**kriteria terima** yang bisa dijalankan sebagai check, dan **urutan** supaya
tidak mengerjakan hal mahal sebelum fondasinya ada.

Spesifikasi teknisnya — tipe, skema tool, algoritma, peta file per fase — ada di
`docs/SPECS.md`. Dokumen ini menjawab apa dan kenapa; dokumen itu menjawab
bagaimana.

Prinsip yang dipakai memilih prioritas:

1. **Yang membuat pekerjaan gagal lebih sering diperbaiki dulu** daripada yang
   membuat demo lebih bagus.
2. **Satu sumber kebenaran per hal** — sekarang sudah begitu untuk token
   (`shared/usage.ts`), kegagalan (`shared/failures.ts`), dan shell
   (`server/src/shell.ts`); setiap fitur baru mengikuti pola itu.
3. **Setiap klaim punya check** — `npm run check` adalah kontrak, bukan ritual.
4. **Boundary lebih kuat dari allowlist** — jail (`server/src/jail.ts`) adalah
   contoh yang benar: batasnya kernel, bukan daftar nama.

---

## 0. Kondisi hari ini (titik awal)

| Lapisan | Sudah ada | Batasnya sekarang |
|---|---|---|
| Tool use | `toolSchemas.ts` (**29 tool**), **capability router** (`router.ts`, 12–13 tool/fase), `ToolErrorCode` stabil, remedy terstruktur | Eksekusi masih sekuensial; belum ada tool paralel |
| Sandbox | mini-shell (`shell.ts`), allowlist + path jail, bwrap (`jail.ts`), managed process | Tanpa seccomp/rlimit; network hanya on/off; belum ada approval manusia |
| Orchestration | lead + subtask, reconciliation 3 pass, queue per worker, `depends_on` + scheduler (`taskGraph.ts`), reviewer independen (`reviewer.ts`), kunci tulis (`fileLocks.ts`), **worktree per task** (`worktrees.ts`), **merge gate** (`mergeQueue.ts`) | Landing menyalin file, bukan `git merge`: konflik dilaporkan per file lalu pekerjaan diulang, bukan digabung otomatis. Folder non-git (atau repo checkpoint buatan office) tetap berbagi folder |
| Guardrails | completion gate, scratch gate, repeat limit, budget, `policy.ts` (allow/review/deny), `redact.ts`, `argGuard.ts` (argumen), `outputGuard.ts` (bentuk hasil), `resultSchemas.ts` (kontrak hasil per tool), kunci path + `stale_read` | Kontrak belum menutup `revert_turn` dan tool kantor; `web_search`/`web_fetch` belum bisa diuji tanpa jaringan |
| Multimodal | `preview_screenshot`, `read_media` (content part gambar), **vision critic** (`visionCritic.ts`, 3× penolakan), `http_check` | Belum ada PDF/audio |
| Memory | `projectMemory.ts` (60 fakta, retrieval BM25 `selectFacts`), code map (`codeMap.ts`), turn snapshot, `MEMORY.md` | Tanpa decay/kontradiksi; retrieval belum lintas-sesi |

---

### 0.1 Status implementasi (diverifikasi `npm run check`)

| Yang sudah ada | Bukti yang menjalankannya | Sisa yang jujur |
|---|---|---|
| `policy.ts` + `redact.ts`: satu gerbang allow/review/deny, redaksi observasi | `check:toolkit` (policy + redaksi), `check:gate` | Belum ada skema JSON penuh (argumen + hasil) per tool |
| `worktrees.ts`: tiap task bekerja di checkout sendiri (HEAD + file belum di-commit), landing lewat merge queue, konflik per file dengan salinan lama disimpan, artefak office tidak ikut landing, checkout lama dibersihkan dengan batas umur dan jumlah dijalankan di awal proses | `check:worktree` (23 kasus: isolasi, landing, konflik, artefak, GC, degradasi, plus 4 misi nyata termasuk pembersihan lintas restart) | Belum `git merge` sungguhan (non-overlap tetap harus diulang); folder non-git tetap berbagi folder |
| `docs-check.mjs`: peta file README ↔ isi disk dua arah, setiap baris bukti `check:…` benar-benar ada dan terpasang di rantai, README Indonesia sejajar dengan README Inggris (outline, tautan file, peta yang sama) | `check:docs` (23 kasus, termasuk 5 fixture yang membuktikan deteksinya bekerja) | Hitungan kasus dan prosa tiap baris tidak diverifikasi otomatis; paragraf rencana hanya boleh menyebut check yang belum ada; kualitas terjemahan tidak dinilai — hanya kelengkapannya |
| `resultSchemas.ts` + `buildObservation`: sukses wajib membawa payload yang dijanjikan (`read_file` teks, `read_media` gambar, tulis menyebut artefak, `complete_task` menutup turn) | `check:outputs` (13 kasus: 4 bentuk + 6 kontrak + 3 hasil tool nyata) | `web_search`/`web_fetch` belum diuji tanpa jaringan; `revert_turn` sengaja tidak dikontrak |
| `apply_patch` (atomik, tahan drift, dry-run) | `check:toolkit` (5 kasus patch) | Belum dipakai otomatis oleh reviewer |
| `codeMap.ts` + `search_symbol` / `find_references` | `check:toolkit` (4 kasus code map) | Cache 5 detik; belum inkremental per-hash |
| `run_check` (script folder → file:line) | `check:toolkit` (dispatcher: laporan `not_found` yang jujur) | Belum ada check end-to-end dengan model mock |
| `depends_on` + `readyTasks` + `#releaseDependents` | `check:toolkit` (3 kasus task graph) | Belum ada scheduler paralel lintas worker |
| Retrieval memori `selectFacts` (BM25 + recency) | `check:memory` 15/15 (termasuk ranking & fallback) | Belum ada decay/kontradiksi antar sesi |
| `http_request` (loopback dev server, SSRF guard) | `check:toolkit` (policy), `check:http` | Tanpa proxy domain; hanya allow/review per URL |
| Capability router: 12–13 tool per fase | `check:router` — 56,4% lebih sedikit token skema pada misi 12 round | Belum adaptif per model; fase ditentukan aksi, bukan isi tugas |
| Reviewer independen setelah gate | `check:review` — misi nyata: tolak → kirim balik → terima, termasuk misi di repo git yang tidak punya checkpoint (diff dari checkout task) | Refusal maksimal 3× per task; belum ada reviewer kedua |
| `read_media` → content part gambar | `check:toolkit` (gambar 1×1, wire format, penolakan non-image) | PDF/audio belum |
| Kunci tulis per-path + folder | `check:concurrency` — dua tulis bersamaan, patch saat file dipegang, command vs tulis | Kunci per panggilan; command memakai kunci folder kasar |
| Baca basi ditolak | `check:concurrency` — baca → worker lain menulis → tulis/patch ditolak `stale_read`, lalu lolos setelah baca ulang | Hanya untuk file yang benar-benar dibaca |
| Merge gate | `check:merge` — misi nyata: file berubah saat review → ditolak, di-review ulang, diterima | Mendeteksi konflik; tidak menggabungkan cabang/worktree |
| Guard bentuk hasil | `check:outputs` — ringkasan kosong, `next_actions` tak dikenal, kode asing; semua tool nyata lolos | Invarian struktural, bukan skema per-tool |
| Validasi argumen vs schema + gate brief di depan `create_task` | `check:args` (17 kasus: field wajib, tipe, enum, brief tanpa anchor ditolak, kata penerimaan bukan anchor, advisori untuk brief tipis) | Belum mengukur kualitas brief di luar dua aturan itu |
| Vision critic setelah gate | `check:vision` — misi nyata: tolak → perbaiki → terima; batas 3× memakai pola cap yang diuji `check:review` | Butuh model vision |
| `rolePacks.ts`: doktrin tim (brief sebagai prompt engineering, bukti di atas klaim, kontrak saat serah terima) + 12 pak peran yang masuk system prompt dan dipakai reviewer | `check:prompt` (24 kasus: prefiks caching identik lintas peran, tiap peran seed punya paknya, setiap pak reachable dari labelnya, fallback untuk peran bebas, pemilihan pak dari brief/eksplisit/peran, payload `/api/playbook` lengkap) | Inferensi hanya berlaku saat peran generik |
| Pak berbobot + jejak: artefak (3) > dua kata (2) > satu kata (1), alasan pilihan disimpan di `Task.activePack`/`packSource`, dicatat di log, dan ditampilkan di kartu task | `check:playbook` (39 kasus: bobot artefak vs kata kunci, seri dilaporkan, empat bentuk baris log cocok dengan template, tiap pak punya nama UI) | Bobot masih heuristik tangan; belum belajar dari hasil eval |
| Penolakan reviewer jadi data pak: `Task.reviewRefusals` + `summariseRefusals` memetakan alasan ke bullet `review` pak yang dikutip, lalu diranking per pak dan tampil di tab Playbook | `check:playbook` — penolakan frontend → aturan 2, qa → aturan 1, alasan tanpa aturan dihitung `unmatched`, urutan stabil | Atribusi berbasis kata (minimal 2 kata cocok); alasan yang sangat umum masuk `unmatched` |
| `evals/playbook.mjs` + `check:playbook`: satu misi per pak, masing-masing dengan pohon "benar" dan pohon "terlihat selesai", dinilai `accept` pak itu sendiri | `check:playbook` (39 kasus, tanpa model: cakupan 13 pak, `proves` benar-benar bullet `done`, brief lolos gate, good tree lulus, bad tree ditolak) | Mutu model nyata baru terukur lewat `npm run eval:playbook` yang manual (butuh kredit); belum ada ambang lulus per pak di CI |

Capability router, reviewer independen, vision critic, kunci tulis + optimistic
read guard, merge gate, validasi argumen dan bentuk hasil sudah masuk. Yang
masih terbuka: worktree terisolasi (F4 tahap 2 — merge gate hanya mendeteksi
konflik), skema hasil per-tool yang spesifik, dan PDF/audio.

---

## 1. Tool use: dari daftar tool ke **capability router**

### Masalah
`buildToolSchemas()` mengirim semua tool di setiap round. Prompt tool ikut
dibayar 40×, dan model melihat tool yang tidak relevan (mis. `preview_screenshot`
saat memperbaiki parser). Ini ongkos token **dan** sumber salah-pilih tool.

### Bentuk teknis
- `server/src/toolRegistry.ts`: satu entri per tool dengan metadata
  `{ name, group, risk: 'read'|'write'|'exec'|'network', cost, requires, schema }`.
- `server/src/toolRouter.ts`: memilih subset per turn dari (a) fase task
  (`plan`, `build`, `verify`), (b) jenis file di workspace, (c) `failureReason`
  terakhir. Contoh: setelah `tool_loop`, kirim ulang tool dengan `remedy` dan
  buang tool yang sudah terbukti gagal.
- `buildToolSchemas()` menjadi `toolsFor({ phase, workspace, history })`.
- Patok ukuran: **≤ 12 tool per round**, dan tidak ada tool `exec` di fase
  `plan`.

### Tool yang perlu ditambah (urutan leverage)
1. **`apply_patch`** — unified diff, atomik, rollback otomatis kalau konteks
   tidak cocok. Menghapus seluruh kelas kegagalan `edit_file` (teks tidak
   ketemu karena indentasi).
2. **`search_symbol` / `find_references`** — dari code map (lihat §5), bukan
   regex. Ini tool yang paling menaikkan kualitas kerja di repo besar.
3. **`run_check`** — menjalankan check yang **sudah** dikenal folder
   (`npm test`, `pytest`, `cargo test`) dan mengembalikan hasil terstruktur
   (`{ ok, failures: [{file,line,message}] }`), bukan 4.000 karakter stdout.
4. **`http_request`** — method/headers/body/JSON, dengan guard SSRF yang sama;
   `http_check` tetap ada sebagai pintasan.
5. **`read_media`** (lihat §4), **`sql_query`** (read-only, timeout),
   **`git_diff` / `git_log`**, **`move_file`**, **`zip`/`unzip`**.
6. **`browser_*`** — Playwright sebagai tool nyata: `navigate`, `click`,
   `type`, `screenshot`, `console_errors`. Ini yang mengubah "halaman terlihat
   benar" dari klaim menjadi bukti interaktif.

### Kontrak hasil tool (perubahan kecil, efek besar)
Semua hasil menjadi:

```ts
interface ToolResult {
  ok: boolean;
  code?: ToolErrorCode;        // 'path_outside' | 'binary_refused' | 'timeout' | ...
  summary: string;
  detail?: string;             // payload yang dibaca model
  remedy?: Remedy;             // tool pengganti + argumen
  retryable: boolean;
  cost?: { ms: number; bytes: number };
  artifacts?: string[];
}
```
`code` yang stabil adalah bahan bakar guardrails (§3) dan statistik kegagalan:
`GET /api/failures` bisa dipecah per `code`, bukan hanya per `failureReason`.

### Eksekusi paralel yang aman
Satu round boleh berisi beberapa tool call. Sekarang dijalankan berurutan.
Ubah menjadi:
- kumpulkan call readonly (`read_file`, `search`, `http_check`, `port_status`)
  → jalankan paralel dengan batas 4;
- call yang menulis → serial, dan **kunci per path** (`Map<path, Promise>`),
  supaya dua agent tidak menulis file yang sama di saat bersamaan;
- hasilnya dikembalikan dalam urutan `tool_call_id` asli.

**Kriteria terima:** `check:tools` baru — round dengan 3 read paralel selesai
< 1,5× waktu satu read; dua write ke path sama tidak pernah interleave; subset
tool per fase ≤ 12; setiap `ToolResult` punya `code` saat gagal.

**Estimasi:** router 2 hari, `apply_patch` 1 hari, `run_check` 1 hari,
paralelisme 1–2 hari.

---

## 2. Multi-agent orchestration: dari lead datar ke **DAG + reviewer**

### Masalah
`createTask` membuat subtask datar tanpa dependency. Dua worker bisa menulis
file yang sama, dan lead baru tahu setelah semuanya selesai. `synthesis_stalled`
adalah gejala dari desain ini.

### Bentuk teknis
- **`Task.dependsOn: string[]`** + `server/src/scheduler.ts`:
  - node siap = semua dependency `done`;
  - jalankan paralel dengan batas `OFFICE_MAX_PARALLEL` (default 3);
  - `blocked` pada satu node tidak membatalkan sibling, tapi menahan dependent
    dan menandai mission `attention` (bukan `blocked` total).
- **Kontrak handoff** menggantikan prosa:
  ```ts
  interface Handoff { files: string[]; accept: string; status: 'ready'|'needs-review'; notes: string }
  ```
  Lead membagi berdasarkan file yang **dimiliki**, bukan berdasarkan kalimat.
- **Reviewer independen (pola Santa):** sebelum node `merge`, dua reviewer
  berbeda (satu agent, satu check repo) harus lulus dengan rubrik yang sama.
  Satu saja gagal → kembali ke pemilik file, bukan ke lead.
- **Isolasi tulis:** `git worktree` per agent untuk mission paralel, lalu merge
  queue (satu per satu, rebase, jalankan check). Ini menghapus seluruh kelas
  konflik "dua worker menulis file yang sama".
- **Routing model per peran:** `AgentProfile` mendapat `modelTier`
  (`cheap|strong`) dan tool allowlist. Loop tool memakai `cheap`; perencanaan
  dan reconciliation memakai `strong`; eskalasi setelah 2 kegagalan.
- **Trace yang bisa diputar ulang:** satu JSON per mission
  (`{ rounds, toolCalls, gateRuns, usage, snapshots }`) disimpan di state dir.
  Ini bahan untuk eval dan untuk "mission recording" yang bisa dibagikan.

**Kriteria terima:** `check:orchestration` baru —
(a) DAG 5 node dengan 2 dependency selesai dalam urutan yang benar;
(b) dua worker tidak pernah menulis path yang sama (assert dari trace);
(c) reviewer yang menolak mengembalikan task ke pemilik file;
(d) mission dengan satu node `blocked` tetap menyelesaikan sibling dan berhenti
dengan alasan `attention`;
(e) total token lebih kecil 20% dibanding lead datar pada skenario yang sama.

**Estimasi:** scheduler + `dependsOn` 2 hari, handoff contract 1 hari,
reviewer 2 hari, worktree/merge queue 3 hari.

---

## 3. Guardrails & output parsers

### 3.1 Policy engine (bukan if-else tersebar)
`server/src/policy.ts`:
```ts
type Decision = { effect: 'allow' } | { effect: 'deny'; code: string; hint: string } | { effect: 'review'; reason: string };
evaluate(call: ToolCall, ctx: { workspace, risk, spend, time }): Decision
```
Aturan awal:
- `write` di luar workspace → deny (`path_outside`);
- `exec` binary di luar allowlist → deny + remedy;
- `git push`, `docker`, `curl` keluar → **review** (butuh approval manusia);
- spend per mission > budget → deny (`budget`);
- `delete_file` pada > 50 file sekaligus → review;
- tool call dari konten web (provenance `untrusted`) yang meminta write → deny.

Deny selalu membawa `hint` + `remedy`, persis seperti `shell.ts` sekarang.

### 3.2 Output parser berlapis
- **Native tool calls** → validasi argumen dengan skema (sudah implisit) dan
  **tipe ketat** (mis. `port` integer 1–65535) sebelum eksekusi.
- **JSON fallback** → parse → validasi skema → kalau gagal, **satu** repair
  round yang menyertakan error skema persis. Sudah ada `parseAction`; tambahkan
  validasi, bukan hanya `JSON.parse`.
- **Prose output** → tidak dipercaya; hanya `complete_task` yang mengakhiri.
- **Channel terpisah**: `thought` (tidak dieksekusi), `tool_call` (dieksekusi),
  `final` (ditampilkan). Mencegah teks bebas menjadi aksi.

### 3.3 Prompt injection & data provenance
- Setiap isi dari `web_fetch`, `read_file` di luar source code, dan output
  command diberi pembungkus:
  `<untrusted source="web" url="…">…</untrusted>` dan aturan prompt: instruksi
  di dalam blok itu tidak pernah menjadi perintah.
- Tool call mencatat **asal keputusan** (`user` | `plan` | `web`). Tool call
  yang berasal dari `web` dibatasi ke tool read-only.
- Redaksi sebelum data masuk model: pola `.env`, `sk-…`, token, private key,
  dan high-entropy string. `read_file` menolak `.env`, `id_rsa`, kredensial
  (sekarang belum ditolak — hanya `.gitignore` yang menghalangi).

### 3.4 Batas proses yang lebih keras
- `bwrap --seccomp` (profil deny-by-default untuk syscall sensitif) dan
  `--rlimit` / cgroup untuk CPU, memori, jumlah proses.
- Proxy jaringan sidecar kalau `OFFICE_JAIL_NET=1`: allowlist domain, bukan
  seluruh internet.
- Batas output per tool (sudah ada 4–8 KB) dan batas byte artifacts.

### 3.5 Approval manusia
Antrian `review` yang muncul di UI: "Aria ingin menjalankan `npm publish`" →
Setujui/Tolak, dengan timeout. Setiap keputusan dicatat di trace dan di
`/api/failures` sebagai `policy_review`.

**Kriteria terima:** `check:guardrails` —
(a) 12 aturan policy diuji satu per satu (allow/deny/review);
(b) percobaan `read_file('.env')` ditolak dan tidak ada isi rahasia di log;
(c) injeksi di halaman web tidak menghasilkan tool call write;
(d) JSON fallback yang rusak memicu tepat satu repair round;
(e) `npm publish` masuk antrian review dan tidak jalan tanpa approval.

**Estimasi:** policy 2 hari, parser 1 hari, provenance/redaksi 2 hari, seccomp
1–2 hari, approval UI 2 hari.

---

## 4. Multi-modal input & output

### 4.1 Input
Satu tool `read_media({ path | url })` yang mengembalikan **teks + referensi
gambar** ke model vision:
- gambar (PNG/JPG/WebP) → dikirim sebagai image part (provider yang mendukung)
  + deskripsi tekstual sebagai fallback;
- PDF → teks per halaman + gambar halaman bermasalah (scan);
- audio → transkrip (Whisper lokal atau API) + timestamp;
- spreadsheet → tabel markdown + tipe kolom;
- video → 6–12 frame kunci + transkrip.

UI: lampiran ke mission (drag-drop), disimpan di `workspace/.attachments/`
(di-ignore dari snapshot).

### 4.2 Output
- `render_chart` (SVG dari data), `generate_image` (mock/desain, opt-in),
  `render_page` (sudah: `preview_screenshot`), `record_walkthrough`
  (Playwright → WebM) untuk demo.
- Preview inline di panel chat: gambar, diff, dan tabel.

### 4.3 Vision critic (pembeda utama)
Loop yang tidak dimiliki kebanyakan agent coding:
1. `preview_screenshot` pada 375/768/1440;
2. kirim 3 gambar + brief ke model vision dengan rubrik (hierarki, kontras,
   alignment, copy);
3. output **daftar temuan terstruktur** `{ severity, element, issue, fix }`;
4. patch otomatis untuk temuan `high`, ulangi maksimum 2×.

Ini mengubah "halaman sudah jadi" dari klaim teks menjadi penilaian visual,
dan cocok dengan sifat produk ini (office 3D, UI adalah produknya).

**Kriteria terima:** `check:multimodal` —
(a) PNG 3 breakpoint terkirim dan diterima provider (mock) sebagai image part;
(b) PDF 2 halaman menghasilkan teks + jumlah halaman yang benar;
(c) audio 5 detik menghasilkan transkrip;
(d) vision critic menolak halaman dengan kontras rendah pada fixture;
(e) `record_walkthrough` menghasilkan file > 0 byte dan bisa diputar (ffprobe).

**Estimasi:** `read_media` 3 hari, vision critic 2 hari, output media 2 hari.

---

## 5. Memory: dari 60 kalimat ke **tiga lapis + code map**

### Masalah
`projectMemory` menginjeksi semua fakta (maks 60) ke setiap turn — makin pintar
folder, makin mahal dan makin bising. Tidak ada retrieval, tidak ada code map,
tidak ada cara fakta lama dikoreksi.

### Bentuk teknis
- **Lapis 1 — working:** ringkasan turn berjalan (sudah: chat + messages).
- **Lapis 2 — episodic:** ringkasan per mission (apa yang dikerjakan, check apa
  yang lulus, file apa yang berubah), disimpan di state dir.
- **Lapis 3 — semantic:** fakta proyek + **code map**.
  - Code map: tree-sitter → `{ symbols, imports, exports, tests }` per file,
    inkremental (mtime + hash). Ini yang membuat `search_symbol` dan
    `find_references` mungkin.
  - Retrieval hybrid: BM25 + embedding, top-k dengan budget token (mis. 600),
    recency & frekuensi sebagai tie-break.
  - **Kontradiksi:** fakta baru dengan `source` (file:line, commit) menimpa
    fakta lama; fakta tanpa sumber dan lebih tua dari 30 hari memudar.
- **Failure memory:** entri `MEMORY.md` yang berupa invariant **dipromosikan**
  menjadi aturan policy atau check (satu arah: post-mortem → guardrail), supaya
  pelajaran tidak hanya dibaca manusia.
- **Memory inspector** di UI: lihat, edit, hapus, dan lihat sumber tiap fakta.
  Tanpa ini, memori yang salah adalah bug yang tidak bisa diperbaiki operator.

**Kriteria terima:** `check:memory` diperluas —
(a) 500 fakta → blok yang diinjeksi ≤ 600 token dan memuat fakta yang relevan
    dengan brief (ukur precision@5 pada fixture);
(b) fakta yang bertentangan: yang baru menang, yang lama hilang;
(c) code map akurat pada repo ini (jumlah simbol per file cocok dengan
    `tsc`/grep untuk 3 file sampel) dan update setelah file berubah;
(d) fakta > 30 hari tanpa sumber tidak lagi diinjeksi;
(e) invariant di `MEMORY.md` punya pasangan check/policy (assert count).

**Estimasi:** retrieval 2–3 hari, code map 4–5 hari (nilai tertinggi untuk
kualitas kode), inspector 2 hari.

---

## 6. Terobosan produk (yang membuat ini bukan "agent biasa")

1. **Mission recording & replay** — karena setiap turn sudah punya snapshot dan
   setiap round tercatat, satu mission bisa diputar ulang langkah demi langkah
   (termasuk diff per tool call). Ini demo, debugging, dan bukti audit sekaligus.
2. **Eval leaderboard internal** — 16 mission yang ada dijalankan terhadap
   beberapa model/route; hasilnya tabel pass-rate × biaya × waktu. Keputusan
   model jadi data, bukan selera.
3. **Role & skill marketplace** — `AgentProfile` + tool pack + prompt sebagai
   satu paket yang bisa diimpor (mis. "Security Auditor", "Flutter Engineer").
   Skill packs mengikuti format `SKILL.md` yang sudah dipakai repo ini.
4. **Standup & inbox** — agent sebagai layanan jangka panjang: jadwal
   (`cron`), inbox mission dari webhook/GitHub issue, dan laporan harian.
5. **Local-first mode** — Ollama/vLLM endpoint + model kecil untuk loop tool,
   supaya privasi folder klien tidak perlu kompromi.

---

## 7. Urutan eksekusi (90 hari)

| Fase | Isi | Keluar bila |
|---|---|---|
| **F1 (minggu 1–2)** | `ToolResult.code` + policy engine + redaksi `.env`/secret + approval untuk operasi destruktif | `check:guardrails` hijau; tidak ada rahasia di log |
| **F2 (minggu 3–4)** | `apply_patch`, `run_check`, capability router (≤12 tool/fase) | `check:tools` hijau; token per mission turun ≥15% |
| **F3 (minggu 5–6)** | `dependsOn` + scheduler paralel + handoff contract | `check:orchestration` (a,b,d) hijau |
| **F4 (minggu 7–8)** | Reviewer independen + worktree/merge queue | mission paralel tanpa konflik file; review menolak kerja cacat |
| **F5 (minggu 9–10)** | Code map + `search_symbol`/`find_references` + retrieval top-k | `check:memory` (a,b,c) hijau; prompt memory ≤600 token |
| **F6 (minggu 11–12)** | `read_media` + vision critic + mission recording | `check:multimodal` hijau; satu halaman diperbaiki dari kritik visual |

Setiap fase menambah **satu** script check baru ke `npm run check`, dan tidak
menambah check yang tidak bisa gagal.

---

## 8. Kalau hanya boleh satu hal

**Code map + `search_symbol`.** Alasannya: semua kegagalan lain (tool salah,
loop, patch gagal) turun drastis ketika agent bisa menjawab "fungsi ini dipakai
di mana" tanpa `grep` buta dan tanpa membaca 40 file. Ia juga pondasi untuk
reviewer, refactor, dan retrieval memori — tiga pilar sekaligus.

Kalau boleh dua: tambahkan **`apply_patch`**. Dua hal ini mengubah kualitas
kerja lebih banyak daripada model yang lebih mahal.
