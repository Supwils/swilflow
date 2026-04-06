# 05 - Accent Color System

> How the 7-color theme system works, from Rust enum to CSS variable to visual change.

---

## The Goal

Let users pick one of 7 accent colors. The entire app (main window + overlay window) changes color instantly, respects light/dark mode, and persists the choice across restarts.

---

## The Full Data Flow

```
User clicks "Blue" swatch
    |
    v
AccentColorPicker.tsx
    |-- applyAccentColor("blue")       ← Immediate CSS change (optimistic)
    |-- updateSetting("accent_color", "blue")  ← Persist to Rust
            |
            v
        settingsStore.ts
            |-- Optimistic: settings.accent_color = "blue"
            |-- settingUpdaters["accent_color"]("blue")
                    |
                    v
                commands.changeAccentColorSetting("blue")
                    |
                    v (Tauri IPC)
                Rust: change_accent_color_setting(app, AccentColor::Blue)
                    |
                    v
                settings.rs: write accent_color to settings_store.json
```

---

## Layer 1: Rust Backend (Type + Persistence)

### The enum

```rust
// File: src-tauri/src/settings.rs

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum AccentColor {
    Pink,
    Gold,
    Orange,
    Green,
    Blue,
    Purple,
    Coral,
}

impl Default for AccentColor {
    fn default() -> Self {
        AccentColor::Pink  // Pink is the original Handy color
    }
}
```

**What each derive does:**
- `Clone, Debug` -- Standard Rust traits (copy values, print for debugging)
- `Serialize, Deserialize` -- serde: convert to/from JSON for storage
- `PartialEq, Eq` -- Allow comparison (`color == AccentColor::Blue`)
- `Type` -- specta: generate TypeScript type definition

**`#[serde(rename_all = "lowercase")]`** -- When serialized to JSON, `Pink` becomes `"pink"`, `Gold` becomes `"gold"`. This matches the TypeScript side.

### The command

```rust
// File: src-tauri/src/shortcut/mod.rs

#[tauri::command]
#[specta::specta]
pub fn change_accent_color_setting(
    app: AppHandle,
    color: settings::AccentColor,
) -> Result<(), String> {
    let mut s = settings::get_settings(&app);
    s.accent_color = color;
    settings::write_settings(&app, s);
    Ok(())
}
```

This is the standard settings command pattern:
1. Read current settings
2. Modify the field
3. Write back

Settings are stored in `settings_store.json` via `tauri-plugin-store`.

---

## Layer 2: Color Definitions (TypeScript)

```typescript
// File: src/lib/utils/accentColors.ts

interface AccentColorDef {
    light: { logoPrimary: string; backgroundUi: string; logoStroke: string };
    dark:  { logoPrimary: string; backgroundUi: string; logoStroke: string };
}

const ACCENT_COLORS: Record<AccentColor, AccentColorDef> = {
    pink: {
        light: { logoPrimary: "#faa2ca", backgroundUi: "#da5893", logoStroke: "#382731" },
        dark:  { logoPrimary: "#f28cbb", backgroundUi: "#da5893", logoStroke: "#fad1ed" },
    },
    blue: {
        light: { logoPrimary: "#7aabe0", backgroundUi: "#3a78b8", logoStroke: "#202838" },
        dark:  { logoPrimary: "#6a9dd6", backgroundUi: "#3a78b8", logoStroke: "#b8d8f5" },
    },
    // ... 5 more colors
};
```

**Why light AND dark?** In light mode, the logo primary is brighter (it's on a light background). In dark mode, it needs to be slightly muted. The stroke color inverts: dark stroke on light background, light stroke on dark background.

**Three CSS variables:**
- `--color-logo-primary` -- The main accent color. Used for the logo, mic icon, progress bars
- `--color-background-ui` -- A saturated variant for backgrounds and buttons
- `--color-logo-stroke` -- Outline/text color that contrasts with the primary

---

## Layer 3: CSS Variable Application

### How CSS variables work

CSS variables (custom properties) are set on an element and inherited by all children:

```css
/* Set on the root element */
:root {
    --color-logo-primary: #faa2ca;
}

/* Used anywhere in the app */
.some-icon {
    fill: var(--color-logo-primary);
}
```

### Setting them at runtime

```typescript
// File: src/lib/utils/accentColors.ts

export function applyAccentColor(color: AccentColor): void {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const values = isDark ? ACCENT_COLORS[color].dark : ACCENT_COLORS[color].light;

    const root = document.documentElement;  // The <html> element
    root.style.setProperty("--color-logo-primary", values.logoPrimary);
    root.style.setProperty("--color-background-ui", values.backgroundUi);
    root.style.setProperty("--color-logo-stroke", values.logoStroke);
}
```

`document.documentElement.style.setProperty()` sets an inline style on `<html>`, which overrides any CSS file definition. Since CSS variables are inherited, every element in the page sees the new value instantly.

### Auto-switching with system theme

```typescript
let _mediaQuery: MediaQueryList | null = null;
let _currentColor: AccentColor = "pink";

export function initAccentColor(color: AccentColor): void {
    _currentColor = color;
    applyAccentColor(color);

    // Listen for system theme changes (only set up once)
    if (!_mediaQuery) {
        _mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        _mediaQuery.addEventListener("change", () => {
            applyAccentColor(_currentColor);  // Re-apply with current color
        });
    }
}
```

When the user switches macOS from light to dark mode (or vice versa):
1. The browser fires a `change` event on the `prefers-color-scheme` media query
2. Our listener catches it
3. We re-apply the current accent color, but now `isDark` returns a different value
4. The CSS variables switch to the dark (or light) variant

---

## Layer 4: Where Colors Are Consumed

### SVG Icons (direct CSS variable reference)

```tsx
// File: src/components/icons/MicrophoneIcon.tsx

export const MicrophoneIcon = ({ color = "var(--color-logo-primary, #FAA2CA)" }) => (
    <svg>
        <path fill={color} ... />
    </svg>
);
```

**`var(--color-logo-primary, #FAA2CA)`** means: use the CSS variable, but if it's not defined, fall back to `#FAA2CA` (the original pink). This makes the icon work even before the accent color is initialized.

Same pattern in `TranscriptionIcon.tsx` and `CancelIcon.tsx`.

### Overlay CSS (color-mix function)

```css
/* File: src/overlay/RecordingOverlay.css */

/* Before (hardcoded): */
background: #ffe5ee;

/* After (dynamic): */
background: color-mix(in srgb, var(--color-logo-primary, #faa2ca) 35%, white);
```

**What `color-mix()` does:** It mixes two colors together. Here it takes 35% of the accent color and 65% white, creating a very light tinted background. This works with ANY accent color automatically.

```css
/* Another example: */
background: color-mix(in srgb, var(--color-logo-primary, #faa2ca) 20%, transparent);
```

20% accent color + 80% transparent = a subtle translucent accent tint.

### Audio Player gradient

```tsx
// File: src/components/ui/AudioPlayer.tsx

<div style={{
    background: `linear-gradient(to right, var(--color-logo-primary) ${progress}%, #e5e7eb ${progress}%)`
}} />
```

The progress bar fills with the accent color from left to right.

---

## Layer 5: The Picker UI

```tsx
// File: src/components/settings/general/AccentColorPicker.tsx

