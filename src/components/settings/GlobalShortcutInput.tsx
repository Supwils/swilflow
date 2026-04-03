import React, { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getKeyName, normalizeKey, formatKeyCombination } from "../../lib/utils/keyboard";
import { SettingContainer } from "../ui/SettingContainer";
import { ShortcutBadge } from "../ui/ShortcutBadge";
import { useSettings } from "../../hooks/useSettings";
import { useOsType } from "../../hooks/useOsType";
import { commands } from "@/bindings";
import { toast } from "sonner";

interface GlobalShortcutInputProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  shortcutId: string;
  disabled?: boolean;
}

export const GlobalShortcutInput: React.FC<GlobalShortcutInputProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
  shortcutId,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateBinding, resetBinding, isUpdating, isLoading } =
    useSettings();

  // Displayed state — drives re-renders for the badge label only.
  const [keyPressed, setKeyPressed] = useState<string[]>([]);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [originalBinding, setOriginalBinding] = useState<string>("");

  // Refs that mirror the above state so event handlers always read the
  // latest values without causing the effect to re-register listeners.
  // Previously, having keyPressed/recordedKeys in the deps array caused
  // listeners to be torn down and re-added on every keypress, creating
  // a brief window where events could be missed and a stale-closure bug
  // where handleKeyUp read the OLD keyPressed and failed to commit.
  const keyPressedRef = useRef<string[]>([]);
  const recordedKeysRef = useRef<string[]>([]);
  const editingShortcutIdRef = useRef<string | null>(null);
  const originalBindingRef = useRef<string>("");

  const shortcutRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const osType = useOsType();

  const bindings = getSetting("bindings") || {};
  // Stable ref for bindings so event handlers can read the latest value
  // without being added to the effect's dependency array.
  const bindingsRef = useRef(bindings);
  useEffect(() => {
    bindingsRef.current = bindings;
  });

  useEffect(() => {
    // Only attach listeners when recording is active.
    if (editingShortcutIdRef.current === null) return;

    let cancelled = false;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (cancelled) return;
      if (e.repeat) return;
      e.preventDefault();

      const rawKey = getKeyName(e, osType);
      const key = normalizeKey(rawKey);

      if (!keyPressedRef.current.includes(key)) {
        keyPressedRef.current = [...keyPressedRef.current, key];
        setKeyPressed(keyPressedRef.current);

        if (!recordedKeysRef.current.includes(key)) {
          recordedKeysRef.current = [...recordedKeysRef.current, key];
          setRecordedKeys(recordedKeysRef.current);
        }
      }
    };

    const handleKeyUp = async (e: KeyboardEvent) => {
      if (cancelled) return;
      e.preventDefault();

      const rawKey = getKeyName(e, osType);
      const key = normalizeKey(rawKey);

      // Update the ref and state atomically — use the ref for all subsequent logic.
      keyPressedRef.current = keyPressedRef.current.filter((k) => k !== key);
      setKeyPressed(keyPressedRef.current);

      // Commit only when all keys have been released and at least one was recorded.
      if (keyPressedRef.current.length === 0 && recordedKeysRef.current.length > 0) {
        const id = editingShortcutIdRef.current;
        if (!id || !bindingsRef.current[id]) return;

        const modifiers = [
          "ctrl", "control", "shift", "alt", "option",
          "meta", "command", "cmd", "super", "win", "windows",
        ];
        const sortedKeys = [...recordedKeysRef.current].sort((a, b) => {
          const aIsMod = modifiers.includes(a.toLowerCase());
          const bIsMod = modifiers.includes(b.toLowerCase());
          if (aIsMod && !bIsMod) return -1;
          if (!aIsMod && bIsMod) return 1;
          return 0;
        });
        const newShortcut = sortedKeys.join("+");

        try {
          await updateBinding(id, newShortcut);
        } catch (error) {
          console.error("Failed to change binding:", error);
          toast.error(t("settings.general.shortcut.errors.set", { error: String(error) }));

          // Restore original on error
          const orig = originalBindingRef.current;
          if (orig) {
            try {
              await updateBinding(id, orig);
            } catch (resetError) {
              console.error("Failed to reset binding:", resetError);
              toast.error(t("settings.general.shortcut.errors.reset"));
            }
          }
        }

        // Exit editing mode
        editingShortcutIdRef.current = null;
        setEditingShortcutId(null);
        keyPressedRef.current = [];
        recordedKeysRef.current = [];
        setKeyPressed([]);
        setRecordedKeys([]);
        originalBindingRef.current = "";
        setOriginalBinding("");
      }
    };

    const handleClickOutside = async (e: MouseEvent) => {
      if (cancelled) return;
      const id = editingShortcutIdRef.current;
      if (!id) return;
      const activeElement = shortcutRefs.current.get(id);
      if (activeElement && !activeElement.contains(e.target as Node)) {
        // Restore original binding on cancel
        const orig = originalBindingRef.current;
        if (orig) {
          try {
            await updateBinding(id, orig);
          } catch (error) {
            console.error("Failed to restore original binding:", error);
            toast.error(t("settings.general.shortcut.errors.restore"));
          }
        } else {
          commands.resumeBinding(id).catch(console.error);
        }

        editingShortcutIdRef.current = null;
        setEditingShortcutId(null);
        keyPressedRef.current = [];
        recordedKeysRef.current = [];
        setKeyPressed([]);
        setRecordedKeys([]);
        originalBindingRef.current = "";
        setOriginalBinding("");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("click", handleClickOutside);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("click", handleClickOutside);
    };
    // editingShortcutId (state) drives whether we enter/exit this effect.
    // All other values are read via refs so we don't need them in deps,
    // avoiding the listener churn that caused the stale-closure bug.
  }, [editingShortcutId, updateBinding, osType, t]);

  const startRecording = async (id: string) => {
    if (editingShortcutIdRef.current === id) return;

    await commands.suspendBinding(id).catch(console.error);

    const orig = bindings[id]?.current_binding || "";
    originalBindingRef.current = orig;
    setOriginalBinding(orig);

    editingShortcutIdRef.current = id;
    setEditingShortcutId(id);

    keyPressedRef.current = [];
    recordedKeysRef.current = [];
    setKeyPressed([]);
    setRecordedKeys([]);
  };

  const formatCurrentKeys = (): string => {
    if (recordedKeys.length === 0) return t("settings.general.shortcut.pressKeys");
    return formatKeyCombination(recordedKeys.join("+"), osType);
  };

  const setShortcutRef = (id: string, ref: HTMLDivElement | null) => {
    shortcutRefs.current.set(id, ref);
  };

  if (isLoading) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.loading")}
        </div>
      </SettingContainer>
    );
  }

  if (Object.keys(bindings).length === 0) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.none")}
        </div>
      </SettingContainer>
    );
  }

  const binding = bindings[shortcutId];
  if (!binding) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.notFound")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.none")}
        </div>
      </SettingContainer>
    );
  }

  const translatedName = t(
    `settings.general.shortcut.bindings.${shortcutId}.name`,
    binding.name,
  );
  const translatedDescription = t(
    `settings.general.shortcut.bindings.${shortcutId}.description`,
    binding.description,
  );

  return (
    <SettingContainer
      title={translatedName}
      description={translatedDescription}
      descriptionMode={descriptionMode}
      grouped={grouped}
      disabled={disabled}
      layout="horizontal"
    >
      <div ref={(ref) => setShortcutRef(shortcutId, ref)}>
        <ShortcutBadge
          currentBinding={binding.current_binding}
          isRecording={editingShortcutId === shortcutId}
          recordingLabel={formatCurrentKeys()}
          onStartRecording={() => startRecording(shortcutId)}
          onReset={() => resetBinding(shortcutId)}
          isResetting={isUpdating(`binding_${shortcutId}`)}
        />
      </div>
    </SettingContainer>
  );
};
