# 03 - Audio Pipeline

> The complete journey from "user presses hotkey" to "text appears on screen".

This is the heart of the app. Understanding this call stack means understanding 80% of the codebase.

---

## The Big Picture

```
User presses Option+Space
    |
    v
[Shortcut System]  shortcut/handler.rs
    |
    v
[Coordinator]  transcription_coordinator.rs  (serializes events, prevents races)
    |
    v
[Action: START]  actions.rs::TranscribeAction::start()
    |  - Pre-load ASR model
    |  - Play "start" sound
    |  - Open microphone
    |  - Show overlay
    |
    v
[Recording Loop]  audio_toolkit/audio/recorder.rs
    |  - cpal captures audio frames from microphone
    |  - Resample to 16kHz
    |  - VAD filters out silence
    |  - Voice frames accumulate in buffer
    |
    v
User releases Option+Space (or presses again in toggle mode)
    |
    v
[Action: STOP]  actions.rs::TranscribeAction::stop()
    |  - Stop recording, get audio samples
    |  - Save WAV file to disk
    |  - Send samples to ASR engine
    |
    v
[Transcription]  managers/transcription.rs
    |  - Whisper/Parakeet/etc. inference
    |  - Word correction, hallucination filtering
    |
    v
[Post-Processing]  actions.rs (optional)
    |  - Chinese variant conversion (OpenCC)
    |  - LLM cleanup (Claude/etc.)
    |
    v
[Output]  clipboard.rs::paste()
    |  - Check if text input is focused (our addition!)
    |  - Either paste into input OR copy to clipboard
    |
    v
Text appears for user
```

---

## Stage 1: Shortcut Detection

### Where shortcuts are registered

```
File: src-tauri/src/shortcut/mod.rs

init_shortcuts(app)
  |
  |-- Reads settings.keyboard_implementation
  |     (either "Tauri" or "HandyKeys" backend)
  |
  |-- Registers each binding from settings:
  |     "transcribe"                 → Option+Space (default)
  |     "transcribe_with_post_process" → Ctrl+Option+Space
  |     (cancel is registered dynamically, only while recording)
  |
  |-- All key events route to:
        handler.rs::handle_shortcut_event()
```

### How a key press becomes an action

```rust
// File: src-tauri/src/shortcut/handler.rs (lines 29-70)

pub fn handle_shortcut_event(
    app: &AppHandle,
    binding_id: &str,      // "transcribe" or "transcribe_with_post_process"
    hotkey_string: &str,    // "option+space"
    is_pressed: bool,       // true = key down, false = key up
) {
    // Transcribe bindings go through the coordinator (for debouncing/safety)
    if is_transcribe_binding(binding_id) {
        coordinator.send_input(binding_id, hotkey_string, is_pressed, push_to_talk);
        return;
    }

    // Other bindings (cancel, test) go directly to ACTION_MAP
    if is_pressed {
        action.start(app, binding_id, hotkey_string);
    } else {
        action.stop(app, binding_id, hotkey_string);
    }
}
```

---

## Stage 2: The Coordinator (Race Condition Prevention)

### Why do we need a coordinator?

Imagine: the user rapidly taps the hotkey, or a signal arrives while recording is stopping. Without coordination, you'd get:
- Two recordings starting simultaneously
- A stop arriving before start finishes
- A cancel interrupting mid-transcription

### How it works

```
File: src-tauri/src/transcription_coordinator.rs

The coordinator runs on its own thread with a message queue:

                    mpsc channel
    Key events ──────────────> Coordinator thread
    Signal events ───────────>     |
                                   v
                              Process one at a time
                              (single-threaded queue)
```

```rust
// State machine:
enum Stage {
    Idle,                    // Waiting for input
    Recording(String),       // Recording with binding_id
    Processing,              // Transcribing (can't interrupt)
}
```

### Push-to-Talk vs Toggle Mode

