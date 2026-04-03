import React, { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  Check,
  CheckSquare,
  Copy,
  Download,
  FolderOpen,
  RotateCcw,
  Search,
  Square,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  commands,
  events,
  type HistoryEntry,
  type HistoryUpdatePayload,
} from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import { formatDateTime } from "@/utils/dateFormat";
import type { ExportFormat } from "@/bindings";
import { AudioPlayer } from "../../ui/AudioPlayer";
import { Button } from "../../ui/Button";
import { ExportPanel, type ExportScope } from "./ExportPanel";

const IconButton: React.FC<{
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, disabled, active, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`p-1.5 rounded-md flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-text/20 ${
      active
        ? "text-logo-primary hover:text-logo-primary/80"
        : "text-text/50 hover:text-logo-primary"
    }`}
    title={title}
  >
    {children}
  </button>
);

const PAGE_SIZE = 30;

interface OpenRecordingsButtonProps {
  onClick: () => void;
  label: string;
}

const OpenRecordingsButton: React.FC<OpenRecordingsButtonProps> = ({
  onClick,
  label,
}) => (
  <Button
    onClick={onClick}
    variant="secondary"
    size="sm"
    className="flex items-center gap-2"
    title={label}
  >
    <FolderOpen className="w-4 h-4" />
    <span>{label}</span>
  </Button>
);

