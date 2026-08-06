//! Native microphone capture for the packaged app.
//!
//! WKWebView only exposes `navigator.mediaDevices` in a secure context, and the window is
//! served over loopback HTTP, so the browser recorder is unavailable inside the app. The
//! audio is captured here instead and handed to the frontend as a finished WAV file, which
//! then travels through the same local transcription route as the browser recording.

use std::{
    io::Cursor,
    sync::{
        Arc, Mutex,
        mpsc::{Receiver, Sender, channel},
    },
};

use cpal::{
    SampleFormat,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};

/// Whisper works on 16 kHz mono audio, so the file is prepared in exactly that shape.
const TARGET_SAMPLE_RATE: u32 = 16_000;
/// Roughly five minutes of input audio, so a forgotten recording cannot exhaust memory.
const MAX_INPUT_SAMPLES: usize = 5 * 60 * 48_000 * 2;

struct CapturedAudio {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
}

struct CaptureSession {
    stop: Sender<()>,
    finished: Receiver<Result<CapturedAudio, String>>,
}

#[derive(Default)]
pub struct VoiceCapture {
    session: Mutex<Option<CaptureSession>>,
}

fn device_error(reason: &str) -> String {
    format!("Das Mikrofon konnte nicht gestartet werden: {reason}")
}

/// Runs the capture stream on its own thread, because a cpal stream is not `Send`.
fn capture_thread(
    ready: Sender<Result<(), String>>,
    stop: Receiver<()>,
    finished: Sender<Result<CapturedAudio, String>>,
) {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        let _ = ready.send(Err(device_error("dieser Mac meldet kein Eingabegerät")));
        return;
    };
    let config = match device.default_input_config() {
        Ok(config) => config,
        Err(error) => {
            let _ = ready.send(Err(device_error(&error.to_string())));
            return;
        }
    };

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    let collected: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = collected.clone();
    let on_error = |error: cpal::StreamError| log::error!("Audio input stream failed: {error}");

    let stream = match config.sample_format() {
        SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &_| append(&sink, data.iter().copied()),
            on_error,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _: &_| {
                append(
                    &sink,
                    data.iter().map(|value| *value as f32 / i16::MAX as f32),
                )
            },
            on_error,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            &config.into(),
            move |data: &[u16], _: &_| {
                append(
                    &sink,
                    data.iter().map(|value| {
                        (*value as f32 - u16::MAX as f32 / 2.0) / (u16::MAX as f32 / 2.0)
                    }),
                )
            },
            on_error,
            None,
        ),
        format => {
            let _ = ready.send(Err(device_error(&format!(
                "das Format {format} wird nicht unterstützt"
            ))));
            return;
        }
    };

    let stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            let _ = ready.send(Err(device_error(&error.to_string())));
            return;
        }
    };
    if let Err(error) = stream.play() {
        let _ = ready.send(Err(device_error(&error.to_string())));
        return;
    }
    if ready.send(Ok(())).is_err() {
        return;
    }

    let _ = stop.recv();
    drop(stream);

    let samples = collected
        .lock()
        .map(|mut buffer| std::mem::take(&mut *buffer));
    let _ = finished.send(match samples {
        Ok(samples) => Ok(CapturedAudio {
            samples,
            sample_rate,
            channels,
        }),
        Err(_) => Err("Die Aufnahme konnte nicht gelesen werden.".to_string()),
    });
}

fn append(sink: &Arc<Mutex<Vec<f32>>>, samples: impl Iterator<Item = f32>) {
    if let Ok(mut buffer) = sink.lock() {
        let remaining = MAX_INPUT_SAMPLES.saturating_sub(buffer.len());
        if remaining == 0 {
            return;
        }
        buffer.extend(samples.take(remaining));
    }
}

fn to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let channels = channels as usize;
    samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// Averages every input window into one output sample, which also damps the aliasing a
/// plain nearest-neighbour decimation would introduce.
fn resample(samples: &[f32], from_rate: u32) -> Vec<f32> {
    if from_rate == TARGET_SAMPLE_RATE || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = from_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let output_len = (samples.len() as f64 / ratio).floor() as usize;
    (0..output_len)
        .map(|index| {
            let start = (index as f64 * ratio).floor() as usize;
            let end = (((index + 1) as f64 * ratio).ceil() as usize).min(samples.len());
            let window = &samples[start.min(samples.len())..end.max(start.min(samples.len()))];
            if window.is_empty() {
                0.0
            } else {
                window.iter().sum::<f32>() / window.len() as f32
            }
        })
        .collect()
}