```
Push-to-Talk mode (push_to_talk = true):
  Key DOWN → start recording
  Key UP   → stop recording

Toggle mode (push_to_talk = false):
  Key DOWN (while Idle)      → start recording
  Key DOWN (while Recording) → stop recording
  Key UP   → ignored
```

### Debouncing

```rust
// Lines 61-70: Ignores rapid key repeats within 30ms
let now = Instant::now();
if now.duration_since(last_press) < Duration::from_millis(30) {
    return; // Too fast, probably key repeat
}
```

---

## Stage 3: Recording Starts

### TranscribeAction::start()

```
File: src-tauri/src/actions.rs (lines 364-465)

TranscribeAction::start()
  |
  |-- 1. Pre-load models (async, non-blocking)
  |     TranscriptionManager::initiate_model_load()
  |     Also pre-loads VAD model in separate thread
  |
  |-- 2. Update UI
  |     Change tray icon to "Recording"
  |     Show recording overlay window
  |
  |-- 3. Audio feedback (depends on mic mode)
  |
  |     AlwaysOn mode:                    OnDemand mode:
  |     play_feedback_sound_blocking()    rm.try_start_recording()  ← open mic first
  |     apply_mute()                      wait 100ms
  |     rm.try_start_recording()          play_feedback_sound_blocking()
  |                                       apply_mute()
  |
  |     (OnDemand opens mic before sound so sound doesn't get captured)
  |     (AlwaysOn mic is already open, so play sound first)
  |
  |-- 4. Register cancel shortcut (dynamic)
  |     Escape key registered only while recording
```

### What try_start_recording() does

```
File: src-tauri/src/managers/audio.rs (lines 381-410)

AudioRecordingManager::try_start_recording(binding_id)
  |
  |-- Lock state mutex
  |-- If OnDemand mode: open microphone stream
  |-- Call recorder.start()
  |     |
  |     v
  |   File: audio_toolkit/audio/recorder.rs (line 198-202)
  |   AudioRecorder::start()
  |     |
  |     |-- Send Cmd::Start to worker thread via mpsc channel
  |
  |-- Set state = Recording(binding_id)
  |-- Emit "recording-started" event
```

---

## Stage 4: The Recording Loop (Audio Capture)

This is where audio hardware meets software. There are two threads at play:

```
Thread 1: cpal audio callback          Thread 2: Consumer/processor
(runs at hardware sample rate)         (processes audio chunks)

Microphone hardware
    |
    v
cpal stream callback
    |  - Convert to f32
    |  - Mix channels to mono
    |  - Pack into AudioChunk
    |
    |     mpsc channel
    +────────────────────> run_consumer()
                               |
                               v
                           Resample to 16kHz
                               |
                               v
                           Split into 30ms frames
                               |
                               v
                           VAD: is this speech?
                               |
                           ┌───┴───┐
                           |       |
                         Speech  Silence
                           |       |
                     Append to   Discard
                     buffer
```

### The cpal audio callback

```
File: audio_toolkit/audio/recorder.rs (lines 224-280)

build_stream() creates a cpal stream that:
  1. Gets raw audio from microphone (may be U8, I16, I32, or F32)
  2. Converts everything to f32 normalized [-1.0, 1.0]
  3. If stereo: averages channels to mono
  4. Sends AudioChunk::Samples via channel to consumer thread
```

**Key fact**: The sample rate from the microphone is usually 44100 Hz or 48000 Hz. But Whisper needs 16000 Hz. That's why we resample.

### The consumer thread (run_consumer)

```
File: audio_toolkit/audio/recorder.rs (lines 395-519)

run_consumer() loop:
  |
  |-- Receive AudioChunk from cpal
  |
  |-- Send spectrum data to frontend (for mic level visualization)
  |     app.emit("mic-level", levels)   ← ~50 times per second
  |
  |-- Push samples into FrameResampler
  |     |
  |     v
  |   File: audio_toolkit/audio/resampler.rs
  |   FrameResampler:
  |     - Uses rubato library to resample to 16000 Hz
  |     - Emits exactly 480-sample frames (30ms at 16kHz)
  |     - This is the exact frame size Silero VAD expects
  |
  |-- For each 30ms frame, run VAD:
  |     |
  |     v
  |   handle_frame()
  |     |
  |     v
  |   SmoothedVad::push_frame(samples)
```

