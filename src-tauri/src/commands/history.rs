use crate::actions::process_transcription_output;
use crate::managers::{
    history::{ExportFilter, ExportFormat, HistoryManager, HistoryStats, PaginatedHistory},
    transcription::TranscriptionManager,
};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub async fn get_history_entries(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    cursor: Option<i64>,
    limit: Option<usize>,
) -> Result<PaginatedHistory, String> {
    history_manager
        .get_history_entries(cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn toggle_history_entry_saved(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .toggle_saved_status(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_audio_file_path(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    file_name: String,
) -> Result<String, String> {
    let path = history_manager.get_audio_file_path(&file_name);
    path.to_str()
        .ok_or_else(|| "Invalid file path".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_history_entry(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .delete_entry(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn retry_history_entry_transcription(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    id: i64,
) -> Result<(), String> {
    let entry = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("History entry {} not found", id))?;

    let audio_path = history_manager.get_audio_file_path(&entry.file_name);
    let samples = crate::audio_toolkit::read_wav_samples(&audio_path)
        .map_err(|e| format!("Failed to load audio: {}", e))?;

    if samples.is_empty() {
        return Err("Recording has no audio samples".to_string());
    }

    transcription_manager.initiate_model_load();

    let tm = Arc::clone(&transcription_manager);
    let transcription = tauri::async_runtime::spawn_blocking(move || tm.transcribe(samples))
        .await
        .map_err(|e| format!("Transcription task panicked: {}", e))?
        .map_err(|e| e.to_string())?;

    if transcription.is_empty() {
        return Err("Recording contains no speech".to_string());
    }

    let processed =
        process_transcription_output(&app, &transcription, entry.post_process_requested).await;
    history_manager
        .update_transcription(
            id,
            transcription,
            processed.post_processed_text,
            processed.post_process_prompt,
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn update_history_limit(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    limit: usize,
) -> Result<(), String> {
    let mut settings = crate::settings::get_settings(&app);
    settings.history_limit = limit;
    crate::settings::write_settings(&app, settings);

    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn update_recording_retention_period(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    period: String,
) -> Result<(), String> {
    use crate::settings::RecordingRetentionPeriod;

    let retention_period = match period.as_str() {
        "never" => RecordingRetentionPeriod::Never,
        "preserve_limit" => RecordingRetentionPeriod::PreserveLimit,
        "days3" => RecordingRetentionPeriod::Days3,
        "weeks2" => RecordingRetentionPeriod::Weeks2,
        "months3" => RecordingRetentionPeriod::Months3,
        _ => return Err(format!("Invalid retention period: {}", period)),
    };

    let mut settings = crate::settings::get_settings(&app);
    settings.recording_retention_period = retention_period;
    crate::settings::write_settings(&app, settings);

    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn search_history_entries(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    query: String,
    cursor: Option<i64>,
    limit: Option<usize>,
) -> Result<PaginatedHistory, String> {
    history_manager
        .search_history_entries(query, cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_history_stats(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<HistoryStats, String> {
    history_manager
        .get_history_stats()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn export_history(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    file_path: String,
    format: ExportFormat,
    filter: ExportFilter,
) -> Result<usize, String> {
    history_manager
        .export_to_file(&file_path, &format, &filter)
        .map_err(|e| e.to_string())
}

/// Transcribe an audio file and store a temporary copy in the recordings directory.
/// Returns the transcribed text and a temporary filename that must be either committed
/// (via `save_imported_transcription`) or discarded (via `discard_imported_transcription`).
#[derive(serde::Serialize, specta::Type)]
pub struct TranscribeFileResult {
    pub text: String,
    pub temp_file_name: String,
}

#[tauri::command]
#[specta::specta]
pub async fn transcribe_audio_file(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    file_path: String,
) -> Result<TranscribeFileResult, String> {
    // Normalize the audio (mono, 16 kHz) — also validates it's a readable WAV
    let samples = crate::audio_toolkit::normalize_wav_for_transcription(&file_path)
        .map_err(|e| format!("Failed to read audio file: {}", e))?;

    if samples.is_empty() {
        return Err("Audio file contains no samples".to_string());
    }

    // Save a copy to the recordings directory so history can reference it
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp_file_name = format!("imported-{}.wav", ts);
    let dest_path = history_manager.recordings_dir().join(&temp_file_name);
    crate::audio_toolkit::save_wav_file(&dest_path, &samples)
        .map_err(|e| format!("Failed to save temp audio: {}", e))?;

    // Initiate model load if needed, then transcribe
    transcription_manager.initiate_model_load();
    let tm = Arc::clone(&transcription_manager);
    let text = tauri::async_runtime::spawn_blocking(move || tm.transcribe(samples))
        .await
        .map_err(|e| format!("Transcription task panicked: {}", e))?
        .map_err(|e| {
            // Clean up temp file on transcription failure
            let _ = std::fs::remove_file(&dest_path);
            e.to_string()
        })?;

    Ok(TranscribeFileResult {
        text,
        temp_file_name,
    })
}

/// Commit an import to the history database.
/// Call this after `transcribe_audio_file` if the user chooses to save the result.
#[tauri::command]
#[specta::specta]
pub async fn save_imported_transcription(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    temp_file_name: String,
    text: String,
) -> Result<(), String> {
    history_manager
        .save_entry(temp_file_name, text, false, None, None)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Discard an import — deletes the temporary WAV without saving to history.
/// Call this when the user dismisses the result without saving.
#[tauri::command]
#[specta::specta]
pub async fn discard_imported_transcription(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    temp_file_name: String,
) -> Result<(), String> {
    let path = history_manager.recordings_dir().join(&temp_file_name);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete temp file: {}", e))?;
    }
    Ok(())
}
