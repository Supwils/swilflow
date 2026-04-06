# 02 - Tauri Command-Event Pattern

> How the React frontend and Rust backend talk to each other.

---

## The Two Directions

Communication between frontend and backend is **asymmetric**:

```
Frontend (TypeScript)                    Backend (Rust)
┌─────────────────────┐                 ┌──────────────────┐
│                     │  ── Command ──> │                  │
│   "Hey Rust, do     │  (request +     │  Process it,     │
│    this thing"      │   wait for      │  return result   │
│                     │   response)     │                  │
│                     │                 │                  │
│   "Something        │  <── Event ──   │  "Hey frontend,  │
│    happened!"       │  (push, no      │   something      │
│                     │   response)     │   changed"       │
└─────────────────────┘                 └──────────────────┘
```

- **Commands**: Frontend asks, backend answers. Like an HTTP request.
- **Events**: Backend pushes, frontend listens. Like a WebSocket message.

---

## Commands: Frontend Calls Rust

### Step 1: Define a command in Rust

```rust
// File: src-tauri/src/commands/mod.rs

#[tauri::command]       // Makes this callable from frontend
#[specta::specta]       // Auto-generates TypeScript types
pub fn get_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    Ok(get_settings(&app))
}
```

The two decorators do different things:
- `#[tauri::command]` registers the function so Tauri knows to route frontend calls to it
- `#[specta::specta]` inspects the function signature and generates TypeScript type definitions

### Step 2: Register the command

```rust
// File: src-tauri/src/lib.rs (line ~327)

let specta_builder = tauri_specta::Builder::<tauri::Wry>::new()
    .commands(tauri_specta::collect_commands![
        commands::get_app_settings,           // <-- registered here
        commands::get_default_settings,
        shortcut::change_accent_color_setting,
        // ... 90+ more commands
    ]);
```

**collect_commands!** is a macro that collects all command functions into a list. If you add a new command but forget to add it here, the frontend can't call it.

### Step 3: Auto-generated TypeScript bindings

When you run `bun run app:dev`, Tauri generates `src/bindings.ts` automatically:

```typescript
// File: src/bindings.ts (auto-generated, ~1000 lines)

export const commands = {
    async getAppSettings(): Promise<Result<AppSettings, string>> {
        try {
            return { status: "ok", data: await TAURI_INVOKE("get_app_settings") };
        } catch (e) {
            if (e instanceof Error) throw e;
            else return { status: "error", error: e as any };
        }
    },
    // ... every command gets a TypeScript wrapper
}
```

**Key detail**: The Result type is a tagged union:
```typescript
type Result<T, E> =
    | { status: "ok"; data: T }
    | { status: "error"; error: E }
```

### Step 4: Frontend calls it

```typescript
// File: src/stores/settingsStore.ts

const result = await commands.getAppSettings();
if (result.status === "ok") {
    set({ settings: result.data });
} else {
    console.error("Failed to load settings:", result.error);
}
```

### The full journey of a single command call:

```
1. Frontend:  commands.getAppSettings()
                |
2. bindings.ts: TAURI_INVOKE("get_app_settings")
                |
3. Tauri IPC:   Serializes arguments → sends to Rust process
                |
4. Rust:        get_app_settings(app) runs
                |
5. Rust:        Returns Ok(AppSettings { ... })
                |
6. Tauri IPC:   Serializes result → sends back to WebView
                |
7. bindings.ts: Wraps in { status: "ok", data: ... }
                |
8. Frontend:    result.data is now a typed AppSettings object
```

---

## Commands with Parameters

### Rust side:

```rust
// File: src-tauri/src/shortcut/mod.rs

#[tauri::command]
#[specta::specta]
pub fn change_accent_color_setting(
    app: AppHandle,
    color: settings::AccentColor,    // <-- parameter from frontend
) -> Result<(), String> {
    let mut s = settings::get_settings(&app);
    s.accent_color = color;
    settings::write_settings(&app, s);
    Ok(())
}
```

### TypeScript side (auto-generated):

```typescript
// The Rust enum AccentColor becomes a TypeScript string union:
export type AccentColor = "pink" | "gold" | "orange" | "green" | "blue" | "purple" | "coral"

// The command becomes:
async changeAccentColorSetting(color: string): Promise<Result<null, string>>
```

### Frontend calls it:

```typescript
await commands.changeAccentColorSetting("blue");
```

**The type safety chain**: Rust enum → specta generates TS type → TypeScript compiler enforces it. If you pass `"banana"` as a color, TypeScript catches it at compile time.

---

## Events: Backend Pushes to Frontend