### Voice Activity Detection (VAD)

VAD answers one question: "Is someone speaking right now?"

```
File: audio_toolkit/vad/smoothed.rs

SmoothedVad wraps SileroVad with smoothing logic:

Raw VAD output:    [noise][SPEECH][noise][SPEECH][noise][noise][noise]...
                              ^         ^
                        These gaps are probably just pauses between words.
                        Without smoothing, they'd break the transcription.

Smoothed output:   [noise][SPEECH SPEECH SPEECH SPEECH][noise][noise]...
                         ^                        ^
                   onset: 2 frames           hangover: 15 frames
                   (need 2 consecutive        (keep 450ms of trailing
                    voice frames to start)     silence before cutting)
```

```
File: audio_toolkit/vad/silero.rs

SileroVad::push_frame(samples)
  |
  |-- Validate: exactly 480 samples (30ms at 16kHz)
  |-- Run Silero ONNX model: probability = engine.compute(frame)
  |-- If probability > 0.3 → Speech
  |-- If probability <= 0.3 → Noise
```

**The Silero model** (`silero_vad_v4.onnx`) is a small neural network (~2MB) trained to distinguish speech from non-speech audio. It runs inference on every 30ms frame -- about 33 times per second.

---

## Stage 5: Recording Stops

When the user releases the key (push-to-talk) or presses it again (toggle):

```
File: src-tauri/src/actions.rs (lines 467-632)

TranscribeAction::stop()
  |
  |-- 1. Unregister cancel shortcut
  |-- 2. Remove microphone mute
  |-- 3. Play stop feedback sound
  |-- 4. Change tray icon to "Transcribing"
  |-- 5. Show "Transcribing..." overlay
  |
  |-- 6. Spawn async task (with FinishGuard for cleanup):
  |
  |     rm.stop_recording(binding_id) → Vec<f32> (audio samples)
  |       |
  |       |  (This blocks until all audio is drained from the cpal stream)
  |       |
  |       v
  |     In parallel:
  |       ├── Save samples as WAV file to disk
  |       └── tm.transcribe(samples) → String (text)
  |
  |     If no samples → go idle (user probably pressed too quickly)
```

### How stop_recording() retrieves samples

```
File: managers/audio.rs (lines 422-479)

stop_recording(binding_id)
  |
  |-- Set state = Idle
  |-- If extra_recording_buffer_ms > 0: wait that long (captures trailing audio)
  |-- Call recorder.stop() → sends Cmd::Stop to consumer thread
  |     |
  |     v
  |   Consumer thread:
  |     - Sets recording = false
  |     - Sets stop_flag = true (tells cpal callback to send EndOfStream)
  |     - Drains remaining audio from channel until EndOfStream
  |     - Calls frame_resampler.finish() (flushes remaining samples)
  |     - Returns Vec<f32> via reply channel
  |
  |-- If OnDemand mode: close microphone stream
  |-- If samples too short: pad with silence (< 0.1 seconds)
  |-- Return samples
```

---

## Stage 6: Transcription (Speech-to-Text)

```
File: src-tauri/src/managers/transcription.rs (lines 440-735)

TranscriptionManager::transcribe(samples)
  |
  |-- 1. Touch activity timer (prevents idle unload during transcription)
  |
  |-- 2. If no audio → return empty string
  |
  |-- 3. If model still loading → block and wait (condvar)
  |
  |-- 4. Validate language support
  |
  |-- 5. Run engine-specific transcription:
  |     |
  |     |  Whisper:    whisper_engine.transcribe_with(&audio, &params)
  |     |  Parakeet:   parakeet_engine.transcribe_with(&audio, &params)
  |     |  Moonshine:  moonshine_engine.transcribe(&audio)
  |     |  SenseVoice: sense_voice_engine.transcribe_with(&audio, &params)
  |     |  etc.
  |     |
  |     |  All engines use transcribe-rs crate (Rust bindings for ML models)
  |     |  Whisper uses whisper.cpp (C++) with Metal acceleration on macOS
  |
  |-- 6. Apply word corrections
  |     Custom word replacement map (e.g., "typescript" → "TypeScript")
  |     Uses fuzzy matching (strsim crate) with configurable threshold
  |
  |-- 7. Filter hallucinations
  |     Remove known Whisper artifacts like "[BLANK_AUDIO]", "(music)", etc.
  |
  |-- 8. Maybe unload model immediately (if setting = Immediately)
  |
  |-- 9. Return transcription text
```