export const AccentColorPicker: React.FC = () => {
    const { t } = useTranslation();
    const { settings, updateSetting } = useSettings();
    const current = settings?.accent_color ?? "pink";

    const handleSelect = (color: AccentColor) => {
        if (color === current) return;
        applyAccentColor(color);             // 1. Instant visual feedback
        updateSetting("accent_color", color); // 2. Persist to backend
    };

    return (
        <SettingsGroup title={t("settings.general.accentColor.title")}>
            <div className="flex items-center gap-3 px-4 py-3">
                {ACCENT_COLOR_KEYS.map((color) => (
                    <button
                        key={color}
                        onClick={() => handleSelect(color)}
                        style={{ backgroundColor: getSwatchColor(color) }}
                        className={`
                            w-7 h-7 rounded-full transition-transform
                            hover:scale-110
                            ${current === color ? "ring-2 ring-offset-2" : ""}
                        `}
                    >
                        {current === color && <Check className="w-4 h-4 text-white" />}
                    </button>
                ))}
            </div>
        </SettingsGroup>
    );
};
```

**Optimistic update pattern:**
1. `applyAccentColor(color)` -- Changes CSS variables immediately. The user sees the color change in ~1ms.
2. `updateSetting("accent_color", color)` -- Sends to Rust backend asynchronously. Takes ~10ms, but the user doesn't wait for it.

If the backend somehow rejects the change, the Zustand store rolls back the setting, and the next render would revert. In practice, this never fails.

---

## The Overlay Problem

The recording overlay is a separate Tauri window. It doesn't share the main window's DOM. So:

```
Main window: document.documentElement has --color-logo-primary = "#7aabe0"

Overlay window: document.documentElement has --color-logo-primary = ??? (undefined!)
```

### Solution: Load settings independently in the overlay

```tsx
// File: src/overlay/RecordingOverlay.tsx

useEffect(() => {
    commands.getAppSettings().then((result) => {
        if (result.status === "ok") {
            initAccentColor(result.data.accent_color);
        }
    }).catch(() => {});
}, []);
```

When the overlay mounts, it:
1. Calls `getAppSettings()` to read the current accent color from Rust
2. Calls `initAccentColor()` to set the CSS variables in the overlay's DOM
3. Also sets up the theme change listener for the overlay

---

## Default CSS Variables (Tailwind v4)

The CSS variables have default values defined in `App.css` via Tailwind v4's `@theme` block:

```css
/* File: src/App.css */
@theme {
    --color-logo-primary: #FAA2CA;
    --color-background-ui: #da5893;
    --color-logo-stroke: #382731;
}
```

These are the "Pink" defaults. When `applyAccentColor()` runs, it overrides these values with inline styles on `<html>`, which have higher CSS specificity.

---

## What You Should Be Able to Explain

1. **"How does the theme change instantly?"**
   → CSS custom properties. We set them on `document.documentElement` with JavaScript. Every element using `var(--color-logo-primary)` updates immediately because CSS variables are live references, not static values.

2. **"How do you handle light/dark mode?"**
   → Each color has light and dark variants. We listen for `matchMedia("prefers-color-scheme: dark")` changes and re-apply the appropriate variant.

3. **"What about the overlay window?"**
   → It's a separate WebView with its own DOM. We load the accent color from Rust settings when the overlay mounts, independent of the main window.

4. **"What's `color-mix()`?"**
   → A CSS function that blends two colors. We use it to derive semi-transparent tints from the accent color without hardcoding every variant.

5. **"Why optimistic updates?"**
   → The user expects instant feedback when clicking a color swatch. Writing to the backend is async (~10ms), so we apply the CSS change immediately and persist in the background.

---

## Next: [06 - History & Export](./06-history-export.md)
