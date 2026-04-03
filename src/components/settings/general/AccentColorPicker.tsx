import React from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import {
  ACCENT_COLOR_KEYS,
  getSwatchColor,
  applyAccentColor,
} from "@/lib/utils/accentColors";
import type { AccentColor } from "@/bindings";

const COLOR_LABELS: Record<AccentColor, string> = {
  pink: "settings.general.accentColor.pink",
  gold: "settings.general.accentColor.gold",
  orange: "settings.general.accentColor.orange",
  green: "settings.general.accentColor.green",
  blue: "settings.general.accentColor.blue",
  purple: "settings.general.accentColor.purple",
  coral: "settings.general.accentColor.coral",
};

export const AccentColorPicker: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();
  const current = settings?.accent_color ?? "pink";

  const handleSelect = (color: AccentColor) => {
    if (color === current) return;
    // Optimistic: apply CSS immediately, then persist
    applyAccentColor(color);
    updateSetting("accent_color", color);
  };

  return (
    <SettingsGroup title={t("settings.general.accentColor.title")}>
      <div className="px-4 py-3">
        <div className="flex items-center gap-3">
          {ACCENT_COLOR_KEYS.map((color) => {
            const isActive = color === current;
            return (
              <button
                key={color}
                type="button"
                title={t(COLOR_LABELS[color])}
                onClick={() => handleSelect(color)}
                className="relative w-8 h-8 rounded-full cursor-pointer transition-transform hover:scale-110 focus:outline-none"
                style={{
                  backgroundColor: getSwatchColor(color),
                  boxShadow: isActive
                    ? `0 0 0 2px var(--color-background), 0 0 0 4px ${getSwatchColor(color)}`
                    : "none",
                }}
              >
                {isActive && (
                  <Check className="absolute inset-0 m-auto w-4 h-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </SettingsGroup>
  );
};
