# 07 - Rust FFI and macOS APIs

> A beginner-friendly guide to the `unsafe` Rust code and macOS C APIs used in this project.

This doc is for understanding the hardest part of the codebase: where Rust calls C functions from macOS frameworks.

---

## What is FFI?

**FFI = Foreign Function Interface**. It's how one programming language calls functions written in another language.

In our case:

```
Rust code ──FFI──> C functions from Apple's frameworks
```

macOS provides many system APIs in C (and Objective-C). Rust can call C functions, but it can't verify they're safe. That's why we need `unsafe`.

---

## What is `unsafe`?

Normally, Rust prevents you from:
- Dereferencing raw pointers (they might be null or dangling)
- Calling C functions (Rust can't verify they do what they claim)
- Mutating through shared references

`unsafe` is Rust saying: "I'm turning off some safety checks. The programmer promises this code is correct."

```rust
// This won't compile:
let ptr: *const i32 = some_function();
let value = *ptr;  // ERROR: dereferencing raw pointer requires unsafe

// This compiles:
let ptr: *const i32 = some_function();
let value = unsafe { *ptr };  // OK: programmer takes responsibility
```

**`unsafe` doesn't mean "dangerous". It means "the compiler can't verify this, so the human must."**

---

## Apple's CoreFoundation Type System

Apple's C libraries use their own type system. Here's how it maps to Rust:

| Apple C Type | What It Is | Rust Equivalent |
|-------------|------------|-----------------|
| `CFStringRef` | A string | `String` |
| `CFTypeRef` | Any object (like `void*`) | `*const c_void` |
| `AXUIElementRef` | An accessibility element | `*const c_void` (opaque) |
| `AXError` | An error code | `i32` |
| `kAXErrorSuccess` | No error (value = 0) | `0i32` |

### Memory Management: The "Create Rule"

Apple uses reference counting for memory management. The rule is:

> **If a function name contains "Create" or "Copy", you own the returned object and must release it.**

```
AXUIElementCreateSystemWide()   ← "Create" → you own it → must release
AXUIElementCopyAttributeValue() ← "Copy"   → you own it → must release
```

In C, you'd call `CFRelease(obj)` when done. In Rust, we use RAII:

```rust
// Take ownership: will call CFRelease when _guard is dropped
let _guard = CFType::wrap_under_create_rule(pointer);
```

When `_guard` goes out of scope (end of block, function return, etc.), it automatically calls `CFRelease`. This is Rust's RAII (Resource Acquisition Is Initialization) pattern.

---

## Walking Through focus_detection.rs

Let's read the entire FFI flow step by step.

### Step 1: Declare the C functions we'll call

```rust
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

- `#[link(name = "ApplicationServices", kind = "framework")]` tells the linker to link against this macOS framework
- `extern "C"` declares functions with C calling convention
- We define the signatures so Rust knows the types, but we don't implement them -- the framework provides the implementation

### Step 2: Create the system-wide element

```rust
let system_wide = AXUIElementCreateSystemWide();
```

This calls Apple's function. It returns a pointer to an accessibility element that represents "the entire system". We can ask this element questions like "which UI element is currently focused?"

```
system_wide = pointer to [System-Wide AXUIElement]
                              |
                              | We can query:
                              |   "AXFocusedUIElement" → the focused element
                              |   "AXFocusedApplication" → the frontmost app
```

### Step 3: Query the focused element

```rust
let focused_attr = CFString::new("AXFocusedUIElement");
let mut focused_element: *const c_void = std::ptr::null();

let result = AXUIElementCopyAttributeValue(
    system_wide,
    focused_attr.as_concrete_TypeRef() as *const c_void,
    &mut focused_element,  // Output parameter: Apple writes the result here
);
```

**This is an "output parameter" pattern.** In C, functions often return results through a pointer parameter:

```
Before call:  focused_element = null
               ↓
AXUIElementCopyAttributeValue(system_wide, "AXFocusedUIElement", &focused_element)
               ↓
After call:   focused_element = pointer to [The Focused Button/TextField/etc.]
```

The function's return value is an error code (`AXError`), not the actual result.

### Step 4: Memory management

```rust
let _system_wide_guard = CFType::wrap_under_create_rule(system_wide);
```

We're done with `system_wide` (we already queried it). But we can't just forget about it -- that would be a memory leak. `wrap_under_create_rule` takes ownership and will call `CFRelease(system_wide)` when `_system_wide_guard` is dropped.

**Why the underscore prefix?** `_system_wide_guard` tells Rust "I know this variable isn't used again, but I need it to exist for its Drop behavior." Without the underscore, Rust would warn about an unused variable.

```rust
let _focused_guard = CFType::wrap_under_create_rule(focused_element);
```

Same for the focused element. It will be released at the end of the function.

### Step 5: Query the role of the focused element

```rust
let role = get_ax_string_attr(focused_element, "AXRole");
```

Inside `get_ax_string_attr`:

```rust
unsafe fn get_ax_string_attr(element: AXUIElementRef, attr_name: &str) -> Option<String> {
    // 1. Convert Rust string to Apple CFString
    let attr = CFString::new(attr_name);

    // 2. Prepare output pointer
    let mut value: *const c_void = std::ptr::null();

    // 3. Ask the element for the attribute
    let result = AXUIElementCopyAttributeValue(
        element,
        attr.as_concrete_TypeRef() as *const c_void,
        &mut value,
    );

    // 4. Check for error
    if result != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }

    // 5. Convert the returned CFString to a Rust String
    let cf_str = CFString::wrap_under_create_rule(value as *const _);
    Some(cf_str.to_string())
}
```

The chain of type conversions:

```
Rust &str "AXRole"
    |  CFString::new()
    v
Apple CFString (in memory)
    |  as_concrete_TypeRef() as *const c_void
    v
Raw pointer (what the C function expects)
    |
    |  C function runs, returns another raw pointer
    v
*const c_void (the attribute value)
    |  CFString::wrap_under_create_rule()
    v
Rust CFString wrapper (safe, auto-releases)
    |  .to_string()
    v
Rust String "AXTextField"
```

---

## Common Accessibility Roles

When you click on different UI elements, they report different roles:

| App | Element | AXRole | AXSubrole |
|-----|---------|--------|-----------|
| Chrome | URL bar | AXTextField | - |
| Chrome | Page content | AXWebArea | - |
| Notes | Text area | AXTextArea | - |
| Terminal | Input area | AXTextArea | - |
| VS Code | Editor | AXGroup | AXPlainText |
| Cursor | Editor | AXGroup | AXPlainText |
| Finder | Window | AXWindow | - |
| Dock | Icon | AXButton | - |

**Key insight**: Electron-based apps (VS Code, Cursor, Claude Desktop) often report `AXGroup` instead of `AXTextField`. That's why role matching alone isn't enough.

---

## How `has_ax_attr` Works

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
        let _guard = CFType::wrap_under_create_rule(value);  // Release the value
        true
    } else {
        false
    }
}
```

We don't care WHAT the value is -- just whether the attribute exists. If querying `AXInsertionPointLineNumber` succeeds, there's a text cursor, which means it's a text input.

**Why `_guard` inside the `if`?** Because if the attribute exists, Apple allocated memory for the value. We need to release it even though we don't use it. The `_guard` does this automatically when the `if` block ends.

---

## Potential Bugs and How to Avoid Them

### Bug: Double release

```rust
// WRONG: releasing the same pointer twice
let cf_str = CFString::wrap_under_create_rule(value);
let cf_str2 = CFString::wrap_under_create_rule(value);  // BOOM: double free
```

Rule: Call `wrap_under_create_rule` exactly ONCE per pointer.

### Bug: Memory leak

```rust
// WRONG: forgetting to take ownership
let result = AXUIElementCopyAttributeValue(..., &mut value);
// value is never released → memory leak
```

Rule: Every `Create` or `Copy` result must be wrapped.

### Bug: Use after free

```rust
// WRONG: using the pointer after releasing it
let guard = CFType::wrap_under_create_rule(value);
drop(guard);  // Released!
let attr = AXUIElementCopyAttributeValue(value, ...);  // BOOM: use after free
```

Rule: Don't use the raw pointer after wrapping it, unless you know the wrapper hasn't been dropped.

### Bug: Missing null check

```rust
// WRONG: not checking for null
let value = AXUIElementCopyAttributeValue(..., &mut value);
let cf_str = CFString::wrap_under_create_rule(value);  // BOOM if value is null
```

Rule: Always check `result != K_AX_ERROR_SUCCESS || value.is_null()` before wrapping.

---

## The `#[cfg]` Conditional Compilation Pattern

