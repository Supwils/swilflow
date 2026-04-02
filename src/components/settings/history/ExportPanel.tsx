import React, { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands } from "@/bindings";
import type { ExportFilter, ExportFormat } from "@/bindings";
import { Button } from "../../ui/Button";

export type ExportScope = "all" | "timeRange" | "selected";

interface ExportPanelProps {
  onClose: () => void;
  selectedIds: Set<number>;
  isSelectMode: boolean;
  onEnterSelectMode: () => void;
  onExportSuccess: () => void;
  format: ExportFormat;
  onFormatChange: (format: ExportFormat) => void;
  scope: ExportScope;
  onScopeChange: (scope: ExportScope) => void;
  timeRange: string;
  onTimeRangeChange: (range: string) => void;
}

const FORMAT_OPTIONS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: "Csv", label: "settings.history.export.csv", ext: "csv" },
  {
    value: "Markdown",
    label: "settings.history.export.markdown",
    ext: "md",
  },
  { value: "Json", label: "settings.history.export.json", ext: "json" },
];

const TIME_RANGE_OPTIONS = [
  { value: "7d", label: "settings.history.export.last7days", days: 7 },
  { value: "30d", label: "settings.history.export.last30days", days: 30 },
  { value: "3m", label: "settings.history.export.last3months", days: 90 },
  { value: "all", label: "settings.history.export.allTime", days: 0 },
];

export const ExportPanel: React.FC<ExportPanelProps> = ({
  onClose,
  selectedIds,
  isSelectMode,
  onEnterSelectMode,
  onExportSuccess,
  format,
  onFormatChange,
  scope,
  onScopeChange,
  timeRange,
  onTimeRangeChange,
}) => {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  // Click-outside to close
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  const buildFilter = (): ExportFilter => {
    switch (scope) {
      case "all":
        return { type: "All" };
      case "timeRange": {
        const option = TIME_RANGE_OPTIONS.find((o) => o.value === timeRange);
        if (!option || option.days === 0) {
          return { type: "All" };
        }
        const now = Math.floor(Date.now() / 1000);
        const from = now - option.days * 24 * 60 * 60;
        return { type: "TimeRange", from_timestamp: from, to_timestamp: now };
      }
      case "selected":
        return { type: "SelectedIds", ids: Array.from(selectedIds) };
    }
  };

  const handleExport = async () => {
    if (scope === "selected" && selectedIds.size === 0) {
      toast.error(t("settings.history.export.noSelection"));
      return;
    }

    const formatOption = FORMAT_OPTIONS.find((o) => o.value === format);
    const ext = formatOption?.ext ?? "csv";

    const filePath = await save({
      defaultPath: `swilflow-export.${ext}`,
      filters: [
        {
          name: `${formatOption?.value ?? "CSV"} Files`,
          extensions: [ext],
        },
      ],
    });

    if (!filePath) return; // User cancelled

    setExporting(true);
    try {
      const filter = buildFilter();
      const result = await commands.exportHistory(filePath, format, filter);
      if (result.status === "ok") {
        const count = result.data;
        if (count === 0) {
          toast.info(t("settings.history.export.successZero"));
        } else {
          toast.success(t("settings.history.export.success", { count }));
        }
        onExportSuccess();
        onClose();
      } else {
        toast.error(t("settings.history.export.error"));
      }
    } catch {
      toast.error(t("settings.history.export.error"));
    } finally {
      setExporting(false);
    }
  };

  const scopeOptions: { value: ExportScope; label: string }[] = [
    { value: "all", label: t("settings.history.export.scopeAll") },
    { value: "timeRange", label: t("settings.history.export.scopeTimeRange") },
    { value: "selected", label: t("settings.history.export.scopeSelected") },
  ];

  return (
    <div
      ref={panelRef}
      className="absolute top-full right-0 mt-1 w-72 bg-background border border-mid-gray/40 rounded-lg shadow-lg z-50 p-4 space-y-4"
    >
      {/* Format */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-mid-gray uppercase tracking-wide">
          {t("settings.history.export.formatLabel")}
        </label>
        <div className="flex gap-1">
          {FORMAT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onFormatChange(opt.value)}
              className={`flex-1 px-2 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                format === opt.value
                  ? "bg-logo-primary/20 border-logo-primary text-text"
                  : "bg-mid-gray/10 border-mid-gray/30 text-text/70 hover:border-logo-primary hover:bg-logo-primary/10"
              }`}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      {/* Scope */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-mid-gray uppercase tracking-wide">
          {t("settings.history.export.scopeLabel")}
        </label>
        <div className="flex gap-1">
          {scopeOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onScopeChange(opt.value)}
              className={`flex-1 px-2 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                scope === opt.value
                  ? "bg-logo-primary/20 border-logo-primary text-text"
                  : "bg-mid-gray/10 border-mid-gray/30 text-text/70 hover:border-logo-primary hover:bg-logo-primary/10"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Time Range sub-selector */}
      {scope === "timeRange" && (
        <div className="space-y-1.5">
          <div className="flex gap-1 flex-wrap">
            {TIME_RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onTimeRangeChange(opt.value)}
                className={`px-2 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                  timeRange === opt.value
                    ? "bg-logo-primary/20 border-logo-primary text-text"
                    : "bg-mid-gray/10 border-mid-gray/30 text-text/70 hover:border-logo-primary hover:bg-logo-primary/10"
                }`}
              >
                {t(opt.label)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Selected entries info */}
      {scope === "selected" && (
        <div className="space-y-2">
          {isSelectMode ? (
            <div className="flex items-center justify-between">
              <p className="text-xs text-text/60">
                {selectedIds.size > 0
                  ? t("settings.history.export.selectedCount", {
                      count: selectedIds.size,
                    })
                  : t("settings.history.export.noSelection")}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-text/50">
                {t("settings.history.export.selectModeHint")}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={() => {
                  onEnterSelectMode();
                }}
              >
                {t("settings.history.export.selectMode")}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Export button */}
      <Button
        variant="primary"
        size="sm"
        className="w-full"
        onClick={handleExport}
        disabled={exporting || (scope === "selected" && selectedIds.size === 0)}
      >
        {exporting
          ? t("common.loading")
          : scope === "selected" && selectedIds.size > 0
            ? t("settings.history.export.exportSelected", {
                count: selectedIds.size,
              })
            : t("settings.history.export.confirmExport")}
      </Button>
    </div>
  );
};
