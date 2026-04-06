# 04 - Smart Paste (Focus Detection)

> Our custom feature: detect if a text input is focused, and decide how to deliver transcribed text.

This is the feature you designed. This doc explains every line of the implementation so you can truly own it.

---

## The Problem

The original app's behavior after transcription:

```
Transcribed text ready
    |
    v
ALWAYS: write text to clipboard → simulate Cmd+V → restore clipboard
```

Problems:
1. If no input field is focused, the Cmd+V goes nowhere (or into the wrong place)
2. If an input field IS focused, the user's clipboard gets temporarily overwritten
3. No intelligence about the current context

## Our Solution

```
Transcribed text ready
    |
    v
Check: is a text input focused?
    |
    ├── YES → Paste into it, DON'T touch clipboard
    |
    └── NO  → Copy to clipboard only, DON'T simulate keystrokes
```

---

## File: src-tauri/src/focus_detection.rs

This is the entire file. Let's go through it piece by piece.

### The macOS Module

```rust
#[cfg(target_os = "macos")]
mod macos {
```

`#[cfg(target_os = "macos")]` means this code only compiles on macOS. On Windows/Linux, it's as if this code doesn't exist.

### FFI Declarations

```rust
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    use std::ffi::c_void;

    type AXUIElementRef = *const c_void;
    type AXError = i32;

    const K_AX_ERROR_SUCCESS: AXError = 0;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: *const c_void,
            value: *mut *const c_void,
        ) -> AXError;
    }
```

**What's happening here:**

1. **`core_foundation`** is a Rust crate that provides safe wrappers around Apple's CoreFoundation C library. We use it for `CFString` (Apple's string type) and `CFType` (for memory management).

2. **`type AXUIElementRef = *const c_void`** -- We're defining the type for an Accessibility element pointer. It's a raw pointer (`*const`) to opaque data (`c_void`). We can't look inside it; we just pass it to Apple's functions.

3. **`#[link(name = "ApplicationServices", kind = "framework")]`** -- This tells the Rust linker: "Link against Apple's ApplicationServices framework." This framework contains the Accessibility API.

4. **`extern "C"`** -- These are C functions we're calling from Rust. The Rust compiler doesn't know what they do; it just knows their signatures. This is **FFI** (Foreign Function Interface).

   - `AXUIElementCreateSystemWide()` -- Creates a "system-wide" accessibility element. This is the starting point for querying any UI element on screen.
   - `AXUIElementCopyAttributeValue()` -- Asks an element for an attribute value. Like asking a button "what's your role?" or "what's your title?"

### Helper Functions

```rust
    unsafe fn get_ax_string_attr(element: AXUIElementRef, attr_name: &str) -> Option<String> {
        let attr = CFString::new(attr_name);
        let mut value: *const c_void = std::ptr::null();
        let result = AXUIElementCopyAttributeValue(
            element,
            attr.as_concrete_TypeRef() as *const c_void,
            &mut value,
        );
        if result != K_AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        let cf_str = CFString::wrap_under_create_rule(value as *const _);
        Some(cf_str.to_string())
    }
```

**Line by line:**

1. `unsafe fn` -- This function uses raw pointers and FFI calls, which Rust can't verify for safety. We're telling the compiler: "Trust me, I know what I'm doing."

2. `CFString::new(attr_name)` -- Convert a Rust `&str` into a CoreFoundation `CFString`. Apple APIs only understand CF types.

3. `let mut value: *const c_void = std::ptr::null()` -- Create an empty pointer. The Apple function will fill it in.

4. `AXUIElementCopyAttributeValue(element, attr, &mut value)` -- Ask the element for an attribute. The word "Copy" in the function name is important: it means **we own the returned value and must release it**.

5. `CFString::wrap_under_create_rule(value)` -- This is the crucial memory management line. Since `Copy` means we own it, `wrap_under_create_rule` tells CoreFoundation: "I'll take ownership. When this Rust wrapper is dropped, call `CFRelease` for me."

   Without this line, we'd have a memory leak. Every `CopyAttributeValue` call would leak a CFString.

```rust
    unsafe fn has_ax_attr(element: AXUIElementRef, attr_name: &str) -> bool {
        let attr = CFString::new(attr_name);
        let mut value: *const c_void = std::ptr::null();
        let result = AXUIElementCopyAttributeValue(
            element,
            attr.as_concrete_TypeRef() as *const c_void,
            &mut value,
        );
        if result == K_AX_ERROR_SUCCESS && !value.is_null() {
            let _guard = CFType::wrap_under_create_rule(value);
            true
        } else {
            false
        }
    }
```