```rust
// This module only exists on macOS
#[cfg(target_os = "macos")]
mod macos {
    // All the Accessibility API code
}

// Public function: delegates to the macOS implementation
#[cfg(target_os = "macos")]
pub fn is_text_input_focused() -> bool {
    macos::is_text_input_focused()
}

// On other platforms: always return false (safe fallback)
#[cfg(not(target_os = "macos"))]
pub fn is_text_input_focused() -> bool {
    false
}
```

**Why?** The Accessibility API only exists on macOS. On Windows/Linux:
- The macOS code doesn't compile (no `ApplicationServices` framework)
- The function returns `false`, meaning text always goes to clipboard
- This is a safe fallback -- no crash, just reduced functionality

---

## Other FFI in This Codebase

Our focus detection isn't the only FFI in the project. Here are others for context:

| What | Where | Apple Framework |
|------|-------|-----------------|
| Focus detection (ours) | `focus_detection.rs` | ApplicationServices (Accessibility) |
| Keyboard simulation | `enigo` crate | CoreGraphics (CGEvent) |
| Audio capture | `cpal` crate | CoreAudio |
| System tray | Tauri tray plugin | AppKit (NSStatusBar) |
| Overlay window | `tauri-nspanel` | AppKit (NSPanel) |
| Whisper ML inference | `whisper.cpp` via `transcribe-rs` | Metal (GPU acceleration) |

