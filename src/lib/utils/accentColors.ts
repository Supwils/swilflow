import type { AccentColor } from "@/bindings";

interface ColorValues {
  logoPrimary: string;
  backgroundUi: string;
  logoStroke: string;
}

interface AccentColorDef {
  light: ColorValues;
  dark: ColorValues;
}

const ACCENT_COLORS: Record<AccentColor, AccentColorDef> = {
  pink: {
    light: {
      logoPrimary: "#faa2ca",
      backgroundUi: "#da5893",
      logoStroke: "#382731",
    },
    dark: {
      logoPrimary: "#f28cbb",
      backgroundUi: "#da5893",
      logoStroke: "#fad1ed",
    },
  },
  gold: {
    light: {
      logoPrimary: "#f0c060",
      backgroundUi: "#c49520",
      logoStroke: "#3a3020",
    },
    dark: {
      logoPrimary: "#e8b84d",
      backgroundUi: "#c49520",
      logoStroke: "#f5e0b0",
    },
  },
  orange: {
    light: {
      logoPrimary: "#f0945a",
      backgroundUi: "#d06828",
      logoStroke: "#3a2820",
    },
    dark: {
      logoPrimary: "#e8874a",
      backgroundUi: "#d06828",
      logoStroke: "#f5d0b5",
    },
  },
  green: {
    light: {
      logoPrimary: "#7ec89a",
      backgroundUi: "#3a9960",
      logoStroke: "#203828",
    },
    dark: {
      logoPrimary: "#6dbf8a",
      backgroundUi: "#3a9960",
      logoStroke: "#c0f0d0",
    },
  },
  blue: {
    light: {
      logoPrimary: "#7aabe0",
      backgroundUi: "#3a78b8",
      logoStroke: "#202838",
    },
    dark: {
      logoPrimary: "#6a9dd6",
      backgroundUi: "#3a78b8",
      logoStroke: "#b8d8f5",
    },
  },
  purple: {
    light: {
      logoPrimary: "#b898d8",
      backgroundUi: "#8060b0",
      logoStroke: "#2e2038",
    },
    dark: {
      logoPrimary: "#a888cc",
      backgroundUi: "#8060b0",
      logoStroke: "#dcc8f0",
    },
  },
  coral: {
    light: {
      logoPrimary: "#f08070",
      backgroundUi: "#d05040",
      logoStroke: "#382020",
    },
    dark: {
      logoPrimary: "#e87060",
      backgroundUi: "#d05040",
      logoStroke: "#f5c8c0",
    },
  },
};

/** All available accent color keys, in display order. */
export const ACCENT_COLOR_KEYS: AccentColor[] = [
  "pink",
  "gold",
  "orange",
  "green",
  "blue",
  "purple",
  "coral",
];

/** Get the swatch preview color (light-mode logoPrimary) for a given accent. */
export function getSwatchColor(color: AccentColor): string {
  return ACCENT_COLORS[color].light.logoPrimary;
}

/**
 * Apply the given accent color to the document, picking the right
 * light/dark variant based on the current system theme.
 */
export function applyAccentColor(color: AccentColor): void {
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const values = isDark
    ? ACCENT_COLORS[color].dark
    : ACCENT_COLORS[color].light;

  const root = document.documentElement;
  root.style.setProperty("--color-logo-primary", values.logoPrimary);
  root.style.setProperty("--color-background-ui", values.backgroundUi);
  root.style.setProperty("--color-logo-stroke", values.logoStroke);
}

let _mediaQuery: MediaQueryList | null = null;
let _currentColor: AccentColor = "pink";

/**
 * Initialize accent color and listen for system theme changes.
 * Safe to call multiple times — only one listener is ever active.
 */
export function initAccentColor(color: AccentColor): void {
  _currentColor = color;
  applyAccentColor(color);

  if (!_mediaQuery) {
    _mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    _mediaQuery.addEventListener("change", () => {
      applyAccentColor(_currentColor);
    });
  }
}
