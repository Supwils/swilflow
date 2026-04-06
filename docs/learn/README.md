# Swil Flow - Learning Guide

A deep-dive into how this app works, from architecture to implementation details.

Read these in order -- each doc builds on concepts from the previous one.

## Table of Contents

| # | Topic | What You'll Learn |
|---|-------|-------------------|
| [01](./01-architecture-overview.md) | **Architecture Overview** | Folder structure, the 4 managers, startup sequence, `Arc<Mutex<T>>` |
| [02](./02-tauri-command-event.md) | **Tauri Command-Event** | How Rust and TypeScript talk to each other, auto-generated bindings, settingUpdaters pattern |
| [03](./03-audio-pipeline.md) | **Audio Pipeline** | Full call stack: hotkey press → recording → VAD → transcription → text output |
| [04](./04-smart-paste.md) | **Smart Paste** | Focus detection via macOS Accessibility API, 4 detection strategies, the paste() rewrite |
| [05](./05-accent-color-system.md) | **Accent Color System** | CSS variables, light/dark mode, cross-window sync, optimistic updates |
| [06](./06-history-export.md) | **History & Export** | SQLite schema, migrations, CSV/MD/JSON export, retention |
| [07](./07-rust-ffi-macos.md) | **Rust FFI & macOS APIs** | `unsafe`, CoreFoundation types, memory management, the Create Rule |

## Which Feature Docs Cover My Work?

| Doc | Original Handy | My Addition |
|-----|---------------|-------------|
| 01 Architecture | The entire architecture | Understanding it |
| 02 Command-Event | The pattern | Added `changeAccentColorSetting` command |
| 03 Audio Pipeline | The full pipeline | Understanding it; modified the paste output stage |
| 04 Smart Paste | `paste()` function existed | **Designed and implemented**: focus detection, smart branching |
| 05 Accent Color | Default pink theme | **Designed and implemented**: 7-color system, light/dark, cross-window |
| 06 History & Export | Basic history storage | **Implemented**: CSV/MD/JSON export with filters |
| 07 Rust FFI | None (no raw FFI) | **Implemented**: `focus_detection.rs` with macOS Accessibility API |