### Model idle unloading

```
TranscriptionManager starts a watcher thread on creation.

Every 10 seconds:
  if (now - last_activity) > timeout_setting:
    unload model from memory

Timeout options: Never, Immediately, 2/5/10/15/30min, 1hour

Why: ML models use 200MB-2GB RAM. If you're not transcribing,
     there's no reason to keep them loaded.
```

---

## Stage 7: Post-Processing (Optional)

```
File: src-tauri/src/actions.rs (lines 324-362)

process_transcription_output(app, &transcription, post_process)
  |
  |-- 1. Chinese variant conversion (if enabled)
  |     Uses OpenCC library (ferrous-opencc)
  |     Converts Simplified ↔ Traditional Chinese
  |
  |-- 2. If post_process flag is true:
  |     post_process_transcription(app, &text)
  |       |
  |       |  Sends text to an LLM (Claude, OpenAI, etc.)
  |       |  With a user-defined prompt like:
  |       |  "Clean up this transcription, fix grammar, remove filler words"
  |       |
  |       v
  |     Returns cleaned text
  |
  |-- 3. Return { final_text, post_processed_text, prompt }
```

---

## Stage 8: Text Output (Paste)

This is where our Smart Paste feature lives. See [04-smart-paste.md](./04-smart-paste.md) for the deep dive.

```
File: src-tauri/src/clipboard.rs (line 592)

paste(text, app_handle)
  |
  |-- 1. Append trailing space if setting enabled
  |
  |-- 2. Check focus: is_text_input_focused()  ← OUR CODE
  |
  |-- If text input focused:
  |     |  Paste text into the input field
  |     |  Do NOT modify clipboard
  |     |  Optionally send Enter key (auto-submit)
  |     |
  |     |  How? Depends on paste_method:
  |     |    CtrlV:        save clipboard → write text → Cmd+V → restore clipboard
  |     |    Direct:       simulate typing each character
  |     |    ExternalScript: call user's custom script
  |
  |-- If NO text input focused:
        |  Copy text to clipboard only
        |  Do NOT simulate any keystrokes
```

---

## Timing Cheat Sheet

| What | Duration | Why |
|------|----------|-----|
| VAD frame | 30ms (480 samples at 16kHz) | Silero model input size |
| VAD onset | 2 frames (60ms) | Need 2 consecutive voice frames to trigger |
| VAD hangover | 15 frames (450ms) | Keep trailing silence before cutting |
| Paste delay | 60ms (default, configurable) | Wait for clipboard write to propagate |
| Post-paste wait | 50ms | Wait for paste keystroke to register |
| Debounce | 30ms | Ignore rapid key repeats |
| Coordinator thread | 30ms timeout on channel receive | Balance responsiveness vs CPU usage |

---

## Error Recovery

The codebase uses RAII guards to ensure cleanup happens even on panic:

```rust
// File: actions.rs (lines 32-39)

struct FinishGuard { /* ... */ }

impl Drop for FinishGuard {
    fn drop(&mut self) {
        // This runs even if the async task panics
        hide_recording_overlay(&self.app);
        change_tray_icon(&self.app, TrayIconState::Idle);
    }
}
```

So if transcription crashes, the overlay still hides and the tray icon resets. The user never gets stuck in a "recording" state.

---

## Next: [04 - Smart Paste (Focus Detection)](./04-smart-paste.md)
