/**
 * ShortcutBadge — shared visual component for keyboard shortcut display/recording.
 *
 * Used by both GlobalShortcutInput (JS-based) and HandyKeysShortcutInput (backend-based)
 * so both implementations render identically while keeping their recording logic separate.
 */
import React from "react";
import { useTranslation } from "react-i18next";
import { formatKeyCombination } from "../../lib/utils/keyboard";
import { useOsType } from "../../hooks/useOsType";
import { ResetButton } from "./ResetButton";

interface ShortcutBadgeProps {
  /** The shortcut string to display when not recording (e.g. "ctrl+shift+space"). */
  currentBinding: string;
  /** When true, shows the recording-in-progress style and `recordingLabel`. */
  isRecording: boolean;
  /** Keys currently being recorded, shown inside the recording badge. */
  recordingLabel?: string;
  /** Called when the badge is clicked to start recording. */
  onStartRecording: () => void;
  /** Called when the reset button is clicked. */
  onReset: () => void;
  /** When true, the reset button is disabled (e.g. while saving). */
  isResetting?: boolean;
}

export const ShortcutBadge: React.FC<ShortcutBadgeProps> = ({
  currentBinding,
  isRecording,
  recordingLabel,
  onStartRecording,
  onReset,
  isResetting = false,
}) => {
  const { t } = useTranslation();
  const osType = useOsType();

  const pressKeysText = t("settings.general.shortcut.pressKeys");

  return (
    <div className="flex items-center space-x-1">
      {isRecording ? (
        <div className="px-2 py-1 text-sm font-semibold border border-logo-primary bg-logo-primary/30 rounded-md select-none">
          {recordingLabel || pressKeysText}
        </div>
      ) : (
        <div
          className="px-2 py-1 text-sm font-semibold bg-mid-gray/10 border border-mid-gray/80 hover:bg-logo-primary/10 rounded-md cursor-pointer hover:border-logo-primary select-none"
          onClick={onStartRecording}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onStartRecording();
          }}
        >
          {formatKeyCombination(currentBinding, osType)}
        </div>
      )}
      <ResetButton onClick={onReset} disabled={isResetting} />
    </div>
  );
};
