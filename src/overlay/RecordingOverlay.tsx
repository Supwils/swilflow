import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MicrophoneIcon,
  TranscriptionIcon,
  CancelIcon,
} from "../components/icons";
import "./RecordingOverlay.css";
import { commands } from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";
import { initAccentColor } from "@/lib/utils/accentColors";

type OverlayState = "recording" | "transcribing" | "processing";

// Number of bars displayed in the overlay
const NUM_BARS = 9;
const NUM_LEVELS = 16;

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  const [levels, setLevels] = useState<number[]>(() => new Array(NUM_BARS).fill(0));
  // Pre-allocated mutable buffer — avoids per-frame allocations in the hot path
  const smoothedRef = useRef<number[]>(new Array(NUM_LEVELS).fill(0));
  const direction = getLanguageDirection(i18n.language);

  // Load accent color from settings for this overlay window
  useEffect(() => {
    commands.getAppSettings().then((result) => {
      if (result.status === "ok") {
        initAccentColor(result.data.accent_color);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    // Track whether this effect instance has been cleaned up.
    // Any listener registered after cancellation is immediately unregistered.
    let cancelled = false;
    // Accumulates unlisten functions as each await resolves, so the cleanup
    // handler can call them even if the component unmounts mid-setup.
    const unlisteners: Array<() => void> = [];

    const setupEventListeners = async () => {
      // Listen for show-overlay event from Rust
      const unlistenShow = await listen("show-overlay", async (event) => {
        await syncLanguageFromSettings();
        const overlayState = event.payload as OverlayState;
        setState(overlayState);
        setIsVisible(true);
      });
      if (cancelled) { unlistenShow(); return; }
      unlisteners.push(unlistenShow);

      // Listen for hide-overlay event from Rust
      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
      });
      if (cancelled) { unlistenHide(); return; }
      unlisteners.push(unlistenHide);

      // Listen for mic-level updates.
      // Hot path: runs at ~50 Hz during recording — keep allocations minimal.
      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];
        const s = smoothedRef.current;

        // Mutate the smoothing buffer in-place (no new array per frame)
        for (let i = 0; i < NUM_LEVELS; i++) {
          s[i] = s[i] * 0.7 + (newLevels[i] ?? 0) * 0.3;
        }

        // React state update still needs a new array reference; spread the
        // first NUM_BARS elements directly to avoid slice() allocation.
        setLevels([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8]]);
      });
      if (cancelled) { unlistenLevel(); return; }
      unlisteners.push(unlistenLevel);
    };

    setupEventListeners();

    // Cleanup runs synchronously on unmount. Sets cancelled=true so any
    // in-progress await will unregister its listener immediately, and
    // calls all already-registered unlisten functions.
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const getIcon = () => {
    if (state === "recording") {
      return <MicrophoneIcon />;
    } else {
      return <TranscriptionIcon />;
    }
  };

  return (
    <div
      dir={direction}
      className={`recording-overlay ${isVisible ? "fade-in" : ""}`}
    >
      <div className="overlay-left">{getIcon()}</div>

      <div className="overlay-middle">
        {state === "recording" && (
          <div className="bars-container">
            {levels.map((v, i) => (
              <div
                key={i}
                className="bar"
                style={{
                  height: `${Math.min(20, 4 + Math.pow(v, 0.7) * 16)}px`, // Cap at 20px max height
                  transition: "height 60ms ease-out, opacity 120ms ease-out",
                  opacity: Math.max(0.2, v * 1.7), // Minimum opacity for visibility
                }}
              />
            ))}
          </div>
        )}
        {state === "transcribing" && (
          <div className="transcribing-text">{t("overlay.transcribing")}</div>
        )}
        {state === "processing" && (
          <div className="transcribing-text">{t("overlay.processing")}</div>
        )}
      </div>

      <div className="overlay-right">
        {state === "recording" && (
          <div
            className="cancel-button"
            onClick={() => {
              commands.cancelOperation();
            }}
          >
            <CancelIcon />
          </div>
        )}
      </div>
    </div>
  );
};

export default RecordingOverlay;
