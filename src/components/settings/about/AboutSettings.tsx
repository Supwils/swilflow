import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { SettingContainer } from "../../ui/SettingContainer";
import { Button } from "../../ui/Button";
import { AppDataDirectory } from "../AppDataDirectory";
import { AppLanguageSelector } from "../AppLanguageSelector";
import { LogDirectory } from "../debug";
import { commands, type HistoryStats } from "@/bindings";

/** Format a Unix timestamp (seconds) into a readable local date string. */
function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const StatCard: React.FC<{ label: string; value: string | number }> = ({
  label,
  value,
}) => (
  <div className="flex flex-col items-center justify-center p-3 bg-mid-gray/10 rounded-lg border border-mid-gray/20 gap-1">
    <span className="text-xl font-semibold text-text">{value}</span>
    <span className="text-xs text-mid-gray text-center">{label}</span>
  </div>
);

export const AboutSettings: React.FC = () => {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        const appVersion = await getVersion();
        setVersion(appVersion);
      } catch (error) {
        console.error("Failed to get app version:", error);
        // Leave version as empty string rather than showing a wrong fallback
        setVersion("");
      }
    };

    const fetchStats = async () => {
      try {
        const result = await commands.getHistoryStats();
        if (result.status === "ok") {
          setStats(result.data);
        }
      } catch (error) {
        console.error("Failed to fetch history stats:", error);
      } finally {
        setStatsLoading(false);
      }
    };

    fetchVersion();
    fetchStats();
  }, []);

  const handleDonateClick = async () => {
    try {
      await openUrl("https://github.com/supwilsoft/swilflow");
    } catch (error) {
      console.error("Failed to open link:", error);
    }
  };

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.about.title")}>
        <AppLanguageSelector descriptionMode="tooltip" grouped={true} />
        <SettingContainer
          title={t("settings.about.version.title")}
          description={t("settings.about.version.description")}
          grouped={true}
        >
          {/* eslint-disable-next-line i18next/no-literal-string */}
          {version ? <span className="text-sm font-mono">v{version}</span> : <span className="text-sm text-mid-gray/50">{t("common.loading")}</span>}
        </SettingContainer>

        <SettingContainer
          title={t("settings.about.supportDevelopment.title")}
          description={t("settings.about.supportDevelopment.description")}
          grouped={true}
        >
          <Button variant="primary" size="md" onClick={handleDonateClick}>
            {t("settings.about.supportDevelopment.button")}
          </Button>
        </SettingContainer>

        <SettingContainer
          title={t("settings.about.sourceCode.title")}
          description={t("settings.about.sourceCode.description")}
          grouped={true}
        >
          <Button
            variant="secondary"
            size="md"
            onClick={() => openUrl("https://github.com/supwilsoft/swilflow")}
          >
            {t("settings.about.sourceCode.button")}
          </Button>
        </SettingContainer>

        <AppDataDirectory descriptionMode="tooltip" grouped={true} />
        <LogDirectory grouped={true} />
      </SettingsGroup>

      {/* Usage statistics panel */}
      <SettingsGroup title={t("settings.about.stats.title")}>
        <div className="px-4 py-3">
          {statsLoading ? (
            <p className="text-sm text-mid-gray">
              {t("settings.about.stats.loading")}
            </p>
          ) : !stats || stats.total_entries === 0 ? (
            <p className="text-sm text-mid-gray">
              {t("settings.about.stats.noData")}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <StatCard
                  label={t("settings.about.stats.totalTranscriptions")}
                  value={stats.total_entries}
                />
                <StatCard
                  label={t("settings.about.stats.savedTranscriptions")}
                  value={stats.saved_entries}
                />
              </div>
              {stats.earliest_timestamp !== null && (
                <p className="text-xs text-mid-gray text-center">
                  {t("settings.about.stats.since")}{" "}
                  {formatDate(stats.earliest_timestamp)}
                </p>
              )}
            </div>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.about.acknowledgments.title")}>
        <SettingContainer
          title={t("settings.about.acknowledgments.whisper.title")}
          description={t("settings.about.acknowledgments.whisper.description")}
          grouped={true}
          layout="stacked"
        >
          <div className="text-sm text-mid-gray">
            {t("settings.about.acknowledgments.whisper.details")}
          </div>
        </SettingContainer>
      </SettingsGroup>
    </div>
  );
};
