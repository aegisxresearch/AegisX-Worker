/**
 * Two languages, one dictionary.
 *
 * The keys describe *where* a string lives, never what it says, so the Indonesian
 * column can be rewritten without touching a caller. `MessageKey` is derived
 * from the table, which turns a typo into a compile error instead of an English
 * string leaking into an Indonesian screen.
 *
 * Scope: everything the operator reads in the browser, including the activity
 * log and the notes on a task card (`shared/wording.ts` maps the English line the
 * server wrote onto one of these keys). Agent-facing prompts stay in English on
 * purpose: they are instructions to a model, not text for a person.
 */
export type Locale = 'en' | 'id';

export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'id', label: 'Bahasa Indonesia' },
];

const STRINGS = {
  'app.title': {
    en: 'Agent Office — 3D virtual office for AI workers',
    id: 'Agent Office — kantor virtual 3D untuk pekerja AI',
  },
  'brand.tagline': {
    en: '3D floor for your AI workforce',
    id: 'Lantai 3D untuk tenaga kerja AI Anda',
  },
  'common.settings': { en: 'Settings', id: 'Pengaturan' },
  'common.send': { en: 'Send', id: 'Kirim' },
  'common.add': { en: 'Add', id: 'Tambah' },
  'common.cancel': { en: 'Cancel', id: 'Batal' },
  'common.start': { en: 'Start', id: 'Mulai' },
  'common.deleteTask': { en: 'Delete task', id: 'Hapus task' },
  'common.unassigned': { en: 'Unassigned', id: 'Belum ditugaskan' },
  'common.loading': { en: 'Loading…', id: 'Memuat…' },

  'workspace.pillTitle': { en: 'Agent workspace folder', id: 'Folder kerja agen' },
  'spend.pillTitle': {
    en: 'Tokens spent by the team — open the cost history',
    id: 'Token yang dipakai tim — buka riwayat biaya',
  },
  'spend.pillAria': { en: 'Open cost history', id: 'Buka riwayat biaya' },

  'conn.connecting': { en: 'Connecting…', id: 'Menghubungkan…' },
  'conn.disconnected': { en: 'Disconnected', id: 'Terputus' },
  'conn.demo': { en: 'Demo mode · no API key', id: 'Mode demo · tanpa API key' },
  'conn.live': { en: 'Live · {model}', id: 'Aktif · {model}' },

  'tasks.title': { en: 'Task board', id: 'Papan task' },
  'tasks.collapse': { en: 'Collapse task board', id: 'Ciutkan papan task' },
  'presets.aria': { en: 'Quick-start missions', id: 'Misi cepat' },
  'preset.app': { en: 'Build an app', id: 'Buat aplikasi' },
  'preset.website': { en: 'Build a website', id: 'Buat website' },
  'preset.bug': { en: 'Fix a bug', id: 'Perbaiki bug' },
  'preset.docs': { en: 'Write docs', id: 'Tulis dokumentasi' },
  'preset.audit': { en: 'Audit this folder', id: 'Audit folder ini' },
  'preset.app.title': { en: 'Build an app I can run today', id: 'Buat aplikasi yang bisa saya jalankan hari ini' },
  'preset.website.title': { en: 'Build a responsive landing page', id: 'Buat landing page yang responsif' },
  'preset.bug.title': { en: 'Find and fix a bug in this folder', id: 'Temukan dan perbaiki bug di folder ini' },
  'preset.docs.title': { en: 'Document how this project works', id: 'Dokumentasikan cara kerja proyek ini' },
  'preset.audit.title': { en: 'Audit this folder and report the risks', id: 'Audit folder ini dan laporkan risikonya' },
  'tasks.titlePlaceholder': {
    en: 'New task for the team…',
    id: 'Task baru untuk tim…',
  },
  'tasks.detailPlaceholder': {
    en: 'Describe the mission — what must exist when it is done?',
    id: 'Jelaskan misinya — apa yang harus ada saat selesai?',
  },
  'tasks.assign': { en: 'Assign task', id: 'Tugaskan task' },
  'tasks.priority': { en: 'Task priority', id: 'Prioritas task' },
  'tasks.team': { en: 'Team', id: 'Tim' },
  'tasks.teamTitle': {
    en: 'One prompt: the lead splits it across several workers and reconciles the result',
    id: 'Satu prompt: lead membaginya ke beberapa worker lalu merekonsiliasi hasilnya',
  },
  'priority.low': { en: 'Low', id: 'Rendah' },
  'priority.medium': { en: 'Medium', id: 'Sedang' },
  'priority.high': { en: 'High', id: 'Tinggi' },
  'priority.urgent': { en: 'Urgent', id: 'Mendesak' },

  'status.todo': { en: 'To do', id: 'Antre' },
  'status.doing': { en: 'Doing', id: 'Dikerjakan' },
  'status.blocked': { en: 'Blocked', id: 'Terblokir' },
  'status.done': { en: 'Done', id: 'Selesai' },
  'agent.idle': { en: 'Idle', id: 'Menganggur' },
  'agent.working': { en: 'Working', id: 'Bekerja' },
  'agent.blocked': { en: 'Blocked', id: 'Terblokir' },
  'agent.error': { en: 'Error', id: 'Error' },
  'agent.meeting': { en: 'In meeting', id: 'Rapat' },

  'team.title': { en: 'Team', id: 'Tim' },
  'chat.select': { en: 'Select an agent', id: 'Pilih agen' },
  'chat.follow': { en: 'Follow agent', id: 'Ikuti agen' },
  'chat.empty': {
    en: 'Pick a teammate to talk to them. They keep working while you chat.',
    id: 'Pilih rekan untuk mengobrol. Mereka tetap bekerja sambil Anda mengobrol.',
  },
  'chat.placeholder': { en: 'Ask Aria to…', id: 'Minta Aria…' },
  'chat.author': { en: 'Agent', id: 'Agen' },

  'failure.title': { en: 'Why work blocked', id: 'Kenapa pekerjaan terblokir' },
  'failure.subtitle': {
    en: 'Grouped by cause — the top row is what to fix next.',
    id: 'Dikelompokkan per penyebab — baris teratas yang perlu diperbaiki dulu.',
  },
  'failure.noProgress': { en: 'Stopped without finishing', id: 'Berhenti tanpa selesai' },
  'failure.toolLoop': { en: 'Stuck repeating a step', id: 'Mengulang langkah yang sama' },
  'failure.budget': { en: 'Budget reached', id: 'Anggaran habis' },
  'failure.modelError': { en: 'Endpoint error', id: 'Error endpoint' },
  'failure.restart': { en: 'Interrupted by restart', id: 'Terputus karena restart' },
  'failure.synthesisStalled': { en: 'Lead could not reconcile', id: 'Lead gagal merekonsiliasi' },
  'failure.next.noProgress': {
    en: 'Read the task notes and send it back with a narrower next step.',
    id: 'Baca catatan task dan kirim lagi dengan langkah berikut yang lebih sempit.',
  },
  'failure.next.toolLoop': {
    en: 'The same call kept repeating — check the note for the call that looped.',
    id: 'Panggilan yang sama terus berulang — cek catatan untuk panggilan yang berputar.',
  },
  'failure.next.budget': {
    en: 'Raise OFFICE_MISSION_TOKEN_BUDGET or split the work into a smaller task.',
    id: 'Naikkan OFFICE_MISSION_TOKEN_BUDGET atau pecah pekerjaan jadi task lebih kecil.',
  },
  'failure.next.modelError': {
    en: 'Check the connection, then start the task again — the files it wrote are kept.',
    id: 'Cek koneksi lalu jalankan task lagi — file yang sudah ditulis tetap ada.',
  },
  'failure.next.restart': {
    en: 'Start the task again and it continues from its notes.',
    id: 'Jalankan task lagi dan ia melanjutkan dari catatannya.',
  },
  'failure.next.synthesisStalled': {
    en: 'Reconcile the subtasks by hand, or re-run the work as one task.',
    id: 'Rekonsiliasi subtask secara manual, atau jalankan ulang sebagai satu task.',
  },

  'activity.aria': { en: 'Activity, cost and playbook', id: 'Aktivitas, biaya, dan panduan' },
  'activity.title': { en: 'Activity', id: 'Aktivitas' },
  'activity.costs': { en: 'Costs', id: 'Biaya' },
  'activity.playbook': { en: 'Playbook', id: 'Panduan' },

  // A pack's name on the board. The server keeps the English label its craft is
  // written for, because that is what the model reads; this is the name shown to
  // an operator, so it is translated like any other piece of UI.
  'pack.general': { en: 'Engineer', id: 'Insinyur' },
  'pack.lead': { en: 'Tech Lead', id: 'Tech Lead' },
  'pack.prompt': { en: 'Prompt Engineer', id: 'Insinyur Prompt' },
  'pack.frontend': { en: 'Frontend Engineer', id: 'Insinyur Frontend' },
  'pack.backend': { en: 'Backend Engineer', id: 'Insinyur Backend' },
  'pack.mobile': { en: 'Mobile App Engineer', id: 'Insinyur Aplikasi Mobile' },
  'pack.ai': { en: 'AI Engineer', id: 'Insinyur AI' },
  'pack.ml': { en: 'ML Engineer', id: 'Insinyur ML' },
  'pack.qa': { en: 'QA Engineer', id: 'Insinyur QA' },
  'pack.security': { en: 'Security Engineer', id: 'Insinyur Keamanan' },
  'pack.data': { en: 'Data Engineer', id: 'Insinyur Data' },
  'pack.devops': { en: 'DevOps Engineer', id: 'Insinyur DevOps' },
  'pack.product': { en: 'Product Manager', id: 'Manajer Produk' },

  // The playbook text itself stays English: it is the instruction the model is
  // given, and translating it would show the operator something no worker ever
  // receives. Only the labels around it are localized, and the note says so.
  'briefing.note': {
    en: 'The exact instruction every worker receives. The rules stay in English because they instruct a model.',
    id: 'Instruksi persis yang diterima setiap pekerja. Aturannya tetap dalam bahasa Inggris karena itu yang dibaca model.',
  },
  'briefing.doctrine': { en: 'How the team works', id: 'Cara kerja tim' },
  'briefing.craft': { en: 'Craft', id: 'Keahlian' },
  'briefing.done': { en: 'Done means', id: 'Selesai berarti' },
  'briefing.review': { en: 'The reviewer refuses', id: 'Yang ditolak reviewer' },
  'briefing.reading': { en: 'Reading the team playbook…', id: 'Membaca panduan tim…' },
  'briefing.refused': { en: 'Refused in review', id: 'Ditolak saat review' },
  'briefing.refusedLine': {
    en: 'Refused {count} time(s) in review.',
    id: 'Ditolak {count} kali saat review.',
  },
  'briefing.refusedRule': {
    en: 'Rule {rule} most often ({count}×):',
    id: 'Paling sering aturan {rule} ({count}×):',
  },
  'briefing.refusedUnmatched': {
    en: '{count} refusal(s) cited no rule in this pack.',
    id: '{count} penolakan tidak menyebut aturan pak ini.',
  },
  'briefing.error': {
    en: 'Could not read the playbook: {message}',
    id: 'Tidak bisa membaca panduan: {message}',
  },
  'activity.collapse': { en: 'Collapse panel', id: 'Ciutkan panel' },

  'cost.emptyInitial': {
    en: 'Finished missions appear here with what each one cost.',
    id: 'Misi yang selesai muncul di sini beserta biayanya.',
  },
  'cost.empty': {
    en: 'Nothing has finished yet. A mission appears here once it is done.',
    id: 'Belum ada yang selesai. Misi muncul di sini setelah selesai.',
  },
  'cost.reading': { en: 'Reading the board…', id: 'Membaca papan…' },
  'cost.error': {
    en: 'Could not read the history: {message}',
    id: 'Tidak bisa membaca riwayat: {message}',
  },
  'cost.errorShort': { en: 'Could not read the history.', id: 'Tidak bisa membaca riwayat.' },
  'cost.day': {
    en: '{tokens} tok · {items} item(s) · {turns} turn(s)',
    id: '{tokens} tok · {items} item · {turns} giliran',
  },
  'cost.across': {
    en: '{tokens} tokens across {items} finished item(s)',
    id: '{tokens} token dari {items} item selesai',
  },
  'cost.split': {
    en: '{tokens} tokens · {input} in / {output} out',
    id: '{tokens} token · {input} masuk / {output} keluar',
  },
  'cost.kindTeam': { en: 'team', id: 'tim' },
  'cost.kindTask': { en: 'task', id: 'task' },

  'task.packChip': { en: '{pack} playbook', id: 'panduan {pack}' },
  'task.packWhy.operator': {
    en: 'The operator chose this playbook for the task.',
    id: 'Operator memilih panduan ini untuk task.',
  },
  'task.packWhy.role': {
    en: "Chosen from the worker's job title.",
    id: 'Dipilih dari jabatan pekerja.',
  },
  'task.packWhy.brief': {
    en: 'Chosen from what the brief is about.',
    id: 'Dipilih dari isi brief.',
  },
  'task.packWhy.default': {
    en: 'Nothing in the brief matched a pack, so it runs the general one.',
    id: 'Tidak ada yang cocok di brief, jadi memakai panduan umum.',
  },
  'task.tagTeam': { en: 'team', id: 'tim' },
  'task.tagSub': { en: 'sub', id: 'sub' },
  'task.meter': { en: 'Token meter', id: 'Meter token' },
  'task.thisTask': { en: 'This task', id: 'Task ini' },
  'task.missionTotal': { en: 'Mission total', id: 'Total misi' },
  'task.topCost': { en: 'top cost', id: 'biaya tertinggi' },

  'hint.drag': { en: 'Drag — orbit', id: 'Seret — putar' },
  'hint.scroll': { en: 'Scroll — zoom', id: 'Gulir — zoom' },
  'hint.pan': { en: 'Shift+drag — pan', id: 'Shift+seret — geser' },
  'hint.click': { en: 'Click a worker', id: 'Klik seorang worker' },

  'settings.title': { en: 'Connection', id: 'Koneksi' },
  'settings.close': { en: 'Close settings', id: 'Tutup pengaturan' },
  'settings.endpoint': { en: 'Endpoint', id: 'Endpoint' },
  'settings.apiKey': { en: 'API key', id: 'API key' },
  'settings.model': { en: 'Model', id: 'Model' },
  'settings.tools': {
    en: 'Give agents sandboxed file & shell access',
    id: 'Beri agen akses file & shell di sandbox',
  },
  'settings.web': {
    en: 'Allow web search & page fetch',
    id: 'Izinkan pencarian web & ambil halaman',
  },
  'settings.demo': {
    en: 'Demo mode (scripted workers, no API calls)',
    id: 'Mode demo (worker skrip, tanpa panggilan API)',
  },
  'settings.workspace': { en: 'Workspace folder', id: 'Folder kerja' },
  'settings.browse': { en: 'Browse…', id: 'Telusuri…' },
  'settings.parent': { en: 'Parent folder', id: 'Folder induk' },
  'settings.useFolder': { en: 'Use this folder', id: 'Pakai folder ini' },
  'settings.workspaceHint': {
    en: 'Agents can read and write files only inside this folder.',
    id: 'Agen hanya bisa membaca dan menulis file di dalam folder ini.',
  },
  'settings.disconnect': { en: 'Disconnect', id: 'Putuskan' },
  'settings.connect': { en: 'Connect', id: 'Hubungkan' },
  'settings.note': {
    en: 'Keys stay in server memory for this session only — they are never written to disk and never sent to the browser.',
    id: 'Key hanya disimpan di memori server selama sesi ini — tidak pernah ditulis ke disk dan tidak dikirim ke browser.',
  },
  'settings.language': { en: 'Language', id: 'Bahasa' },
  'settings.languageHint': {
    en: 'The team writes its notes and summaries in this language.',
    id: 'Tim menulis catatan dan ringkasannya dalam bahasa ini.',
  },
  'settings.noSubfolders': { en: 'No sub-folders here.', id: 'Tidak ada sub-folder di sini.' },
  'settings.cannotRead': { en: 'Cannot read that folder.', id: 'Tidak bisa membaca folder itu.' },
  'settings.workspaceSet': {
    en: 'Agents now work inside {path}.',
    id: 'Agen sekarang bekerja di dalam {path}.',
  },
  'settings.webOn': {
    en: 'Web access on — agents can search and fetch pages.',
    id: 'Akses web aktif — agen bisa mencari dan mengambil halaman.',
  },
  'settings.webOff': { en: 'Web access off.', id: 'Akses web nonaktif.' },
  'settings.pasteKey': { en: 'Paste an API key first.', id: 'Tempel API key dulu.' },
  'settings.connecting': { en: 'Connecting…', id: 'Menghubungkan…' },
  'settings.connectionFailed': { en: 'Connection failed', id: 'Koneksi gagal' },
  'settings.disconnected': {
    en: 'Disconnected — the office is running in demo mode.',
    id: 'Terputus — kantor berjalan dalam mode demo.',
  },
  'settings.cannotUse': { en: 'Cannot use that folder.', id: 'Tidak bisa memakai folder itu.' },
  'settings.cannotChangeWeb': {
    en: 'Cannot change web access.',
    id: 'Tidak bisa mengubah akses web.',
  },
  'settings.freeTier': { en: 'Free tier — {model}', id: 'Tier gratis — {model}' },
  'settings.freeHint': {
    en: 'Free model: {model} — used automatically if the selected model runs out of credit.',
    id: 'Model gratis: {model} — dipakai otomatis jika model pilihan kehabisan kredit.',
  },

  // ── activity log ────────────────────────────────────────────────────────
  // The English column is the exact line the server writes, so a log entry
  // stays readable to scripts while the browser can show it in Indonesian.

  'log.session.connectFailed': {
    en: 'Could not connect to {endpoint}: {detail}',
    id: 'Tidak bisa terhubung ke {endpoint}: {detail}',
  },
  'log.session.demoBoot': {
    en: 'Demo mode is on — workers reply with scripted lines, no model calls.',
    id: 'Mode demo aktif — worker menjawab dengan kalimat skrip, tanpa panggilan model.',
  },
  'log.session.demoOn': { en: 'Demo mode enabled.', id: 'Mode demo diaktifkan.' },
  'log.session.demoOff': { en: 'Demo mode disabled.', id: 'Mode demo dinonaktifkan.' },
  'log.session.connected': {
    en: 'Connected to {endpoint} ({count} models).',
    id: 'Terhubung ke {endpoint} ({count} model).',
  },
  'log.session.failed': {
    en: 'Connection failed: {detail}',
    id: 'Koneksi gagal: {detail}',
  },
  'log.workspace.changed': {
    en: 'Workspace folder set to {path}.',
    id: 'Folder kerja diatur ke {path}.',
  },
  'log.agent.joined': { en: '{name} joined the office.', id: '{name} bergabung di kantor.' },
  'log.agent.stepReply': {
    en: '{name} · step {step} · reply',
    id: '{name} · langkah {step} · membalas',
  },
  'log.agent.step': {
    en: '{name} · step {step} · {actions}',
    id: '{name} · langkah {step} · {actions}',
  },
  'log.agent.action': {
    en: '{name} → {action}: {summary}',
    id: '{name} menjalankan {action}: {summary}',
  },
  'log.agent.remedy': {
    en: "{name}'s command was refused — ran {tool} instead.",
    id: 'Perintah {name} ditolak — menjalankan {tool} sebagai gantinya.',
  },
  'log.agent.loop': {
    en: '{name} repeated {action} — asking for a new approach.',
    id: '{name} mengulangi {action} — meminta pendekatan lain.',
  },
  'log.agent.error': {
    en: '{name} hit an error: {detail}',
    id: '{name} mengalami error: {detail}',
  },
  'log.agent.toolsUnsupported': {
    en: 'This endpoint does not support native tool calls — using the JSON action protocol.',
    id: 'Endpoint ini tidak mendukung pemanggilan tool native — memakai protokol aksi JSON.',
  },
  'log.chat.received': { en: '{name} received a message.', id: '{name} menerima pesan.' },
  'log.task.added': {
    en: 'Task "{title}" added to the board.',
    id: 'Task "{title}" ditambahkan ke papan.',
  },
  'log.task.created': { en: 'New task "{title}".', id: 'Task baru "{title}".' },
  'log.task.createdAssigned': {
    en: 'New task "{title}" → {assignee}.',
    id: 'Task baru "{title}" → {assignee}.',
  },
  'log.task.reviewed': {
    en: "Reviewer accepted {name}'s change.",
    id: 'Reviewer menerima perubahan {name}.',
  },
  'log.task.reviewUnreadable': {
    en: "The reviewer's reply could not be read — the checks stand, so the task continues.",
    id: 'Balasan reviewer tidak bisa dibaca — check tetap berlaku, tugas dilanjutkan.',
  },
  'log.task.reviewCapped': {
    en: "Reviewer still refuses {name}'s change after {attempt} attempt(s) — accepting with a note.",
    id: 'Reviewer masih menolak perubahan {name} setelah {attempt} percobaan — diterima dengan catatan.',
  },
  'log.task.reviewRefused': {
    en: "Reviewer refused {name}'s change — sending it back (attempt {attempt}/{total}).",
    id: 'Reviewer menolak perubahan {name} — dikembalikan (percobaan {attempt}/{total}).',
  },
  'log.task.reviewFailed': {
    en: 'The reviewer could not run ({reason}) — the checks stand.',
    id: 'Reviewer tidak bisa berjalan ({reason}) — check tetap berlaku.',
  },
  'log.task.visionSkipped': {
    en: 'Skipped the visual critic: {source} is not an image.',
    id: 'Kritik visual dilewati: {source} bukan gambar.',
  },
  'log.task.visionAccepted': {
    en: 'Visual critic accepted {source}.',
    id: 'Kritik visual menerima {source}.',
  },
  'log.task.visionUnreadable': {
    en: 'The visual critic replied in a shape that could not be read — the checks stand.',
    id: 'Balasan kritik visual tidak bisa dibaca — check tetap berlaku.',
  },
  'log.task.visionCapped': {
    en: 'Visual critic still refuses {source} after {attempt} attempt(s) — accepting with a note.',
    id: 'Kritik visual masih menolak {source} setelah {attempt} percobaan — diterima dengan catatan.',
  },
  'log.task.visionRefused': {
    en: 'Visual critic refused {source} — sending it back (attempt {attempt}/{total}).',
    id: 'Kritik visual menolak {source} — dikembalikan (percobaan {attempt}/{total}).',
  },
  'log.task.visionFailed': {
    en: 'The visual critic could not run ({reason}) — the checks stand.',
    id: 'Kritik visual tidak bisa berjalan ({reason}) — check tetap berlaku.',
  },
  'log.agent.outputShape': {
    en: 'Tool result shape: {details}.',
    id: 'Bentuk hasil tool: {details}.',
  },
  'log.agent.contract': {
    en: 'Tool result contract: {details}.',
    id: 'Kontrak hasil tool: {details}.',
  },
  'log.task.mergeChanged': {
    en: "{name}'s verified files changed before it could finish — checking again.",
    id: 'File terverifikasi milik {name} berubah sebelum selesai — diperiksa ulang.',
  },
  'log.task.worktreeStarted': {
    en: '"{title}" works in its own copy of the folder; its changes land when the checks pass.',
    id: '"{title}" bekerja di salinan foldernya sendiri; perubahannya masuk saat check lulus.',
  },
  'log.task.sharedFolder': {
    en: 'No separate copy of the folder: {reason}. Tasks share it as before.',
    id: 'Tanpa salinan folder terpisah: {reason}. Task berbagi folder seperti sebelumnya.',
  },
  'log.task.landed': {
    en: 'Work landed in the folder: {files}.',
    id: 'Pekerjaan masuk ke folder: {files}.',
  },
  'log.task.waiting': {
    en: '"{title}" waits for {blockers}.',
    id: '"{title}" menunggu {blockers}.',
  },
  'log.task.ready': {
    en: '"{title}" is ready — {name} starts now.',
    id: '"{title}" siap — {name} mulai sekarang.',
  },
  'log.task.readyUnassigned': {
    en: '"{title}" is ready — unassigned.',
    id: '"{title}" siap — belum ada pemilik.',
  },
  'log.task.queued': {
    en: '{name} is busy — "{title}" is queued (position {position}).',
    id: '{name} masih sibuk — "{title}" masuk antrean (posisi {position}).',
  },
  'log.task.started': {
    en: '{name} started "{title}".',
    id: '{name} mulai mengerjakan "{title}".',
  },
  'log.task.packOperator': {
    en: '{name} runs "{title}" under the {pack} playbook: the operator chose it.',
    id: '{name} mengerjakan "{title}" dengan panduan {pack}: operator yang memilih.',
  },
  'log.task.packRole': {
    en: '{name} runs "{title}" under the {pack} playbook: the job title chose it.',
    id: '{name} mengerjakan "{title}" dengan panduan {pack}: jabatannya yang memilih.',
  },
  'log.task.packBrief': {
    en: '{name} runs "{title}" under the {pack} playbook: the brief points there ({evidence}).',
    id: '{name} mengerjakan "{title}" dengan panduan {pack}: brief mengarah ke sana ({evidence}).',
  },
  'log.task.packBriefTie': {
    en: '{name} runs "{title}" under the {pack} playbook: the brief points there ({evidence}); {also} also fits.',
    id: '{name} mengerjakan "{title}" dengan panduan {pack}: brief mengarah ke sana ({evidence}); {also} juga cocok.',
  },
  'log.task.packDefault': {
    en: '{name} runs "{title}" under the {pack} playbook: no signal matched, so it falls back to the general pack.',
    id: '{name} mengerjakan "{title}" dengan panduan {pack}: tidak ada sinyal yang cocok, jadi memakai panduan umum.',
  },
  'log.task.resumed': {
    en: 'Picking up the queued task "{title}".',
    id: 'Melanjutkan task dalam antrean "{title}".',
  },
  'log.task.interrupted': {
    en: '{count} task(s) were interrupted by a restart — they are blocked and their notes are kept.',
    id: '{count} task terputus karena restart — task tersebut terblokir dan catatannya tetap disimpan.',
  },
  'log.task.budget': {
    en: 'Mission budget reached ({spent}/{budget} tokens) — stopping for a human.',
    id: 'Anggaran misi tercapai ({spent}/{budget} token) — berhenti menunggu manusia.',
  },
  'log.task.nudged': {
    en: '{name} stopped without finishing — asked it to complete the task or hand it off.',
    id: '{name} berhenti sebelum selesai — diminta menuntaskan task atau menyerahkannya.',
  },
  'log.task.loop': {
    en: '{name} stopped after repeating {action} — the turn hit a loop.',
    id: '{name} berhenti setelah mengulangi {action} — giliran ini masuk loop.',
  },

  'log.task.blocked': {
    en: '{name} could not finish the task — it is blocked ({reason}).',
    id: '{name} tidak bisa menyelesaikan task — task terblokir ({reason}).',
  },
  'log.task.done': {
    en: '{name} finished "{title}".',
    id: '{name} menyelesaikan "{title}".',
  },
  'log.task.checkpoint': {
    en: 'Checkpoint {ref} taken before "{title}".',
    id: 'Checkpoint {ref} dibuat sebelum "{title}".',
  },
  'log.task.checkpointSkipped': {
    en: 'No checkpoint: {detail}.',
    id: 'Tanpa checkpoint: {detail}.',
  },
  'log.task.evidence': {
    en: '{name} reported done without changing anything — asking for evidence.',
    id: '{name} melapor selesai tanpa mengubah apa pun — meminta bukti.',
  },
  'log.task.verified': { en: 'Checks passed: {names}.', id: 'Cek lulus: {names}.' },
  'log.task.accepted': {
    en: 'Nothing to check in this folder — accepted.',
    id: 'Tidak ada yang bisa dicek di folder ini — diterima.',
  },
  'log.task.unverified': {
    en: '{name} finished, but checks still fail after {count} repair attempt(s).',
    id: '{name} selesai, tapi cek masih gagal setelah {count} percobaan perbaikan.',
  },
  'log.task.reopened': {
    en: '{name} said the task was done, but a check failed — sending it back (attempt {attempt}/{total}).',
    id: '{name} menyatakan task selesai, tapi ada cek yang gagal — dikembalikan (percobaan {attempt}/{total}).',
  },
  'log.task.diff': {
    en: "{name}'s changes — {detail}",
    id: 'Perubahan {name} — {detail}',
  },
  'log.task.cleanup': {
    en: '{name} finished with {count} scratch file(s) still in the folder — sent back to delete them.',
    id: '{name} selesai dengan {count} file sementara yang masih ada di folder — dikembalikan untuk dihapus.',
  },
  'log.task.cleanupAccepted': {
    en: '{name} left {count} scratch file(s) behind — recorded in the task notes.',
    id: '{name} meninggalkan {count} file sementara — dicatat di catatan task.',
  },
  'log.task.reverted': {
    en: '{name} reverted this turn — the folder is back to its state at turn start.',
    id: '{name} membatalkan giliran ini — folder kembali ke kondisi awal giliran.',
  },
  'log.task.revertFailed': {
    en: '{name} could not revert this turn: {detail}',
    id: '{name} tidak bisa membatalkan giliran ini: {detail}',
  },
  'log.task.regressed': {
    en: '{name} broke {files} — restored the folder to the last verified state.',
    id: '{name} merusak {files} — folder dipulihkan ke kondisi terverifikasi terakhir.',
  },
  'log.task.restoreFailed': {
    en: 'Could not restore the last verified state: {detail}',
    id: 'Tidak bisa memulihkan kondisi terverifikasi terakhir: {detail}',
  },
  'log.task.revertSkipped': {
    en: 'A teammate is writing in this folder — repairing on the current tree instead of reverting.',
    id: 'Rekan sedang menulis di folder ini — memperbaiki di kondisi sekarang tanpa membatalkan.',
  },
  'log.snapshot.failed': {
    en: 'No per-turn undo: {detail}.',
    id: 'Tidak ada undo per giliran: {detail}.',
  },
  'log.memory.saved': {
    en: 'Remembered {count} fact(s) about this folder for the next mission.',
    id: 'Mengingat {count} fakta tentang folder ini untuk misi berikutnya.',
  },
  'log.memory.failed': {
    en: 'Could not save project memory: {detail}',
    id: 'Tidak bisa menyimpan memori proyek: {detail}',
  },
  'log.mission.started': {
    en: 'Mission "{title}" handed to {lead} ({role}) — the team works in parallel.',
    id: 'Misi "{title}" diserahkan ke {lead} ({role}) — tim bekerja paralel.',
  },
  'log.mission.waiting': {
    en: '{name} is waiting on {count} teammate(s) before reconciling.',
    id: '{name} menunggu {count} rekan sebelum merekonsiliasi.',
  },
  'log.mission.synthesis': {
    en: 'All {count} subtask(s) settled — the lead is reconciling the result.',
    id: 'Semua {count} subtask sudah selesai — lead sedang merekonsiliasi hasilnya.',
  },
  'log.model.retry': {
    en: 'The endpoint failed ({detail}) — retrying this step once.',
    id: 'Endpoint gagal ({detail}) — mencoba langkah ini sekali lagi.',
  },
  'log.model.fallback': {
    en: 'Model "{model}" failed ({detail}) — falling back to {fallback}.',
    id: 'Model "{model}" gagal ({detail}) — beralih ke {fallback}.',
  },
  'log.model.active': {
    en: 'Now running on the free model {model}.',
    id: 'Sekarang berjalan di model gratis {model}.',
  },

  // ── task notes ──────────────────────────────────────────────────────────
  // Only the notes the office writes itself; a note an agent authored is the
  // agent's own wording and is shown as written.

  'note.restart': {
    en: 'The office restarted while this task was running, so nothing is working on it now. Start it again to continue from these notes.',
    id: 'Kantor restart saat task ini berjalan, jadi tidak ada yang mengerjakannya sekarang. Jalankan lagi untuk melanjutkan dari catatan ini.',
  },
  'note.evidenceGate': {
    en: 'The gate asked for evidence: no file changed and the folder has no check.',
    id: 'Gate meminta bukti: tidak ada file yang berubah dan folder ini tidak punya cek.',
  },
  'note.checkpointDiff': {
    en: 'Changes since checkpoint {ref}:\n{summary}',
    id: 'Perubahan sejak checkpoint {ref}:\n{summary}',
  },
  'note.cleanup': {
    en: 'The gate asked for cleanup: these scratch files were still in the folder: {files}',
    id: 'Gate meminta pembersihan: file sementara ini masih ada di folder: {files}',
  },
  'note.cleanupAccepted': {
    en: 'Leftover scratch files were accepted after {attempts} cleanup request(s): {files}',
    id: 'File sementara yang tersisa diterima setelah {attempts} permintaan pembersihan: {files}',
  },
} as const satisfies Record<string, { en: string; id: string }>;

export type MessageKey = keyof typeof STRINGS;

/** Every key the dictionary knows, for checks and the DOM translator. */
export function messageKeys(): MessageKey[] {
  return Object.keys(STRINGS) as MessageKey[];
}

/** True for a key this dictionary actually has, so a DOM attribute is safe. */
export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(STRINGS, value);
}

/** Both translations for one key, so a check can compare the two columns. */
export function messages(): Record<MessageKey, { en: string; id: string }> {
  return STRINGS;
}

let activeLocale: Locale = 'en';

export function setLocale(locale: Locale): void {
  activeLocale = locale;
}

export function getLocale(): Locale {
  return activeLocale;
}

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'id';
}

/**
 * Looks a message up. `{name}` placeholders are filled from `params`; a missing
 * parameter is left visible on purpose rather than printed as `undefined`.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const entry = STRINGS[key];
  const template = entry[activeLocale];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
