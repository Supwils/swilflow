import React, { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { Button } from "../../ui/Button";
import { FileAudio, X } from "lucide-react";

type ImportState =
  | { stage: "idle" }
  | { stage: "processing" }
  | { stage: "done"; text: string; tempFileName: string }
  | { stage: "error"; message: string };

export const ImportAudio: React.FC = () => {
  const { t } = useTranslation();
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState>({ stage: "idle" });
  const [showCopied, setShowCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel the "Copied!" badge reset timer if the component unmounts mid-countdown
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleChooseFile = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [
          {
            name: t("settings.general.importAudio.supportedFormats"),
            extensions: ["wav"],
          },
        ],
      });
      if (typeof selected === "string" && selected.length > 0) {
        setFilePath(selected);
        // Extract just the filename for display
        const parts = selected.replace(/\\/g, "/").split("/");
        setFileName(parts[parts.length - 1] ?? selected);
        // Reset previous result when new file is chosen
        setImportState({ stage: "idle" });
      }
    } catch (err) {
      console.error("File dialog error:", err);
    }
  };

  const handleProcess = async () => {
    if (!filePath) {
      toast.error(t("settings.general.importAudio.errors.noFile"));
      return;
    }

    // Check upfront that a model is loaded so the error message is localised
    // and shown immediately rather than surfacing as a raw Rust error string.
    try {
      const status = await commands.getModelLoadStatus();
      if (status.status === "ok" && !status.data.is_loaded) {
        setImportState({
          stage: "error",
          message: t("settings.general.importAudio.noModel"),
        });
        return;
      }
    } catch {
      // If the status check itself fails, proceed anyway and let the transcription
      // command surface the real error with a proper message.
    }

    setImportState({ stage: "processing" });

    try {
      const result = await commands.transcribeAudioFile(filePath);
      if (result.status === "ok") {
        if (!result.data.text.trim()) {
          // Clean up the empty temp file
          await commands.discardImportedTranscription(result.data.tempFileName).catch(() => {});
          setImportState({ stage: "error", message: t("settings.general.importAudio.errors.empty") });
        } else {
          setImportState({
            stage: "done",
            text: result.data.text,
            tempFileName: result.data.tempFileName,
          });
        }
      } else {
        const errMsg = String(result.error);
        setImportState({ stage: "error", message: t("settings.general.importAudio.errors.failed", { error: errMsg }) });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setImportState({ stage: "error", message: t("settings.general.importAudio.errors.failed", { error: errMsg }) });
    }
  };

  const handleCopy = async () => {
    if (importState.stage !== "done") return;
    try {
      await navigator.clipboard.writeText(importState.text);
      setShowCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setShowCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleSaveToHistory = async () => {
    if (importState.stage !== "done") return;
    try {
      const result = await commands.saveImportedTranscription(
        importState.tempFileName,
        importState.text,
      );
      if (result.status === "ok") {
        toast.success(t("settings.general.importAudio.saved"));
        // Reset the panel after save
        setImportState({ stage: "idle" });
        setFilePath(null);
        setFileName(null);
      } else {
        toast.error(t("settings.general.importAudio.saveError"));
      }
    } catch (err) {
      console.error("Failed to save:", err);
      toast.error(t("settings.general.importAudio.saveError"));
    }
  };

  const handleDiscard = async () => {
    if (importState.stage === "done") {
      // Clean up the temp file
      await commands.discardImportedTranscription(importState.tempFileName).catch(console.error);
    }
    setImportState({ stage: "idle" });
    setFilePath(null);
    setFileName(null);
  };

  const isProcessing = importState.stage === "processing";

  return (
    <SettingsGroup title={t("settings.general.importAudio.title")}>
      <div className="px-4 py-3 space-y-3">
        {/* File picker row */}
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleChooseFile}
            disabled={isProcessing}
            className="flex items-center gap-2 shrink-0"
          >
            <FileAudio className="w-4 h-4" />
            <span>{t("settings.general.importAudio.chooseFile")}</span>
          </Button>
          <span className="text-xs text-text/60 truncate flex-1 min-w-0">
            {fileName ?? t("settings.general.importAudio.noFileSelected")}
          </span>
          {fileName && !isProcessing && (
            <button
              type="button"
              onClick={handleDiscard}
              className="text-mid-gray hover:text-text transition-colors cursor-pointer shrink-0"
              title={t("settings.general.importAudio.discard")}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Supported formats hint */}
        <p className="text-xs text-mid-gray/60">
          {t("settings.general.importAudio.supportedFormats")}
        </p>

        {/* Process button */}
        {filePath && importState.stage !== "done" && (
          <Button
            variant="primary"
            size="sm"
            onClick={handleProcess}
            disabled={isProcessing}
            className="w-full"
          >
            {isProcessing
              ? t("settings.general.importAudio.processing")
              : t("settings.general.importAudio.process")}
          </Button>
        )}

        {/* Error state */}
        {importState.stage === "error" && (
          <p className="text-xs text-red-500">{importState.message}</p>
        )}

        {/* Result */}
        {importState.stage === "done" && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-mid-gray uppercase tracking-wide">
              {t("settings.general.importAudio.result")}
            </p>
            <div className="rounded-md bg-mid-gray/10 border border-mid-gray/20 p-3 max-h-48 overflow-y-auto">
              <p className="text-sm text-text/90 whitespace-pre-wrap break-words select-text cursor-text">
                {importState.text}
              </p>
            </div>
            {/* Action buttons */}
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopy}
                className="flex-1"
              >
                {showCopied
                  ? t("settings.general.importAudio.copied")
                  : t("settings.general.importAudio.copy")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveToHistory}
                className="flex-1"
              >
                {t("settings.general.importAudio.saveToHistory")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDiscard}
              >
                {t("settings.general.importAudio.discard")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </SettingsGroup>
  );
};
