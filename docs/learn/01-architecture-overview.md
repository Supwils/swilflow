# 01 - Architecture Overview

> How the whole app is structured, from launch to ready.

---

## What is Tauri?

Tauri is a framework for building desktop apps. Think of it as two halves glued together:

```
+--------------------------------------------------+
|  Your Desktop App Window                          |
|                                                   |
|  +---------------------------------------------+ |
|  |  FRONTEND (WebView)                          | |
|  |  React + TypeScript + Tailwind               | |
|  |  Runs in a browser engine (WebKit on macOS)  | |
|  |  Handles all UI rendering                    | |
|  +---------------------------------------------+ |
|                     |                             |
|              Tauri Commands / Events              |
|                     |                             |
|  +---------------------------------------------+ |
|  |  BACKEND (Rust native process)               | |
|  |  Has full access to OS, files, hardware      | |
|  |  Audio recording, model inference, clipboard | |
|  +---------------------------------------------+ |
+--------------------------------------------------+
```

The frontend is just a webpage. It can't access the microphone, file system, or clipboard directly. Every time it needs something from the OS, it calls a **Tauri command** -- which is a Rust function decorated with `#[tauri::command]`.

The backend can also **push events** to the frontend (e.g., "mic level changed", "model download progress").

---

## Folder Structure

```
swilflow/
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml                # Rust dependencies
│   ├── tauri.conf.json           # App config (window size, permissions, etc.)
│   └── src/
│       ├── main.rs               # Process entry point (just calls lib.rs)
│       ├── lib.rs                # Real entry: setup Tauri, register commands, init managers
│       ├── actions.rs            # Recording lifecycle (start/stop/cancel)
│       ├── clipboard.rs          # Text output (paste, clipboard)
│       ├── focus_detection.rs    # macOS Accessibility API (our addition)
│       ├── input.rs              # Keyboard simulation (Enigo wrapper)
│       ├── settings.rs           # All settings types + persistence
│       ├── transcription_coordinator.rs  # Serializes recording events
│       ├── managers/
│       │   ├── audio.rs          # Microphone management
│       │   ├── model.rs          # Model download/management
│       │   ├── transcription.rs  # ASR engine wrapper
│       │   └── history.rs        # SQLite history + export
│       ├── audio_toolkit/
│       │   ├── audio/            # Low-level: cpal stream, resampling
│       │   └── vad/              # Voice Activity Detection (Silero)
│       ├── commands/             # Tauri command handlers
│       ├── shortcut/             # Global hotkey system
│       └── overlay.rs            # Recording overlay window
│
├── src/                          # React frontend
│   ├── App.tsx                   # Main component, onboarding flow
│   ├── bindings.ts               # Auto-generated TypeScript types (from Rust)
│   ├── stores/
│   │   └── settingsStore.ts      # Zustand store (single source of truth)
│   ├── hooks/
│   │   ├── useSettings.ts        # Settings hook for components
│   │   └── useModels.ts          # Model management hook
│   ├── components/
│   │   ├── Sidebar.tsx           # Navigation sidebar
│   │   ├── settings/             # 35+ settings components
│   │   ├── onboarding/           # First-run experience
│   │   ├── ui/                   # Reusable UI components
│   │   └── icons/                # SVG icon components
│   ├── overlay/
│   │   ├── RecordingOverlay.tsx   # Separate window shown during recording
│   │   └── RecordingOverlay.css
│   ├── lib/utils/
│   │   └── accentColors.ts       # Theme color system (our addition)
│   └── i18n/                     # Translations
│
└── docs/learn/                   # You are here
```

---

## The Four Managers

The backend is organized around 4 "managers", each responsible for a domain. They're created once at startup and shared across the app via Tauri's state system.

```
lib.rs::initialize_core_logic()
  |
  |-- AudioRecordingManager    (managers/audio.rs)
  |     Controls microphone: start/stop recording, device selection
  |     Manages VAD (voice activity detection)
  |     Two modes: AlwaysOn (mic always open) vs OnDemand (open per recording)
  |
  |-- ModelManager             (managers/model.rs)
  |     Knows which models are available, downloaded, downloading
  |     Handles model downloads with progress events + SHA256 verification
  |     Supports: Whisper, Parakeet, Moonshine, SenseVoice, GigaAM, etc.
  |
  |-- TranscriptionManager     (managers/transcription.rs)
  |     Loads ASR engine, runs inference, returns text
  |     Auto-unloads idle models to save memory (configurable timeout)
  |     Thread-safe: Arc<Mutex<Option<LoadedEngine>>>
  |
  |-- HistoryManager           (managers/history.rs)
        SQLite database for transcription records
        Stores WAV files on disk
        Export to CSV/Markdown/JSON
```