### Rust emits an event:

```rust
// File: src-tauri/src/actions.rs

// Emit event to frontend with typed payload
app.emit("recording-error", RecordingError {
    error_type: "microphone_permission_denied".into(),
    message: "Please grant microphone access".into(),
})
.unwrap_or_else(|e| error!("Failed to emit error: {}", e));
```

### Frontend listens:

```typescript
// File: src/App.tsx

useEffect(() => {
    const unlisten = listen("recording-error", (event) => {
        const error = event.payload as RecordingError;
        toast.error(t(`errors.${error.error_type}`));
    });

    return () => {
        unlisten.then(fn => fn()); // Cleanup on unmount
    };
}, []);
```

### Events used in this app:

| Event Name | Direction | Payload | Purpose |
|------------|-----------|---------|---------|
| `show-overlay` | Rust → Overlay | `{ state: "recording" \| "transcribing" \| "processing" }` | Show recording UI |
| `hide-overlay` | Rust → Overlay | none | Hide recording UI |
| `mic-level` | Rust → Overlay | `number[]` (16 values) | Animate mic bars (~50Hz) |
| `recording-error` | Rust → Main | `{ error_type, message }` | Show error toast |
| `model-state-changed` | Rust → Main | model info | Refresh model list |
| `download-progress` | Rust → Main | `{ model_id, progress, speed }` | Download progress bar |

---

## The settingUpdaters Pattern

This is the cleverest pattern in the frontend. Instead of writing a separate handler for each of the 80+ settings, there's a lookup table:

```typescript
// File: src/stores/settingsStore.ts (lines 77-161)

const settingUpdaters: Record<string, (value: any) => Promise<any>> = {
    always_on_microphone: (value) => commands.updateMicrophoneMode(value),
    audio_feedback: (value) => commands.changeAudioFeedbackSetting(value),
    accent_color: (value) => commands.changeAccentColorSetting(value),
    paste_method: (value) => commands.changePasteMethodSetting(value),
    // ... 80+ entries
};
```

Then the generic `updateSetting` function handles ALL settings the same way:

```typescript
updateSetting: async (key, value) => {
    const previousValue = get().settings?.[key];

    // 1. Optimistic update: change UI immediately
    set({ settings: { ...get().settings!, [key]: value } });

    // 2. Look up the right Tauri command
    const updater = settingUpdaters[key];
    if (!updater) return;

    try {
        // 3. Persist to Rust backend
        await updater(value);
    } catch (error) {
        // 4. Rollback on failure
        set({ settings: { ...get().settings!, [key]: previousValue } });
    }
}
```

**Why this is smart:**
- One function handles 80+ settings
- Optimistic updates make the UI feel instant
- Automatic rollback if the backend rejects the change
- Adding a new setting = add one line to the map + one Rust command

---

## Adding a New Command (Step by Step)

If you wanted to add a new feature, here's the exact process:

### 1. Define the Rust types (if needed)

```rust
// src-tauri/src/settings.rs
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum MyNewEnum {
    OptionA,
    OptionB,
}
```

### 2. Write the command function

```rust
// src-tauri/src/shortcut/mod.rs (or commands/mod.rs)
#[tauri::command]
#[specta::specta]
pub fn change_my_new_setting(app: AppHandle, value: MyNewEnum) -> Result<(), String> {
    let mut s = settings::get_settings(&app);
    s.my_new_setting = value;
    settings::write_settings(&app, s);
    Ok(())
}
```

### 3. Register it in lib.rs

```rust
// src-tauri/src/lib.rs, inside collect_commands!
shortcut::change_my_new_setting,
```

### 4. Run dev server to regenerate bindings

```bash
bun run app:dev
```

This regenerates `src/bindings.ts` with the new command + types.

### 5. Use it in frontend

```typescript
// src/stores/settingsStore.ts
my_new_setting: (value) => commands.changeMyNewSetting(value),
```

---

## Common Pitfalls

### Forgetting to register in collect_commands!
Your Rust code compiles fine, but the frontend can't find the command. You'll get a runtime error like "command not found".

### Type mismatch between Rust and TypeScript
Specta handles this automatically, but if you use `#[serde(rename_all = "lowercase")]` on Rust enums, the TypeScript strings will be lowercase. E.g., Rust `AccentColor::Pink` becomes TypeScript `"pink"`.

### The overlay doesn't get commands automatically
The overlay is a separate window. If you add a new event, you need to add a listener in both `App.tsx` AND `RecordingOverlay.tsx` if both need it.

---

## Next: [03 - Audio Pipeline](./03-audio-pipeline.md)