Same pattern, but we don't care about the value -- just whether the attribute exists. The `_guard` variable takes ownership so the value is released when `_guard` goes out of scope (end of `if` block).

### The Main Detection Function

```rust
    pub fn is_text_input_focused() -> bool {
        unsafe {
            // Step 1: Get the system-wide accessibility element
            let system_wide = AXUIElementCreateSystemWide();
            if system_wide.is_null() {
                return false;
            }

            // Step 2: Ask "what UI element currently has focus?"
            let focused_attr = CFString::new("AXFocusedUIElement");
            let mut focused_element: *const c_void = std::ptr::null();
            let result = AXUIElementCopyAttributeValue(
                system_wide,
                focused_attr.as_concrete_TypeRef() as *const c_void,
                &mut focused_element,
            );

            // Memory management: ensure system_wide is released
            let _system_wide_guard = CFType::wrap_under_create_rule(system_wide);

            if result != K_AX_ERROR_SUCCESS || focused_element.is_null() {
                // No focused element, or accessibility permission not granted
                return false;
            }

            // Memory management: ensure focused_element is released
            let _focused_guard = CFType::wrap_under_create_rule(focused_element);
```

This is the query chain:

```
System-wide element
    |
    | "AXFocusedUIElement"
    v
The currently focused UI element (whatever the user last clicked/tabbed to)
```

Now we have the focused element. Time to figure out what it is:

```rust
            // Gather info about the focused element
            let role = get_ax_string_attr(focused_element, "AXRole")
                .unwrap_or_else(|| "<unknown>".into());
            let subrole = get_ax_string_attr(focused_element, "AXSubrole")
                .unwrap_or_else(|| "<none>".into());
```

Every macOS UI element has a **role** (what kind of thing it is) and optionally a **subrole** (more specific type).

### The Four Detection Strategies

```rust
            // Strategy 1: Known text input roles
            let role_match = matches!(
                role.as_str(),
                "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField" | "AXWebArea"
            );
```

**Strategy 1: Role matching** -- The simplest approach. macOS defines standard roles:
- `AXTextField` -- Single-line text input (like a search bar)
- `AXTextArea` -- Multi-line text input (like Notes.app)
- `AXComboBox` -- Dropdown with text input
- `AXSearchField` -- Search field (Spotlight-style)
- `AXWebArea` -- Web content (covers `<input>`, `<textarea>`, `contenteditable` in browsers)

**This covers: Chrome, Safari, Notes, WeChat, most native macOS apps.**

But it doesn't cover Electron apps (Claude Code Desktop, Cursor, VS Code). Those apps use custom rendering and may not report standard roles.

```rust
            // Strategy 2: Element has a text cursor
            let has_insertion_point = has_ax_attr(focused_element, "AXInsertionPointLineNumber");
```

**Strategy 2: Insertion point detection** -- If the element has an `AXInsertionPointLineNumber` attribute, it means there's a blinking text cursor. No cursor = not a text input. This is the most reliable signal because:
- If you can see a blinking cursor, you can type there
- Works regardless of what role the element reports
- **This is what catches Electron apps**

```rust
            // Strategy 3: Subrole indicates text input
            let subrole_match = matches!(
                subrole.as_str(),
                "AXPlainText" | "AXSecureTextField" | "AXSearchField"
            );
```

**Strategy 3: Subrole matching** -- Some elements have a generic role but a specific subrole:
- `AXPlainText` -- A plain text editing area
- `AXSecureTextField` -- A password field
- `AXSearchField` -- A search input

```rust
            // Strategy 4: Element supports text selection
            let has_selected_text_attr = has_ax_attr(focused_element, "AXSelectedText");
```

**Strategy 4: Selected text attribute** -- If the element has an `AXSelectedText` attribute, it supports text selection, which strongly implies it's a text input.

### Combining the signals

```rust
            let is_input = role_match || has_insertion_point || subrole_match || has_selected_text_attr;
```

Any ONE of the four strategies being true is enough. This is intentionally permissive -- it's better to paste into a text field than to fail silently and just copy to clipboard.

---

## File: src-tauri/src/clipboard.rs (paste function)

### Before our change (original code)

```rust
pub fn paste(text: String, app_handle: AppHandle) -> Result<(), String> {
    // Always paste, regardless of context
    match paste_method {
        PasteMethod::CtrlV => paste_via_clipboard(&text, ...),  // Always Cmd+V
        PasteMethod::Direct => paste_direct(&text, ...),         // Always type
        PasteMethod::None => { /* skip */ },
        // ...
    }

    // Then optionally copy to clipboard too
    if settings.clipboard_handling == CopyToClipboard {
        clipboard.write_text(&text);
    }
}
```

