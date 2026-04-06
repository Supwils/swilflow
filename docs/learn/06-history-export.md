# 06 - History & Export

> How transcription history is stored in SQLite, and how export works.

---

## Overview

Every time you transcribe audio, the app saves a record to a local SQLite database. This includes the original text, any post-processed text, the prompt used for post-processing, and a link to the saved WAV audio file.

```
Transcription complete
    |
    v
HistoryManager::save_entry()
    |
    |-- Insert row into SQLite
    |-- Audio WAV already saved to recordings/ folder
    |
    v
User can later:
    |-- View history in settings
    |-- Export as CSV / Markdown / JSON
    |-- Delete entries
    |-- Re-transcribe from saved audio
```

---

## The Database

### Where it lives

```
[App Data Directory]/
├── settings_store.json     # App settings (tauri-plugin-store)
├── history.db              # SQLite database
└── recordings/
    ├── 2026-04-02_14-30-22.wav
    ├── 2026-04-02_15-10-05.wav
    └── ...
```

In portable mode, this is `src-tauri/target/debug/Data/`.

### Schema

The database uses migration-based schema management (rusqlite-migration). There are 4 migrations that ran in sequence:

```sql
-- Migration 1: Initial table
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    timestamp INTEGER NOT NULL,  -- Unix timestamp
    saved INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    transcription_text TEXT NOT NULL DEFAULT ''
);

-- Migration 2: Add post-processed text
ALTER TABLE history ADD COLUMN post_processed_text TEXT;

-- Migration 3: Add the prompt that was used
ALTER TABLE history ADD COLUMN post_process_prompt TEXT;

-- Migration 4: Add whether post-processing was requested
ALTER TABLE history ADD COLUMN post_process_requested INTEGER DEFAULT 0;
```