fn encode_wav(audio: CapturedAudio) -> Result<Vec<u8>, String> {
    let mono = to_mono(&audio.samples, audio.channels);
    let resampled = resample(&mono, audio.sample_rate);
    if resampled.is_empty() {
        return Err("Die Aufnahme war leer.".to_string());
    }

    let specification = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buffer = Cursor::new(Vec::new());
    let mut writer = hound::WavWriter::new(&mut buffer, specification)
        .map_err(|error| format!("Die Aufnahme konnte nicht gespeichert werden: {error}"))?;
    for sample in resampled {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer
            .write_sample(value)
            .map_err(|error| format!("Die Aufnahme konnte nicht gespeichert werden: {error}"))?;
    }
    writer
        .finalize()
        .map_err(|error| format!("Die Aufnahme konnte nicht abgeschlossen werden: {error}"))?;
    Ok(buffer.into_inner())
}

#[tauri::command]
pub fn start_voice_capture(state: tauri::State<'_, VoiceCapture>) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "Die Aufnahme ist in einem ungültigen Zustand.".to_string())?;
    if session.is_some() {
        return Err("Es läuft bereits eine Aufnahme.".to_string());
    }

    let (ready_tx, ready_rx) = channel();
    let (stop_tx, stop_rx) = channel();
    let (finished_tx, finished_rx) = channel();
    std::thread::spawn(move || capture_thread(ready_tx, stop_rx, finished_tx));

    match ready_rx.recv() {
        Ok(Ok(())) => {
            *session = Some(CaptureSession {
                stop: stop_tx,
                finished: finished_rx,
            });
            Ok(())
        }
        Ok(Err(reason)) => Err(reason),
        Err(_) => Err(device_error("der Aufnahmeprozess ist nicht gestartet")),
    }
}

#[tauri::command]
pub fn stop_voice_capture(
    state: tauri::State<'_, VoiceCapture>,
) -> Result<tauri::ipc::Response, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "Die Aufnahme ist in einem ungültigen Zustand.".to_string())?
        .take()
        .ok_or_else(|| "Es läuft gerade keine Aufnahme.".to_string())?;

    let _ = session.stop.send(());
    let captured = session
        .finished
        .recv()
        .map_err(|_| "Die Aufnahme wurde unerwartet beendet.".to_string())??;

    Ok(tauri::ipc::Response::new(encode_wav(captured)?))
}

#[tauri::command]
pub fn cancel_voice_capture(state: tauri::State<'_, VoiceCapture>) {
    if let Ok(mut session) = state.session.lock() {
        if let Some(session) = session.take() {
            let _ = session.stop.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn averages_every_channel_into_one() {
        let stereo = [1.0, 0.0, 0.5, 0.5, -1.0, 1.0];
        assert_eq!(to_mono(&stereo, 2), vec![0.5, 0.5, 0.0]);
        assert_eq!(to_mono(&stereo, 1), stereo.to_vec());
    }

    #[test]
    fn resamples_down_to_the_whisper_rate() {
        let input: Vec<f32> = (0..48_000).map(|index| index as f32 / 48_000.0).collect();
        let output = resample(&input, 48_000);
        assert_eq!(output.len(), 16_000);
        assert!(output.first().unwrap() < output.last().unwrap());
    }

    #[test]
    fn keeps_audio_that_is_already_at_the_target_rate() {
        let input = vec![0.1, 0.2, 0.3];
        assert_eq!(resample(&input, TARGET_SAMPLE_RATE), input);
    }

    #[test]
    fn writes_a_playable_wav_header() {
        let audio = CapturedAudio {
            samples: vec![0.0, 0.5, -0.5, 1.0],
            sample_rate: TARGET_SAMPLE_RATE,
            channels: 1,
        };
        let wav = encode_wav(audio).expect("wav");
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
    }

    #[test]
    fn refuses_to_encode_an_empty_recording() {
        let audio = CapturedAudio {
            samples: Vec::new(),
            sample_rate: TARGET_SAMPLE_RATE,
            channels: 1,
        };
        assert!(encode_wav(audio).is_err());
    }
}