export const HistorySettings: React.FC = () => {
  const { t } = useTranslation();
  const osType = useOsType();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<HistoryEntry[]>([]);
  const loadingRef = useRef(false);
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const exportButtonRef = useRef<HTMLDivElement>(null);

  // Export panel state — lifted here so it persists across panel open/close
  const [exportFormat, setExportFormat] = useState<ExportFormat>("Csv");
  const [exportScope, setExportScope] = useState<ExportScope>("all");
  const [exportTimeRange, setExportTimeRange] = useState("7d");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  // isSearchPending: user has typed but the 300ms debounce hasn't fired yet.
  // isSearching:    the debounce fired and the backend query is in-flight.
  // Both together prevent showing "no results" before any query has completed.
  const [isSearchPending, setIsSearchPending] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref that mirrors searchQuery so event listener callbacks (set up with empty
  // deps) can read the latest value without capturing a stale closure.
  const searchQueryRef = useRef("");

  // Keep refs in sync so callbacks with empty deps can read latest values
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  const loadPage = useCallback(async (cursor?: number) => {
    const isFirstPage = cursor === undefined;
    if (!isFirstPage && loadingRef.current) return;
    loadingRef.current = true;

    if (isFirstPage) setLoading(true);

    try {
      const result = await commands.getHistoryEntries(
        cursor ?? null,
        PAGE_SIZE,
      );
      if (result.status === "ok") {
        const { entries: newEntries, has_more } = result.data;
        setEntries((prev) =>
          isFirstPage ? newEntries : [...prev, ...newEntries],
        );
        setHasMore(has_more);
      }
    } catch (error) {
      console.error("Failed to load history entries:", error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  const loadSearchPage = useCallback(
    async (query: string, cursor?: number) => {
      const isFirstPage = cursor === undefined;
      if (!isFirstPage && loadingRef.current) return;
      loadingRef.current = true;

      if (isFirstPage) setIsSearching(true);

      try {
        const result = await commands.searchHistoryEntries(
          query,
          cursor ?? null,
          PAGE_SIZE,
        );
        if (result.status === "ok") {
          const { entries: newEntries, has_more } = result.data;
          setEntries((prev) =>
            isFirstPage ? newEntries : [...prev, ...newEntries],
          );
          setHasMore(has_more);
        }
      } catch (error) {
        console.error("Failed to search history entries:", error);
      } finally {
        setIsSearching(false);
        loadingRef.current = false;
      }
    },
    [],
  );

  // Debounced search: fires 300 ms after the user stops typing.
  // isSearchPending is set immediately so the empty-state branch never
  // shows "no results" while the user is still typing.
  const handleSearchChange = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
      if (query.trim() === "") {
        setIsSearchPending(false);
        loadPage();
        return;
      }
      setIsSearchPending(true);
      searchDebounceRef.current = setTimeout(() => {
        setIsSearchPending(false);
        loadSearchPage(query.trim());
      }, 300);
    },
    [loadPage, loadSearchPage],
  );

  // Initial load
  useEffect(() => {
    loadPage();
  }, [loadPage]);

  // Infinite scroll via IntersectionObserver — uses search or normal load.
  // Guard against isSearchPending too: if the debounce hasn't fired yet the
  // current searchQuery may change before the observer callback runs, which
  // would load a page for the wrong (stale) query term.
  useEffect(() => {
    if (loading || isSearching || isSearchPending) return;

    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (observerEntries) => {
        const first = observerEntries[0];
        if (first.isIntersecting) {
          const lastEntry = entriesRef.current[entriesRef.current.length - 1];
          if (lastEntry) {
            if (searchQuery.trim()) {
              loadSearchPage(searchQuery.trim(), lastEntry.id);
            } else {
              loadPage(lastEntry.id);
            }
          }
        }
      },
      { threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, isSearching, isSearchPending, hasMore, loadPage, loadSearchPage, searchQuery]);

  // Listen for new entries added from the transcription pipeline
  useEffect(() => {
    const unlisten = events.historyUpdatePayload.listen((event) => {
      const payload: HistoryUpdatePayload = event.payload;
      if (payload.action === "added") {
        // Only prepend when the user is NOT in an active search — appending a
        // freshly transcribed entry that may not match the current query would
        // break the logical integrity of the filtered results.
        if (!searchQueryRef.current.trim()) {
          setEntries((prev) => [payload.entry, ...prev]);
        }
      } else if (payload.action === "updated") {
        setEntries((prev) =>
          prev.map((e) => (e.id === payload.entry.id ? payload.entry : e)),
        );
      }
      // "deleted" and "toggled" are handled by optimistic updates only,
      // so we intentionally ignore them here to avoid double-mutation.
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const toggleSaved = async (id: number) => {
    // Optimistic update
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
    );
    try {
      const result = await commands.toggleHistoryEntrySaved(id);
      if (result.status !== "ok") {
        // Revert on failure
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
        );
      }
    } catch (error) {
      console.error("Failed to toggle saved status:", error);
      // Revert on failure
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
      );
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

  const getAudioUrl = useCallback(
    async (fileName: string) => {
      try {
        const result = await commands.getAudioFilePath(fileName);
        if (result.status === "ok") {
          if (osType === "linux") {
            const fileData = await readFile(result.data);
            const blob = new Blob([fileData], { type: "audio/wav" });
            return URL.createObjectURL(blob);
          }
          return convertFileSrc(result.data, "asset");
        }
        return null;
      } catch (error) {
        console.error("Failed to get audio file path:", error);
        return null;
      }
    },
    [osType],
  );

  const deleteAudioEntry = async (id: number) => {
    // Snapshot whether this entry was selected before we optimistically remove it,
    // so we can restore the selection state if the backend delete fails.
    const wasSelected = selectedIds.has(id);

    // Optimistically remove from both the entry list and any active selection
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev; // avoid unnecessary re-render
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    try {
      const result = await commands.deleteHistoryEntry(id);
      if (result.status !== "ok") {
        // Restore selection before reloading so the entry re-appears selected
        if (wasSelected) {
          setSelectedIds((prev) => new Set([...prev, id]));
        }
        loadPage();
      }
    } catch (error) {
      console.error("Failed to delete entry:", error);
      if (wasSelected) {
        setSelectedIds((prev) => new Set([...prev, id]));
      }
      loadPage();
    }
  };

  const retryHistoryEntry = async (id: number) => {
    const result = await commands.retryHistoryEntryTranscription(id);
    if (result.status !== "ok") {
      throw new Error(String(result.error));
    }
  };

  const openRecordingsFolder = async () => {
    try {
      const result = await commands.openRecordingsFolder();
      if (result.status !== "ok") {
        throw new Error(String(result.error));
      }
    } catch (error) {
      console.error("Failed to open recordings folder:", error);
    }
  };

  const toggleEntrySelection = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllLoaded = () => {
    setSelectedIds(new Set(entries.map((e) => e.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const exitSelectMode = () => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
  };

  let content: React.ReactNode;

  if (loading) {
    // Initial page load — nothing to show yet
    content = (
      <div className="px-4 py-3 text-center text-text/60">
        {t("settings.history.loading")}
      </div>
    );
  } else if (entries.length === 0) {
    // Only show "no results" once a search has actually completed (not while
    // the debounce is pending or the backend query is in-flight).
    const anySearchActive = isSearchPending || isSearching;
    content = (
      <div className="px-4 py-3 text-center text-text/60">
        {searchQuery.trim() && !anySearchActive
          ? t("settings.history.search.noResults")
          : searchQuery.trim()
            ? t("settings.history.loading")
            : t("settings.history.empty")}
      </div>
    );
  } else {
    // Show entries; dim them slightly while a search query is resolving so the
    // user gets visual feedback without the jarring full-blank-then-refill.
    content = (
      <div className={isSearching || isSearchPending ? "opacity-50 pointer-events-none" : ""}>
        <div className="divide-y divide-mid-gray/20">
          {entries.map((entry) => (
            <HistoryEntryComponent
              key={entry.id}
              entry={entry}
              onToggleSaved={() => toggleSaved(entry.id)}
              onCopyText={() => copyToClipboard(entry.transcription_text)}
              getAudioUrl={getAudioUrl}
              deleteAudio={deleteAudioEntry}
              retryTranscription={retryHistoryEntry}
              isSelectMode={isSelectMode}
              isSelected={selectedIds.has(entry.id)}
              onToggleSelect={() => toggleEntrySelection(entry.id)}
            />
          ))}
        </div>
        {/* Sentinel for infinite scroll */}
        <div ref={sentinelRef} className="h-1" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <div className="space-y-2">
        <div className="px-4 flex items-center justify-between gap-3">
          <div className="shrink-0">
            <h2 className="text-xs font-medium text-mid-gray uppercase tracking-wide">
              {t("settings.history.title")}
            </h2>
          </div>
          {/* Search bar */}
          <div className="flex-1 max-w-xs relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mid-gray pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t("settings.history.search.placeholder")}
              className="w-full pl-7 pr-7 py-1 text-xs bg-mid-gray/10 border border-mid-gray/30 rounded-md focus:outline-none focus:border-logo-primary placeholder-mid-gray/60 transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => handleSearchChange("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-mid-gray hover:text-text transition-colors cursor-pointer"
                title={t("settings.history.search.clearSearch")}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isSelectMode && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={
                    entries.length > 0 && selectedIds.size === entries.length
                      ? deselectAll
                      : selectAllLoaded
                  }
                >
                  {entries.length > 0 && selectedIds.size === entries.length
                    ? t("settings.history.export.deselectAll")
                    : t("settings.history.export.selectAll")}
                </Button>
                <span className="text-xs text-text/60">
                  {t("settings.history.export.selectedCount", {
                    count: selectedIds.size,
                  })}
                </span>
                <Button variant="ghost" size="sm" onClick={exitSelectMode}>
                  {t("settings.history.export.exitSelectMode")}
                </Button>
              </>
            )}
            <div className="relative" ref={exportButtonRef}>
              <Button
                onClick={() => {
                  // Auto-set scope to "selected" only when the panel is currently
                  // closed and we are transitioning into it from select mode.
                  // Avoid overriding a scope the user has already manually chosen
                  // during a previous open of the same panel session.
                  if (!showExportPanel && isSelectMode && selectedIds.size > 0) {
                    setExportScope("selected");
                  }
                  setShowExportPanel((prev) => !prev);
                }}
                variant={
                  isSelectMode && selectedIds.size > 0
                    ? "primary-soft"
                    : "secondary"
                }
                size="sm"
                className="flex items-center gap-2"
                title={t("settings.history.export.button")}
              >
                <Download className="w-4 h-4" />
                <span>
                  {isSelectMode && selectedIds.size > 0
                    ? t("settings.history.export.exportSelected", {
                        count: selectedIds.size,
                      })
                    : t("settings.history.export.button")}
                </span>
              </Button>
              {showExportPanel && (
                <ExportPanel
                  onClose={() => setShowExportPanel(false)}
                  selectedIds={selectedIds}
                  isSelectMode={isSelectMode}
                  onEnterSelectMode={() => {
                    setIsSelectMode(true);
                    setExportScope("selected");
                    setShowExportPanel(false);
                  }}
                  onExportSuccess={() => {
                    // Clear selection after successful export
                    if (exportScope === "selected") {
                      setIsSelectMode(false);
                      setSelectedIds(new Set());
                    }
                  }}
                  format={exportFormat}
                  onFormatChange={setExportFormat}
                  scope={exportScope}
                  onScopeChange={setExportScope}
                  timeRange={exportTimeRange}
                  onTimeRangeChange={setExportTimeRange}
                  anchorRef={exportButtonRef}
                />
              )}
            </div>
            <OpenRecordingsButton
              onClick={openRecordingsFolder}
              label={t("settings.history.openFolder")}
            />
          </div>
        </div>
        <div className="bg-background border border-mid-gray/20 rounded-lg overflow-visible">
          {content}
        </div>
      </div>
    </div>
  );
};

interface HistoryEntryProps {
  entry: HistoryEntry;
  onToggleSaved: () => void;
  onCopyText: () => void;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  deleteAudio: (id: number) => Promise<void>;
  retryTranscription: (id: number) => Promise<void>;
  isSelectMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}

const HistoryEntryComponent: React.FC<HistoryEntryProps> = ({
  entry,
  onToggleSaved,
  onCopyText,
  getAudioUrl,
  deleteAudio,
  retryTranscription,
  isSelectMode = false,
  isSelected = false,
  onToggleSelect,
}) => {
  const { t, i18n } = useTranslation();
  const [showCopied, setShowCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const hasTranscription = entry.transcription_text.trim().length > 0;

  const handleLoadAudio = useCallback(
    () => getAudioUrl(entry.file_name),
    [getAudioUrl, entry.file_name],
  );

  const handleCopyText = () => {
    if (!hasTranscription) {
      return;
    }

    onCopyText();
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const handleDeleteEntry = async () => {
    try {
      await deleteAudio(entry.id);
    } catch (error) {
      console.error("Failed to delete entry:", error);
      toast.error(t("settings.history.deleteError"));
    }
  };

  const handleRetranscribe = async () => {
    try {
      setRetrying(true);
      await retryTranscription(entry.id);
    } catch (error) {
      console.error("Failed to re-transcribe:", error);
      toast.error(t("settings.history.retranscribeError"));
    } finally {
      setRetrying(false);
    }
  };

  const formattedDate = formatDateTime(String(entry.timestamp), i18n.language);

  return (
    <div
      className={`px-4 py-2 pb-5 flex flex-col gap-3 ${isSelectMode ? "cursor-pointer hover:bg-mid-gray/5" : ""}`}
      onClick={isSelectMode ? onToggleSelect : undefined}
    >
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          {isSelectMode && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect?.();
              }}
              className="text-text/60 hover:text-logo-primary transition-colors cursor-pointer"
            >
              {isSelected ? (
                <CheckSquare
                  width={18}
                  height={18}
                  className="text-logo-primary"
                />
              ) : (
                <Square width={18} height={18} />
              )}
            </button>
          )}
          <p className="text-sm font-medium">{formattedDate}</p>
        </div>
        <div className="flex items-center">
          <IconButton
            onClick={handleCopyText}
            disabled={!hasTranscription || retrying}
            title={t("settings.history.copyToClipboard")}
          >
            {showCopied ? (
              <Check width={16} height={16} />
            ) : (
              <Copy width={16} height={16} />
            )}
          </IconButton>
          <IconButton
            onClick={onToggleSaved}
            disabled={retrying}
            active={entry.saved}
            title={
              entry.saved
                ? t("settings.history.unsave")
                : t("settings.history.save")
            }
          >
            <Star
              width={16}
              height={16}
              fill={entry.saved ? "currentColor" : "none"}
            />
          </IconButton>
          <IconButton
            onClick={handleRetranscribe}
            disabled={retrying}
            title={t("settings.history.retranscribe")}
          >
            <RotateCcw
              width={16}
              height={16}
              style={
                retrying
                  ? { animation: "spin 1s linear infinite reverse" }
                  : undefined
              }
            />
          </IconButton>
          <IconButton
            onClick={handleDeleteEntry}
            disabled={retrying}
            title={t("settings.history.delete")}
          >
            <Trash2 width={16} height={16} />
          </IconButton>
        </div>
      </div>

      <p
        className={`italic text-sm pb-2 ${
          retrying
            ? ""
            : hasTranscription
              ? "text-text/90 select-text cursor-text whitespace-pre-wrap break-words"
              : "text-text/40"
        }`}
        style={
          retrying
            ? { animation: "transcribe-pulse 3s ease-in-out infinite" }
            : undefined
        }
      >
        {retrying && (
          <style>{`
            @keyframes transcribe-pulse {
              0%, 100% { color: color-mix(in srgb, var(--color-text) 40%, transparent); }
              50% { color: color-mix(in srgb, var(--color-text) 90%, transparent); }
            }
          `}</style>
        )}
        {retrying
          ? t("settings.history.transcribing")
          : hasTranscription
            ? entry.transcription_text
            : t("settings.history.transcriptionFailed")}
      </p>

      <AudioPlayer onLoadRequest={handleLoadAudio} className="w-full" />
    </div>
  );
};
