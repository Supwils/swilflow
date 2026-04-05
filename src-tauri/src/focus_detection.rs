/// Detects whether a text input field is currently focused on macOS.
///
/// Uses the macOS Accessibility API (AXUIElement) to query the system-wide
/// focused element and check if its role indicates a text input.
/// Falls back to frontmost app bundle ID detection for Electron/Tauri apps
/// with non-standard accessibility trees.
///
/// On non-macOS platforms, always returns `false`.

#[cfg(target_os = "macos")]
mod macos {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    use log::{debug, info, warn};
    use std::collections::HashSet;
    use std::ffi::{c_char, c_void, CStr};

    // Accessibility framework types
    type CFArrayRef = *const c_void;
    type CFIndex = isize;
    type CFTypeID = usize;
    type AXUIElementRef = *const c_void;
    type AXError = i32;

    const K_AX_ERROR_SUCCESS: AXError = 0;
    // Increased from 4/64/32 to handle deeper Electron/Tauri AX trees
    const MAX_AX_SEARCH_DEPTH: usize = 6;
    const MAX_AX_VISITED_NODES: usize = 128;
    const MAX_AX_CHILDREN_PER_NODE: CFIndex = 40;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: *const c_void, // CFStringRef
            value: *mut *const c_void,
        ) -> AXError;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFGetTypeID(cf: *const c_void) -> CFTypeID;
        fn CFArrayGetTypeID() -> CFTypeID;
        fn CFArrayGetCount(the_array: CFArrayRef) -> CFIndex;
        fn CFArrayGetValueAtIndex(the_array: CFArrayRef, idx: CFIndex) -> *const c_void;
    }

    // Objective-C runtime for NSWorkspace / NSRunningApplication access
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *const c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend(obj: *const c_void, sel: *const c_void, ...) -> *const c_void;
    }

    /// Bundle ID prefixes for apps known to have non-standard AX trees where
    /// text input detection may fail despite a text field being active.
    /// These are primarily Electron / Tauri / custom-framework editors.
    const KNOWN_EDITOR_BUNDLE_PREFIXES: &[&str] = &[
        "com.microsoft.VSCode",  // VS Code, VS Code Insiders
        "com.todesktop.",        // Cursor and other ToDesktop-packaged Electron apps
        "dev.zed.",              // Zed editor
        "com.cursor.",           // Cursor (alternative bundle ID)
    ];

    /// Exact bundle IDs for specific known apps with problematic AX trees.
    const KNOWN_EDITOR_BUNDLES: &[&str] = &[
        "com.github.atom",
        "com.windsurf.windsurf",
        "com.jetbrains.fleet",
    ];

    #[derive(Debug)]
    struct FocusSignals {
        role: String,
        subrole: String,
        role_desc: String,
        role_match: bool,
        has_insertion_point: bool,
        subrole_match: bool,
        has_selected_text_attr: bool,
        has_number_of_chars: bool,
        role_desc_match: bool,
    }

    impl FocusSignals {
        fn is_text_input(&self) -> bool {
            self.role_match
                || self.has_insertion_point
                || self.subrole_match
                || self.has_selected_text_attr
                || self.has_number_of_chars
                || self.role_desc_match
        }
    }

    fn role_is_text_input(role: &str) -> bool {
        matches!(
            role,
            "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField" | "AXWebArea"
        )
    }

    fn subrole_is_text_input(subrole: &str) -> bool {
        matches!(
            subrole,
            "AXPlainText" | "AXSecureTextField" | "AXSearchField"
        )
    }

    /// Checks if the AXRoleDescription hints at a text-editable element.
    /// Catches Electron/custom-framework editors that use non-standard AX roles
    /// but still set a descriptive role description.
    fn role_desc_indicates_text_input(desc: &str) -> bool {
        let lower = desc.to_lowercase();
        lower.contains("editor")
            || lower.contains("text field")
            || lower.contains("text area")
            || lower.contains("search field")
            || lower.contains("code area")
            || lower.contains("source editor")
    }

    unsafe fn copy_ax_attr_value(
        element: AXUIElementRef,
        attr_name: &str,
    ) -> Option<*const c_void> {
        let attr = CFString::new(attr_name);
        let mut value: *const c_void = std::ptr::null();
        let result = AXUIElementCopyAttributeValue(
            element,
            attr.as_concrete_TypeRef() as *const c_void,
            &mut value,
        );
        if result != K_AX_ERROR_SUCCESS || value.is_null() {
            None
        } else {
            Some(value)
        }
    }

    /// Helper: get a string attribute from an AXUIElement. Returns None on failure.
    unsafe fn get_ax_string_attr(element: AXUIElementRef, attr_name: &str) -> Option<String> {
        let value = copy_ax_attr_value(element, attr_name)?;
        let cf_str = CFString::wrap_under_create_rule(value as *const _);
        Some(cf_str.to_string())
    }

    /// Helper: check if an AXUIElement has a given attribute (regardless of value).
    unsafe fn has_ax_attr(element: AXUIElementRef, attr_name: &str) -> bool {
        let Some(value) = copy_ax_attr_value(element, attr_name) else {
            return false;
        };
        let _guard = CFType::wrap_under_create_rule(value);
        true
    }

    unsafe fn inspect_focus_signals(element: AXUIElementRef) -> FocusSignals {
        let role = get_ax_string_attr(element, "AXRole").unwrap_or_else(|| "<unknown>".into());
        let subrole = get_ax_string_attr(element, "AXSubrole").unwrap_or_else(|| "<none>".into());
        let role_desc =
            get_ax_string_attr(element, "AXRoleDescription").unwrap_or_else(|| "<none>".into());

        FocusSignals {
            role_match: role_is_text_input(&role),
            has_insertion_point: has_ax_attr(element, "AXInsertionPointLineNumber"),
            subrole_match: subrole_is_text_input(&subrole),
            has_selected_text_attr: has_ax_attr(element, "AXSelectedText"),
            has_number_of_chars: has_ax_attr(element, "AXNumberOfCharacters"),
            role_desc_match: role_desc_indicates_text_input(&role_desc),
            role,
            subrole,
            role_desc,
        }
    }

    unsafe fn search_related_element_attr(
        element: AXUIElementRef,
        attr_name: &str,
        depth: usize,
        visited: &mut HashSet<usize>,
    ) -> bool {
        if depth >= MAX_AX_SEARCH_DEPTH || visited.len() >= MAX_AX_VISITED_NODES {
            return false;
        }

        let Some(related_element) = copy_ax_attr_value(element, attr_name) else {
            return false;
        };
        let _related_guard = CFType::wrap_under_create_rule(related_element);
        search_text_input_neighborhood(related_element, depth + 1, visited)
    }

    unsafe fn search_child_elements(
        element: AXUIElementRef,
        depth: usize,
        visited: &mut HashSet<usize>,
    ) -> bool {
        if depth >= MAX_AX_SEARCH_DEPTH || visited.len() >= MAX_AX_VISITED_NODES {
            return false;
        }

        let Some(children_value) = copy_ax_attr_value(element, "AXChildren") else {
            return false;
        };
        let _children_guard = CFType::wrap_under_create_rule(children_value);

        if CFGetTypeID(children_value) != CFArrayGetTypeID() {
            return false;
        }

        let child_count =
            CFArrayGetCount(children_value as CFArrayRef).min(MAX_AX_CHILDREN_PER_NODE);
        for index in 0..child_count {
            if visited.len() >= MAX_AX_VISITED_NODES {
                break;
            }

            let child = CFArrayGetValueAtIndex(children_value as CFArrayRef, index);
            if child.is_null() {
                continue;
            }

            if search_text_input_neighborhood(child, depth + 1, visited) {
                return true;
            }
        }

        false
    }

    unsafe fn search_text_input_neighborhood(
        element: AXUIElementRef,
        depth: usize,
        visited: &mut HashSet<usize>,
    ) -> bool {
        if element.is_null()
            || depth > MAX_AX_SEARCH_DEPTH
            || visited.len() >= MAX_AX_VISITED_NODES
            || !visited.insert(element as usize)
        {
            return false;
        }

        let signals = inspect_focus_signals(element);
        let is_input = signals.is_text_input();
        debug!(
            "Focus detection node — depth: {}, role: '{}', subrole: '{}', desc: '{}', \
             role_match: {}, has_insertion_point: {}, subrole_match: {}, \
             has_selected_text: {}, has_num_chars: {}, desc_match: {} => is_text_input: {}",
            depth,
            signals.role,
            signals.subrole,
            signals.role_desc,
            signals.role_match,
            signals.has_insertion_point,
            signals.subrole_match,
            signals.has_selected_text_attr,
            signals.has_number_of_chars,
            signals.role_desc_match,
            is_input
        );
        if is_input {
            return true;
        }

        search_related_element_attr(element, "AXFocusedUIElement", depth, visited)
            || search_child_elements(element, depth, visited)
            || search_related_element_attr(element, "AXParent", depth, visited)
    }

    /// Get the bundle identifier of the frontmost application via NSWorkspace.
    unsafe fn get_frontmost_bundle_id() -> Option<String> {
        let cls = objc_getClass(b"NSWorkspace\0".as_ptr() as *const c_char);
        if cls.is_null() {
            return None;
        }

        let shared_sel = sel_registerName(b"sharedWorkspace\0".as_ptr() as *const c_char);
        let workspace = objc_msgSend(cls, shared_sel);
        if workspace.is_null() {
            return None;
        }

        let frontmost_sel =
            sel_registerName(b"frontmostApplication\0".as_ptr() as *const c_char);
        let app = objc_msgSend(workspace, frontmost_sel);
        if app.is_null() {
            return None;
        }

        let bundle_sel = sel_registerName(b"bundleIdentifier\0".as_ptr() as *const c_char);
        let ns_string = objc_msgSend(app, bundle_sel);
        if ns_string.is_null() {
            return None;
        }

        let utf8_sel = sel_registerName(b"UTF8String\0".as_ptr() as *const c_char);
        let c_str = objc_msgSend(ns_string, utf8_sel) as *const c_char;
        if c_str.is_null() {
            return None;
        }

        Some(CStr::from_ptr(c_str).to_string_lossy().into_owned())
    }

    fn is_known_editor_app(bundle_id: &str) -> bool {
        KNOWN_EDITOR_BUNDLE_PREFIXES
            .iter()
            .any(|prefix| bundle_id.starts_with(prefix))
            || KNOWN_EDITOR_BUNDLES.iter().any(|&id| bundle_id == id)
    }

    /// Fallback: check if the frontmost app is a known editor with
    /// problematic AX trees, and assume text input is focused.
    unsafe fn check_app_fallback() -> bool {
        let Some(bundle_id) = get_frontmost_bundle_id() else {
            debug!("App-based fallback: could not determine frontmost app bundle ID");
            return false;
        };

        let is_known = is_known_editor_app(&bundle_id);
        if is_known {
            info!(
                "App-based fallback: '{}' is a known editor with non-standard AX — assuming text input",
                bundle_id
            );
        } else {
            debug!(
                "App-based fallback: '{}' not in known editor list",
                bundle_id
            );
        }
        is_known
    }

    /// Returns `true` if the currently focused UI element is a text input field.
    ///
    /// Uses a multi-strategy approach:
    ///
    /// 1. **Role check** — matches known text input roles (AXTextField, AXTextArea,
    ///    AXComboBox, AXSearchField, AXWebArea).
    /// 2. **Insertion point check** — if the element has an `AXInsertionPointLineNumber`
    ///    attribute, a text cursor is present, which definitively means it accepts text.
    /// 3. **Subrole check** — catches `AXPlainText` and similar subroles used by some apps.
    /// 4. **Character count check** — if the element has `AXNumberOfCharacters`, it
    ///    tracks text content and is very likely a text input.
    /// 5. **Role description check** — keyword matching on `AXRoleDescription` for
    ///    terms like "editor", "text field", etc.
    /// 6. **Neighborhood search** — recursively inspects nested focused nodes, children,
    ///    and the parent chain within a bounded AX neighborhood.
    /// 7. **App-based fallback** — if all AX heuristics fail, checks if the frontmost
    ///    app is a known Electron/Tauri editor (Cursor, VS Code, etc.) and assumes
    ///    text input is focused.
    pub fn is_text_input_focused() -> bool {
        unsafe {
            let system_wide = AXUIElementCreateSystemWide();
            if system_wide.is_null() {
                warn!("Failed to create system-wide AXUIElement");
                return false;
            }

            // Get the focused UI element
            let focused_attr = CFString::new("AXFocusedUIElement");
            let mut focused_element: *const c_void = std::ptr::null();

            let result = AXUIElementCopyAttributeValue(
                system_wide,
                focused_attr.as_concrete_TypeRef() as *const c_void,
                &mut focused_element,
            );

            // Release system-wide element
            let _system_wide_guard = CFType::wrap_under_create_rule(system_wide);

            if result != K_AX_ERROR_SUCCESS || focused_element.is_null() {
                debug!(
                    "No focused element found (AXError: {}). Trying app-based fallback.",
                    result
                );
                return check_app_fallback();
            }

            // Take ownership of focused element for auto-release
            let _focused_guard = CFType::wrap_under_create_rule(focused_element);

            let mut visited = HashSet::new();
            let is_input = search_text_input_neighborhood(focused_element, 0, &mut visited);
            debug!(
                "Focus detection result — visited_nodes: {}, is_text_input: {}",
                visited.len(),
                is_input
            );

            if is_input {
                return true;
            }

            // AX heuristics did not find a text input — try app-based fallback
            check_app_fallback()
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn role_classifier_accepts_standard_text_inputs() {
            assert!(role_is_text_input("AXTextField"));
            assert!(role_is_text_input("AXTextArea"));
            assert!(role_is_text_input("AXComboBox"));
            assert!(role_is_text_input("AXSearchField"));
            assert!(role_is_text_input("AXWebArea"));
            assert!(!role_is_text_input("AXButton"));
            assert!(!role_is_text_input("AXGroup"));
        }

        #[test]
        fn subrole_classifier_accepts_plain_text_editors() {
            assert!(subrole_is_text_input("AXPlainText"));
            assert!(subrole_is_text_input("AXSecureTextField"));
            assert!(subrole_is_text_input("AXSearchField"));
            assert!(!subrole_is_text_input("AXApplication"));
        }

        #[test]
        fn role_desc_catches_editor_keywords() {
            assert!(role_desc_indicates_text_input("editor"));
            assert!(role_desc_indicates_text_input("Source Editor"));
            assert!(role_desc_indicates_text_input("text field"));
            assert!(role_desc_indicates_text_input("Text Area"));
            assert!(role_desc_indicates_text_input("search field"));
            assert!(role_desc_indicates_text_input("code area"));
            assert!(!role_desc_indicates_text_input("button"));
            assert!(!role_desc_indicates_text_input("group"));
            assert!(!role_desc_indicates_text_input("toolbar"));
        }

        #[test]
        fn focus_signals_accept_axgroup_when_text_capabilities_exist() {
            let plain_group = FocusSignals {
                role: "AXGroup".into(),
                subrole: "AXPlainText".into(),
                role_desc: "editor".into(),
                role_match: false,
                has_insertion_point: false,
                subrole_match: true,
                has_selected_text_attr: false,
                has_number_of_chars: false,
                role_desc_match: true,
            };
            assert!(plain_group.is_text_input());

            let editable_group = FocusSignals {
                role: "AXGroup".into(),
                subrole: "<none>".into(),
                role_desc: "group".into(),
                role_match: false,
                has_insertion_point: true,
                subrole_match: false,
                has_selected_text_attr: false,
                has_number_of_chars: false,
                role_desc_match: false,
            };
            assert!(editable_group.is_text_input());
        }

        #[test]
        fn focus_signals_accept_element_with_character_count() {
            let element_with_chars = FocusSignals {
                role: "AXGroup".into(),
                subrole: "<none>".into(),
                role_desc: "group".into(),
                role_match: false,
                has_insertion_point: false,
                subrole_match: false,
                has_selected_text_attr: false,
                has_number_of_chars: true,
                role_desc_match: false,
            };
            assert!(element_with_chars.is_text_input());
        }

        #[test]
        fn focus_signals_accept_element_with_editor_role_desc() {
            let editor_desc = FocusSignals {
                role: "AXGroup".into(),
                subrole: "<none>".into(),
                role_desc: "Source Editor".into(),
                role_match: false,
                has_insertion_point: false,
                subrole_match: false,
                has_selected_text_attr: false,
                has_number_of_chars: false,
                role_desc_match: true,
            };
            assert!(editor_desc.is_text_input());
        }

        #[test]
        fn focus_signals_reject_non_text_controls_without_text_capabilities() {
            let button = FocusSignals {
                role: "AXButton".into(),
                subrole: "<none>".into(),
                role_desc: "button".into(),
                role_match: false,
                has_insertion_point: false,
                subrole_match: false,
                has_selected_text_attr: false,
                has_number_of_chars: false,
                role_desc_match: false,
            };
            assert!(!button.is_text_input());
        }

        #[test]
        fn known_editor_detection_matches_prefixes_and_exact_ids() {
            assert!(is_known_editor_app("com.microsoft.VSCode"));
            assert!(is_known_editor_app("com.microsoft.VSCodeInsiders"));
            assert!(is_known_editor_app("com.todesktop.230313mzl4w4u92"));
            assert!(is_known_editor_app("dev.zed.Zed"));
            assert!(is_known_editor_app("com.cursor.editor"));
            assert!(is_known_editor_app("com.github.atom"));
            assert!(is_known_editor_app("com.windsurf.windsurf"));
            assert!(is_known_editor_app("com.jetbrains.fleet"));

            assert!(!is_known_editor_app("com.apple.Safari"));
            assert!(!is_known_editor_app("com.apple.Terminal"));
            assert!(!is_known_editor_app("com.spotify.client"));
        }
    }
}

/// Returns `true` if a text input field is currently focused.
///
/// On macOS, uses the Accessibility API with app-based fallback.
/// On other platforms, returns `false`.
#[cfg(target_os = "macos")]
pub fn is_text_input_focused() -> bool {
    macos::is_text_input_focused()
}

#[cfg(not(target_os = "macos"))]
pub fn is_text_input_focused() -> bool {
    false
}