### After our change

```rust
pub fn paste(text: String, app_handle: AppHandle) -> Result<(), String> {
    let text_input_focused = focus_detection::is_text_input_focused();  // NEW

    if text_input_focused {
        // Text input is focused: paste into it, DON'T leave text in clipboard
        match paste_method {
            PasteMethod::CtrlV => paste_via_clipboard(...),
            // paste_via_clipboard RESTORES the original clipboard after pasting
            // so clipboard remains untouched
            PasteMethod::Direct => paste_direct(...),
            // ...
        }
        // NO clipboard write at the end
        info!("Text pasted into focused input field; clipboard left untouched");
    } else {
        // No text input: clipboard only, NO keystrokes
        clipboard.write_text(&text);
        info!("No text input focused; text copied to clipboard only");
    }
}
```

### What paste_via_clipboard actually does

```rust
fn paste_via_clipboard(enigo, text, app_handle, paste_method, delay) {
    // 1. Save what's currently in the clipboard
    let original = clipboard.read_text();

    // 2. Write our transcription to the clipboard
    clipboard.write_text(text);

    // 3. Wait a moment for clipboard to propagate
    sleep(paste_delay_ms);  // default 60ms

    // 4. Simulate Cmd+V (or Ctrl+V on other platforms)
    send_paste_ctrl_v(enigo);

    // 5. Wait for the paste to complete
    sleep(50ms);

    // 6. Restore the original clipboard content
    clipboard.write_text(&original);
}
```

**Key insight**: Even though this method uses the clipboard, it **restores** the original content afterward. So if a text input is focused, the clipboard ends up unchanged -- which is exactly what we want.

---

## Why Some Apps Didn't Work (And How We Fixed It)

### Initial implementation (only Strategy 1)

```rust
let is_input = matches!(role.as_str(),
    "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField" | "AXWebArea"
);
```

**Results:**
- Chrome: role = `AXWebArea` -- WORKS
- Notes: role = `AXTextArea` -- WORKS
- WeChat: role = `AXTextArea` -- WORKS
- Claude Code Desktop: role = `AXGroup` -- FAILS (Electron renders custom UI)
- Cursor: role = `AXGroup` -- FAILS

### After adding Strategies 2-4

Electron apps may report `AXGroup` as the role, but they still have:
- A blinking cursor → `AXInsertionPointLineNumber` exists → Strategy 2 catches it
- Text selection support → `AXSelectedText` exists → Strategy 4 catches it

---

## How to Debug This

Run the app with `--debug` flag. In the logs, you'll see:

```
Focus detection — role: 'AXGroup', subrole: 'AXPlainText', desc: 'editor',
  role_match: false, has_insertion_point: true, subrole_match: true,
  has_selected_text: true, => is_text_input: true
```

This tells you exactly which strategies triggered and why.

You can also use Apple's **Accessibility Inspector** (Xcode → Open Developer Tool → Accessibility Inspector) to explore what role/subrole any UI element reports.

---

## Memory Safety: The `unsafe` Contract

Every `unsafe` block in `focus_detection.rs` follows the same pattern:

```
1. Call Apple C function that returns a pointer
2. Check if pointer is null (handle error case)
3. Wrap pointer with CFType::wrap_under_create_rule()
4. The wrapped value auto-releases when it goes out of scope (Drop trait)
```

If we forgot step 3, we'd have a memory leak.
If we called step 3 on the same pointer twice, we'd have a double-free crash.

The key rule: **every `Copy` function returns ownership. Take it exactly once.**

---

## What You Should Be Able to Explain

If asked in an interview:

1. **"How does your app know if a text input is focused?"**
   → macOS Accessibility API. We query `AXFocusedUIElement` to get the currently focused element, then check its role, subrole, and whether it has text cursor attributes.

2. **"Why four detection strategies?"**
   → Different app frameworks expose different accessibility attributes. Native Cocoa apps report `AXTextField`, but Electron apps (VS Code, Cursor) may report `AXGroup`. The insertion point check is the most reliable cross-framework signal.

3. **"What's `unsafe` mean here?"**
   → We're calling C functions through FFI. Rust can't verify memory safety across the language boundary, so we manually ensure every allocated object is properly released using RAII wrappers (`wrap_under_create_rule`).

4. **"What happens if accessibility permissions aren't granted?"**
   → `AXUIElementCopyAttributeValue` returns an error code instead of an element. We detect this and return `false` (no text input focused), which means the text goes to clipboard -- a safe fallback.

---

## Next: [05 - Accent Color System](./05-accent-color-system.md)