**How managers are shared:**

```rust
// In lib.rs, after creating managers:
app.manage(Arc::new(audio_manager));    // Store in Tauri state
app.manage(Arc::new(model_manager));
app.manage(Arc::new(transcription_manager));
app.manage(Arc::new(history_manager));

// In any command handler, you can access them:
#[tauri::command]
fn some_command(app: AppHandle) {
    let tm = app.state::<Arc<TranscriptionManager>>();
    let result = tm.transcribe(samples);
}
```

This is dependency injection, Tauri-style. Instead of global variables, each manager is wrapped in `Arc` (reference-counted pointer) and stored in Tauri's state container. Any command can request it by type.

---

## Startup Sequence (What happens when you launch the app)

```
1. main.rs
   └── Calls lib.rs::run()

2. lib.rs::run()
   ├── Detect portable mode
   ├── Configure logging
   ├── Register 90+ Tauri commands via collect_commands! macro
   ├── In debug mode: auto-generate TypeScript bindings (src/bindings.ts)
   └── Build and launch Tauri app
       └── .setup() callback runs:

3. initialize_core_logic()
   ├── Create AudioRecordingManager
   ├── Create ModelManager (scans for downloaded models)
   ├── Create TranscriptionManager (starts idle-watcher thread)
   ├── Create HistoryManager (opens/migrates SQLite DB)
   ├── Store all in Tauri state (app.manage())
   ├── Create system tray icon
   ├── Setup Unix signal handlers (SIGUSR1/SIGUSR2)
   ├── Create recording overlay window (hidden)
   └── Configure autostart

4. Frontend loads in WebView
   └── App.tsx mounts
       ├── useSettings() hook triggers settingsStore.initialize()
       │   └── Calls commands.getAppSettings() (reads from Rust)
       ├── Check if user is new or returning
       │   ├── New: Show accessibility → model download → done
       │   └── Returning: Skip to "done"
       └── After onboarding "done":
           ├── commands.initializeEnigo()    -- keyboard simulator
           ├── commands.initializeShortcuts() -- global hotkeys
           ├── Refresh audio devices
           └── Apply accent color from settings
```

---

## Key Concept: Why Arc<Mutex<T>>?

You'll see `Arc<Mutex<T>>` everywhere in the Rust code. Here's why:

```rust
Arc<Mutex<TranscriptionManager>>
│    │
│    └── Mutex: Only one thread can access the inner value at a time
│              (prevents data races)
│
└── Arc: "Atomically Reference Counted"
         Multiple owners can hold a pointer to the same data
         The data is freed when the last owner drops it
```

Tauri runs commands on multiple threads. If two commands try to modify the same manager simultaneously, you'd get a data race. `Mutex` prevents this by requiring `lock()` before access. `Arc` lets multiple commands share the same manager instance.

**Simple analogy:** `Arc` is the key card that lets many people know the room exists. `Mutex` is the lock on the door -- only one person inside at a time.

---

## Key Concept: The Overlay is a Separate Window

This is important and easy to miss. The recording overlay (the bar that shows "Recording..." or "Transcribing...") is **not** part of the main window. It's a separate Tauri WebView window with its own DOM, its own CSS, its own JavaScript.

This means:
- CSS variables set in the main window don't exist in the overlay
- The overlay needs its own initialization code
- Communication happens via Tauri events, not React state

```
Main Window (React)                Overlay Window (React)
┌─────────────────────┐           ┌──────────────────┐
│  App.tsx             │           │  RecordingOverlay │
│  settingsStore       │           │  .tsx             │
│  All settings UI     │           │                  │
│                      │  events   │  Mic level bars  │
│  initAccentColor()   │ ──────── │  initAccentColor()│
│  (reads settings)    │           │  (reads settings │
│                      │           │   independently) │
└─────────────────────┘           └──────────────────┘
```

Both windows must independently read settings from Rust and apply them.

---

## Files to Read First

If you want to understand this codebase, read in this order:

1. **`src-tauri/src/settings.rs`** -- All the types and settings. This tells you what the app can do.
2. **`src-tauri/src/lib.rs`** -- How everything gets wired together at startup.
3. **`src-tauri/src/actions.rs`** -- The core recording flow (start → record → stop → transcribe → paste).
4. **`src/stores/settingsStore.ts`** -- How the frontend manages state.
5. **`src/App.tsx`** -- How the frontend initializes and routes.

---

## Next: [02 - Tauri Command-Event Pattern](./02-tauri-command-event.md)