The difference: most of these are abstracted by crates. We only had to write raw FFI for focus detection because no existing crate does exactly what we need.

---

## How to Explore Accessibility Yourself

### Using Accessibility Inspector

1. Open Xcode
2. Menu: Xcode → Open Developer Tool → Accessibility Inspector
3. Click the crosshair icon, then click any UI element
4. You'll see its AXRole, AXSubrole, AXRoleDescription, and all attributes

This is how you'd discover that VS Code reports `AXGroup` instead of `AXTextField`.

### Using the command line

```bash
# Check if your app has accessibility permissions
tccutil --list Accessibility

# Or check in System Preferences:
# System Settings → Privacy & Security → Accessibility
```

---

## What You Should Be Able to Explain

1. **"What does `unsafe` mean?"**
   → It means the Rust compiler can't verify this code's safety guarantees. We're calling C functions through FFI, which Rust can't analyze. The programmer is responsible for correct pointer handling and memory management.

2. **"What's the Create Rule?"**
   → Apple CoreFoundation convention: if a function name contains "Create" or "Copy", the caller owns the returned object and must release it. We use Rust's RAII pattern (`wrap_under_create_rule`) to automate this -- the object is released when the Rust wrapper is dropped.

3. **"What happens if accessibility permission isn't granted?"**
   → `AXUIElementCopyAttributeValue` returns an error code (not 0). We check for this and return `false`, which means the text goes to clipboard instead -- a graceful fallback.

4. **"Why not use an existing crate for accessibility?"**
   → No existing Rust crate provides the specific query we need (checking the focused element's role and attributes). The `accessibility` crate exists but is heavyweight and doesn't expose the low-level queries we need. Writing ~100 lines of FFI was simpler.

5. **"How do you prevent memory leaks?"**
   → Every pointer returned by a `Copy`/`Create` function is immediately wrapped in a RAII guard (`CFType::wrap_under_create_rule`). The guard calls `CFRelease` when it goes out of scope, even if the function returns early or panics.
