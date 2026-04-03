use anyhow::Result;
use hound::{WavReader, WavSpec, WavWriter};
use log::debug;
use std::path::Path;

/// Read a WAV file and return normalised f32 samples.
pub fn read_wav_samples<P: AsRef<Path>>(file_path: P) -> Result<Vec<f32>> {
    let reader = WavReader::open(file_path.as_ref())?;
    let samples = reader
        .into_samples::<i16>()
        .map(|s| s.map(|v| v as f32 / i16::MAX as f32))
        .collect::<Result<Vec<f32>, _>>()?;
    Ok(samples)
}

/// Verify a WAV file by reading it back and checking the sample count.
pub fn verify_wav_file<P: AsRef<Path>>(file_path: P, expected_samples: usize) -> Result<()> {
    let reader = WavReader::open(file_path.as_ref())?;
    let actual_samples = reader.len() as usize;
    if actual_samples != expected_samples {
        anyhow::bail!(
            "WAV sample count mismatch: expected {}, got {}",
            expected_samples,
            actual_samples
        );
    }
    Ok(())
}

/// Save audio samples as a WAV file
pub fn save_wav_file<P: AsRef<Path>>(file_path: P, samples: &[f32]) -> Result<()> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::create(file_path.as_ref(), spec)?;

    // Convert f32 samples to i16 for WAV
    for sample in samples {
        let sample_i16 = (sample * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16)?;
    }

    writer.finalize()?;
    debug!("Saved WAV file: {:?}", file_path.as_ref());
    Ok(())
}

/// Read a WAV file, mix to mono, and resample to 16 kHz.
/// Supports 8/16/24/32-bit integer and 32-bit float PCM WAV files.
/// Returns normalized f32 samples in [-1, 1] at 16 kHz mono.
pub fn normalize_wav_for_transcription<P: AsRef<std::path::Path>>(
    file_path: P,
) -> anyhow::Result<Vec<f32>> {
    use rubato::{FftFixedIn, Resampler};

    const TARGET_SR: u32 = 16_000;
    const CHUNK: usize = 1_024;

    let reader = hound::WavReader::open(file_path.as_ref())?;
    let spec = reader.spec();
    let src_sr = spec.sample_rate;
    let channels = spec.channels as usize;

    if channels == 0 {
        anyhow::bail!("WAV file has zero channels");
    }

    // Read all samples as normalized f32 in [-1, 1]
    let raw: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, 8) => reader
            .into_samples::<i8>()
            .map(|s| s.map(|v| v as f32 / i8::MAX as f32))
            .collect::<Result<Vec<_>, _>>()?,
        (hound::SampleFormat::Int, 16) => reader
            .into_samples::<i16>()
            .map(|s| s.map(|v| v as f32 / i16::MAX as f32))
            .collect::<Result<Vec<_>, _>>()?,
        // 24-bit samples are stored in i32 but only occupy the lower 24 bits,
        // so the actual peak value is 2^23 - 1 = 8_388_607, NOT i32::MAX.
        // Using i32::MAX here would scale 24-bit audio down by a factor of ~256,
        // making the signal near-silent for the transcription model.
        (hound::SampleFormat::Int, 24) => reader
            .into_samples::<i32>()
            .map(|s| s.map(|v| v as f32 / 8_388_607.0_f32))
            .collect::<Result<Vec<_>, _>>()?,
        // 32-bit integer samples do use the full i32 range.
        (hound::SampleFormat::Int, 32) => reader
            .into_samples::<i32>()
            .map(|s| s.map(|v| v as f32 / i32::MAX as f32))
            .collect::<Result<Vec<_>, _>>()?,
        (hound::SampleFormat::Float, 32) => reader
            .into_samples::<f32>()
            .collect::<Result<Vec<_>, _>>()?,
        (fmt, bps) => anyhow::bail!("Unsupported WAV format: {:?} {}-bit", fmt, bps),
    };

    if raw.is_empty() {
        return Ok(Vec::new());
    }

    // Mix interleaved multi-channel audio down to mono
    let mono: Vec<f32> = if channels == 1 {
        raw
    } else {
        raw.chunks_exact(channels)
            .map(|ch| ch.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    // Return early if already at target rate
    if src_sr == TARGET_SR {
        return Ok(mono);
    }

    // Resample using rubato FftFixedIn (same crate/version as FrameResampler)
    let mut resampler =
        FftFixedIn::<f32>::new(src_sr as usize, TARGET_SR as usize, CHUNK, 1, 1)?;
    let mut output: Vec<f32> = Vec::with_capacity(
        (mono.len() as f64 * TARGET_SR as f64 / src_sr as f64).ceil() as usize + CHUNK,
    );

    let mut pos = 0_usize;
    while pos + CHUNK <= mono.len() {
        let out = resampler.process(&[&mono[pos..pos + CHUNK]], None)?;
        output.extend_from_slice(&out[0]);
        pos += CHUNK;
    }

    // Tail: pad remainder with zeros, then trim output to expected length
    if pos < mono.len() {
        let mut tail = vec![0.0_f32; CHUNK];
        let rem = mono.len() - pos;
        tail[..rem].copy_from_slice(&mono[pos..]);
        let out = resampler.process(&[&tail], None)?;
        let expected =
            (rem as f64 * TARGET_SR as f64 / src_sr as f64).ceil() as usize;
        let take = expected.min(out[0].len());
        output.extend_from_slice(&out[0][..take]);
    }

    Ok(output)
}