### What each column means

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER | Auto-increment primary key |
| `file_name` | TEXT | WAV file name (e.g., `2026-04-02_14-30-22.wav`) |
| `timestamp` | INTEGER | Unix timestamp when recording was made |
| `saved` | INTEGER | 1 = user marked as "saved" (won't auto-delete) |
| `title` | TEXT | Optional user-given title |
| `transcription_text` | TEXT | Raw transcription from ASR engine |
| `post_processed_text` | TEXT | Text after LLM post-processing (nullable) |
| `post_process_prompt` | TEXT | The prompt used for post-processing (nullable) |
| `post_process_requested` | INTEGER | 1 = user requested post-processing |

---

## HistoryManager (Rust)

```
File: src-tauri/src/managers/history.rs
```

### Initialization

```rust
impl HistoryManager {
    pub fn new(app_handle: &AppHandle) -> Result<Self, String> {
        // 1. Determine database path (portable-aware)
        let db_path = get_data_dir(app_handle).join("history.db");

        // 2. Open SQLite connection
        let mut conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open history database: {}", e))?;

        // 3. Run migrations (creates tables if first run, adds columns if upgrading)
        migrations.to_latest(&mut conn)
            .map_err(|e| format!("Failed to run migrations: {}", e))?;

        Ok(Self { conn: Mutex::new(conn), ... })
    }
}
```

**Migrations** are idempotent -- they track which ones have already run. So upgrading from v0.8.0 to v0.8.2 automatically adds the new columns without losing data.

### Saving an entry

```rust
pub fn save_entry(
    &self,
    file_name: String,
    transcription_text: String,
    post_process: bool,
    post_processed_text: Option<String>,
    post_process_prompt: Option<String>,
) -> Result<(), String> {
    let conn = self.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO history (file_name, timestamp, transcription_text, \
         post_process_requested, post_processed_text, post_process_prompt) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            file_name,
            chrono::Utc::now().timestamp(),
            transcription_text,
            post_process as i32,
            post_processed_text,
            post_process_prompt,
        ],
    ).map_err(|e| format!("Failed to save history entry: {}", e))?;

    // Emit event so frontend can refresh
    self.app_handle.emit("history-updated", ()).ok();

    // Enforce history limit (delete old entries beyond the limit)
    self.enforce_limit()?;

    Ok(())
}
```

### Where save_entry is called

```
File: src-tauri/src/actions.rs (lines 565-574)

// Inside TranscribeAction::stop(), after transcription completes:
if wav_saved {
    if let Err(err) = hm.save_entry(
        file_name,
        transcription,          // Raw ASR output
        post_process,           // Was post-processing requested?
        processed.post_processed_text.clone(),
        processed.post_process_prompt.clone(),
    ) {
        error!("Failed to save history entry: {}", err);
    }
}
```

Note: history is only saved if the WAV file was successfully written. If audio saving fails, no history entry is created.

---

## Export System

### Three formats

| Format | Extension | Best for |
|--------|-----------|----------|
| CSV | `.csv` | Spreadsheet analysis (Excel, Google Sheets) |
| Markdown | `.md` | Documentation, readable format |
| JSON | `.json` | Programmatic processing, data interchange |

### Three filter modes

| Filter | What it exports |
|--------|----------------|
| `All` | Every entry in the database |
| `TimeRange` | Entries within a date range (last 7d, 30d, 3 months) |
| `SelectedIds` | Specific entries selected by the user |

### Backend: export_history command

```rust
// File: src-tauri/src/commands/history.rs

#[tauri::command]
#[specta::specta]
pub async fn export_history(
    app: AppHandle,
    path: String,           // Where to save the file
    format: ExportFormat,   // Csv | Markdown | Json
    filter: ExportFilter,   // All | TimeRange { from, to } | SelectedIds { ids }
) -> Result<u32, String> {
    let hm = app.state::<Arc<HistoryManager>>();

    // 1. Query entries based on filter
    let entries = match filter {
        ExportFilter::All => hm.get_all_entries()?,
        ExportFilter::TimeRange { from_timestamp, to_timestamp } =>
            hm.get_entries_in_range(from_timestamp, to_timestamp)?,
        ExportFilter::SelectedIds { ids } =>
            hm.get_entries_by_ids(&ids)?,
    };

    let count = entries.len() as u32;

    // 2. Format and write to file
    let content = match format {
        ExportFormat::Csv => format_as_csv(&entries),
        ExportFormat::Markdown => format_as_markdown(&entries),
        ExportFormat::Json => format_as_json(&entries),
    };

    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write export file: {}", e))?;

    Ok(count)  // Return number of exported entries
}
```

### Frontend: ExportPanel.tsx

```tsx
// File: src/components/settings/history/ExportPanel.tsx

const handleExport = async () => {
    // 1. Open system save dialog
    const filePath = await save({
        defaultPath: `swilflow-export-${dateStr}.${ext}`,
        filters: [{ name: formatLabel, extensions: [ext] }],
    });

    if (!filePath) return;  // User cancelled

    // 2. Build the filter object
    const filter = buildFilter();
    //   "all"       → { type: "All" }
    //   "timeRange" → { type: "TimeRange", from_timestamp: ..., to_timestamp: ... }
    //   "selected"  → { type: "SelectedIds", ids: [...] }

    // 3. Call Rust backend
    const result = await commands.exportHistory(filePath, format, filter);

    if (result.status === "ok") {
        toast.success(`Exported ${result.data} entries`);
    }
};
```

---

## The History Settings UI

```
File: src/components/settings/history/HistorySettings.tsx

The history page shows:
  1. A list of past transcriptions (newest first)
  2. Each entry shows: timestamp, transcription text, post-processed text (if any)
  3. Actions: delete entry, play audio, re-transcribe
  4. Export panel (format selector + filter options + export button)
```

---

## Retention & Cleanup

The app enforces a history limit (default: 5 entries). When a new entry is saved:

```rust
fn enforce_limit(&self) -> Result<(), String> {
    let limit = self.settings.history_limit;

    // Count entries
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM history", [], |row| row.get(0))?;

    if count > limit as i64 {
        // Delete oldest entries beyond the limit (but keep "saved" ones)
        conn.execute(
            "DELETE FROM history WHERE id IN (
                SELECT id FROM history
                WHERE saved = 0
                ORDER BY timestamp ASC
                LIMIT ?1
            )",
            params![count - limit as i64],
        )?;

        // Also delete the associated WAV files
        // ...
    }
    Ok(())
}
```

**Important**: Entries marked as "saved" (`saved = 1`) are never auto-deleted. Only unsaved entries are cleaned up when the limit is exceeded.

Audio files (WAV) have their own retention period (`recording_retention_period`), separate from the database entries.

---

## What You Should Be Able to Explain

1. **"How is transcription history stored?"**
   → SQLite database with migration-based schema management. Each entry stores the raw transcription, optional post-processed text, the post-processing prompt, timestamp, and a reference to the audio WAV file.

2. **"How does export work?"**
   → The frontend presents format (CSV/MD/JSON) and filter (all/time range/selected) options. When the user clicks export, it calls a Tauri command that queries SQLite with the filter, formats the results, and writes to a file path chosen via the system save dialog.

3. **"What about data cleanup?"**
   → Configurable history limit (default 5). Old unsaved entries are automatically deleted when the limit is exceeded. User-saved entries are exempt. Audio files have a separate retention period.

---

## Next: [07 - Rust FFI and macOS APIs](./07-rust-ffi-macos.md)
