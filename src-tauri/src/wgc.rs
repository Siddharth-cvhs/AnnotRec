// Derived from Socorin (https://github.com/huystr/socorin), Apache-2.0.
// MODIFIED for AnnotRec: physical-pixel areas, pause/resume and live mute (Controls),
// audio and video anchored to the first frame, settings/debug/tests removed.

//! Windows: screen recording in-process, no ffmpeg needed. The frames come
//! from Windows.Graphics.Capture (the compositor hands over every changed
//! frame of a monitor as a Direct3D texture, cursor included) and go into
//! a Media Foundation H.264 encoder writing an MP4 (hardware-accelerated
//! where the GPU offers it). Windows 10 version 1903 or later;
//! `record::spawn_backend` falls back to ffmpeg elsewhere.
//!
//! Two threads per recording. The capture thread (`windows-capture`'s)
//! crops the recorded region out of each frame and parks it as the newest
//! frame. The encoder thread sends a frame every 1/`FPS` s: the newest one,
//! or the previous one again while nothing on screen changes, because the
//! capture API only delivers frames on change and the file's clock has to
//! keep running through still passages. On the same beat it drains the
//! microphone (`audio::wasapi::Capture`, 16-bit stereo PCM at 48 kHz) into
//! the encoder's AAC track, padding with silence when the microphone falls
//! behind the clock so the sound never drifts from the picture. Stopping
//! ends the capture, lets the encoder write the file's trailer and waits
//! for it.
//!
//! Only the platform-independent parts (crop geometry, frame packing, the
//! pacing loop, the silence padding) compile everywhere, so they are
//! unit-tested on every platform; the Windows APIs are behind
//! `cfg(windows)`.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use crate::area::Area;

/// Frames per second of the video, and the cadence of the pacing loop.
pub const FPS: u32 = 30;

/// The microphone's stream as the encoder takes it: 16-bit PCM, stereo,
/// 48 kHz (`PCM_BLOCK` bytes per sample frame).
pub const PCM_RATE: u32 = 48_000;
pub const PCM_CHANNELS: u32 = 2;
pub const PCM_BLOCK: usize = 4;
pub const PCM_BYTES_PER_SECOND: u64 = PCM_RATE as u64 * PCM_BLOCK as u64;
/// How far the sound may trail the clock before silence fills the gap.
pub const AUDIO_SLACK: Duration = Duration::from_millis(200);

/// The part of a monitor's frame that goes into the video, in the
/// monitor's physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Crop {
    /// `area` (physical pixels, relative to its monitor). Sizes are rounded
    /// down to even numbers (H.264 4:2:0 needs them); `None` when less than
    /// 2×2 remain.
    pub fn of(area: &Area) -> Option<Self> {
        let crop = Self {
            x: area.x,
            y: area.y,
            width: area.width / 2 * 2,
            height: area.height / 2 * 2,
        };
        (crop.width >= 2 && crop.height >= 2).then_some(crop)
    }

    /// The part of the crop inside a `width`×`height` frame: a frame can be
    /// a pixel smaller than the geometry's rounding predicted, and the
    /// display mode may change mid-recording. `None` when nothing is left.
    pub fn clip(&self, width: u32, height: u32) -> Option<Self> {
        let w = width.saturating_sub(self.x).min(self.width);
        let h = height.saturating_sub(self.y).min(self.height);
        (w > 0 && h > 0).then_some(Self {
            x: self.x,
            y: self.y,
            width: w,
            height: h,
        })
    }
}

/// Bits per second for a `width`×`height` video at `FPS`: a tenth of a bit
/// per pixel and frame (roughly what libx264's default quality spends on
/// screen content), kept within 2..=25 Mbit/s.
pub fn bitrate_for(width: u32, height: u32) -> u32 {
    let per_second = u64::from(width) * u64::from(height) * u64::from(FPS) / 10;
    per_second.clamp(2_000_000, 25_000_000) as u32
}

/// Copies a `visible.0`×`visible.1` BGRA region (its rows `row_pitch` bytes
/// apart, as Direct3D maps a staging texture) into a tight
/// `target.0`×`target.1` frame for the encoder, black where the region
/// does not reach. The rows go in bottom-up: Media Foundation takes RGB
/// samples in system memory in the bitmap convention, last row first.
pub fn pack_frame(src: &[u8], row_pitch: usize, visible: (u32, u32), target: (u32, u32), out: &mut Vec<u8>) {
    let (tw, th) = (target.0 as usize, target.1 as usize);
    let stride = tw * 4;
    out.clear();
    out.resize(stride * th, 0);
    let vw = (visible.0 as usize).min(tw);
    let vh = (visible.1 as usize).min(th);
    let row_bytes = vw * 4;
    for y in 0..vh {
        let src_row = &src[y * row_pitch..y * row_pitch + row_bytes];
        let dst = (th - 1 - y) * stride;
        out[dst..dst + row_bytes].copy_from_slice(src_row);
    }
}

/// Where the paced frames go: the Media Foundation encoder, or a recorder
/// in the tests.
pub trait FrameSink {
    /// One tight BGRA frame; `timestamp` in 100 ns units since the first.
    fn push(&mut self, frame: &[u8], timestamp: i64) -> Result<(), String>;
    /// Microphone samples (`PCM_RATE`, `PCM_CHANNELS`, 16 bit), in order;
    /// the encoder places them by count. Nothing to do for a sink without
    /// an audio track.
    fn push_audio(&mut self, _pcm: &[u8]) -> Result<(), String> {
        Ok(())
    }
    /// Writes the file's trailer.
    fn finish(self) -> Result<(), String>;
}

/// Where the microphone's samples come from: `audio::wasapi::Capture`, or
/// a stand-in in the tests.
pub trait AudioSource {
    /// Interleaved 16-bit PCM captured since the last call (whole sample
    /// frames of `PCM_BLOCK` bytes); empty when there is nothing new. An
    /// error ends the sound, not the recording.
    fn pull(&mut self) -> Result<Vec<u8>, String>;
}

/// Live switches the pacer reads on every beat.
#[derive(Default)]
pub struct Controls {
    /// Pause the recording (video, sound and clock).
    pub paused: AtomicBool,
    /// Record silence instead of the microphone.
    pub muted: AtomicBool,
}

/// The newest captured frame, handed from the capture thread to the pacer.
pub type Latest = Arc<Mutex<Option<Vec<u8>>>>;

/// Bytes of silence to send before `fresh` bytes of microphone audio so the
/// sound (`sent` bytes so far) does not trail `elapsed` by more than
/// `slack`. The encoder places audio by the samples it was given, so a
/// microphone that stalls (unplugged, a driver hiccup, a stream that starts
/// late) would otherwise pull everything after it out of step with the
/// picture. Whole sample frames of `block` bytes; the gap is filled fully
/// once it is wider than `slack`.
pub fn silence_to_pad(elapsed: Duration, sent: u64, fresh: usize, bytes_per_second: u64, slack: Duration, block: usize) -> usize {
    let bytes_for = |d: Duration| (d.as_nanos() * u128::from(bytes_per_second) / 1_000_000_000) as u64;
    let expected = bytes_for(elapsed);
    let have = sent + fresh as u64;
    if have + bytes_for(slack) >= expected {
        return 0;
    }
    ((expected - have) as usize) / block * block
}

/// `pace_with` without a microphone.
#[cfg(test)]
pub fn pace<S: FrameSink>(latest: &Latest, sink: S, stop: &AtomicBool, fps: u32) -> Result<u64, String> {
    pace_with(latest, sink, stop, fps, None::<NoAudio>)
}

/// The absent microphone.
#[cfg(test)]
pub struct NoAudio;

#[cfg(test)]
impl AudioSource for NoAudio {
    fn pull(&mut self) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
}

/// Sends a frame every 1/`fps` s until `stop` is set, then finalises the
/// sink: the newest captured frame, or the previous one again while the
/// screen does not change. Nothing is sent before the first frame arrives.
/// On every beat the microphone, when there is one, is drained into the
/// sink as well (with silence where it fell behind the clock); a
/// microphone that fails is dropped and the recording goes on without
/// sound. Returns the number of frames sent.
pub fn pace_with<S: FrameSink, A: AudioSource>(
    latest: &Latest,
    mut sink: S,
    stop: &AtomicBool,
    fps: u32,
    mut audio: Option<A>,
    controls: &Controls,
) -> Result<u64, String> {
    let interval = Duration::from_secs(1) / fps;
    let mut start = Instant::now();
    let mut paused_at: Option<Instant> = None;
    let mut slot: u64 = 0;
    let mut sent: u64 = 0;
    let mut audio_sent: u64 = 0;
    let mut frame: Option<Vec<u8>> = None;
    // The slot of the first frame, and how long into the run (pauses
    // excluded) it went out: the origin of both tracks.
    let mut first_slot: Option<u64> = None;
    let mut audio_origin: Option<Duration> = None;
    while !stop.load(Ordering::SeqCst) {
        // Paused: no frame and no sound go into the file, and the clock
        // stops. The microphone is still drained so nothing piles up. On
        // resume the schedule is shifted by the time spent paused, so the
        // video timestamps and the audio count continue without a gap.
        if controls.paused.load(Ordering::SeqCst) {
            if paused_at.is_none() {
                paused_at = Some(Instant::now());
            }
            if let Some(source) = audio.as_mut() {
                let _ = source.pull();
            }
            let _ = latest.lock().unwrap().take();
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        if let Some(since) = paused_at.take() {
            start += since.elapsed();
        }
        let due = start + interval * u32::try_from(slot).unwrap_or(u32::MAX);
        let now = Instant::now();
        if now < due {
            // Short naps, so a stop is noticed promptly.
            std::thread::sleep((due - now).min(Duration::from_millis(20)));
            continue;
        }
        if now - due > Duration::from_secs(1) {
            // Far behind (the machine slept): skip the missed slots rather
            // than flooding the encoder with catch-up frames.
            slot = ((now - start).as_nanos() / interval.as_nanos()) as u64;
        }
        if let Some(newest) = latest.lock().unwrap().take() {
            frame = Some(newest);
        }
        if let Some(f) = &frame {
            // Video and sound share one origin: the first frame. Capture
            // takes a moment to deliver it (up to ~1.5 s), and the encoder
            // starts the video at its first sample, so a sound clock that
            // began with the thread would run that much ahead of the
            // picture, and the voice would trail what it describes.
            let first = *first_slot.get_or_insert(slot);
            audio_origin.get_or_insert_with(|| start.elapsed());
            let timestamp = (interval.as_nanos() as u64 * (slot - first) / 100) as i64;
            sink.push(f, timestamp)?;
            sent += 1;
        }
        if let Some(source) = audio.as_mut() {
            match source.pull() {
                // No picture yet: nothing of the sound goes in either.
                Ok(_) if audio_origin.is_none() => {}
                Ok(mut pcm) => {
                    // Muted: the samples are dropped and the gap is padded
                    // with silence below, which keeps the sound in step.
                    if controls.muted.load(Ordering::SeqCst) {
                        pcm.clear();
                    }
                    let since_first = start.elapsed().saturating_sub(audio_origin.unwrap_or_default());
                    let pad = silence_to_pad(since_first, audio_sent, pcm.len(), PCM_BYTES_PER_SECOND, AUDIO_SLACK, PCM_BLOCK);
                    if pad > 0 {
                        sink.push_audio(&vec![0u8; pad])?;
                        audio_sent += pad as u64;
                    }
                    if !pcm.is_empty() {
                        sink.push_audio(&pcm)?;
                        audio_sent += pcm.len() as u64;
                    }
                }
                Err(e) => {
                    eprintln!("[record] microphone: {e}; the rest of the recording has no sound");
                    audio = None;
                }
            }
        }
        slot += 1;
    }
    sink.finish()?;
    Ok(sent)
}

#[cfg(windows)]
pub use native::Recorder;

#[cfg(windows)]
mod native {
    use std::{
        path::Path,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
        thread,
        time::Duration,
    };

    use windows::{
        core::HSTRING,
        Foundation::Metadata::ApiInformation,
        Graphics::Capture::{GraphicsCaptureAccess, GraphicsCaptureAccessKind},
    };
    use windows_capture::{
        capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
        encoder::{
            AudioSettingsBuilder, ContainerSettingsBuilder, ContainerSettingsSubType, VideoEncoder,
            VideoSettingsBuilder, VideoSettingsSubType,
        },
        frame::Frame,
        graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl},
        monitor::Monitor,
        settings::{
            ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
            MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
        },
    };

    use super::{
        bitrate_for, pace_with, pack_frame, AudioSource, Controls, Crop, FrameSink, Latest, FPS, PCM_CHANNELS,
        PCM_RATE,
    };
    use crate::{
        area::Area,
        audio::{self, wasapi},
    };

    /// Whether Windows.Graphics.Capture exists here (Windows 10 1903+).
    pub fn is_supported() -> bool {
        GraphicsCaptureApi::is_supported().unwrap_or(false)
    }

    /// The capture-thread side: crops each frame and parks it for the pacer.
    struct Handler {
        crop: Crop,
        latest: Latest,
    }

    impl GraphicsCaptureApiHandler for Handler {
        type Flags = (Crop, Latest);
        type Error = String;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, String> {
            let (crop, latest) = ctx.flags;
            Ok(Self { crop, latest })
        }

        fn on_frame_arrived(&mut self, frame: &mut Frame, _: InternalCaptureControl) -> Result<(), String> {
            let Some(visible) = self.crop.clip(frame.width(), frame.height()) else {
                return Ok(());
            };
            let mut buffer = frame
                .buffer_crop(visible.x, visible.y, visible.x + visible.width, visible.y + visible.height)
                .map_err(|e| format!("cannot read the captured frame: {e}"))?;
            let pitch = buffer.row_pitch() as usize;
            let mut packed = Vec::new();
            pack_frame(
                buffer.as_raw_buffer(),
                pitch,
                (visible.width, visible.height),
                (self.crop.width, self.crop.height),
                &mut packed,
            );
            *self.latest.lock().unwrap() = Some(packed);
            Ok(())
        }
    }

    /// The Media Foundation encoder as the pacer's sink.
    struct Encoder(VideoEncoder);

    impl FrameSink for Encoder {
        fn push(&mut self, frame: &[u8], timestamp: i64) -> Result<(), String> {
            self.0
                .send_frame_buffer(frame, timestamp)
                .map_err(|e| format!("the video encoder failed: {e}"))
        }

        fn push_audio(&mut self, pcm: &[u8]) -> Result<(), String> {
            // The encoder keeps its own audio clock (by samples sent); the
            // timestamp is ignored.
            self.0
                .send_audio_buffer(pcm, 0)
                .map_err(|e| format!("the audio encoder failed: {e}"))
        }

        fn finish(self) -> Result<(), String> {
            self.0.finish().map_err(|e| format!("cannot finalise the video: {e}"))
        }
    }

    /// A running recording: the capture session and the encoder thread.
    pub struct Recorder {
        control: Option<CaptureControl<Handler, String>>,
        stop: Arc<AtomicBool>,
        /// Pause and microphone-mute switches, read by the pacer.
        pub controls: Arc<Controls>,
        /// The encoder thread's outcome, once it has finalised the file.
        done: mpsc::Receiver<Result<u64, String>>,
    }

    impl Recorder {
        /// Starts recording `area` into the MP4 at `path` (created or
        /// truncated), with the microphone `audio` names; when that cannot
        /// be opened, `audio` is muted with the reason and the recording
        /// goes on without sound. Never call this from a test on a
        /// developer machine: it records the screen.
        pub fn start(area: &Area, path: &Path, audio: &mut audio::Choice) -> Result<Self, String> {
            if !is_supported() {
                return Err("The built-in recorder needs Windows 10 version 1903 or later".into());
            }
            let crop = Crop::of(area).ok_or("the area to record is too small")?;
            let monitor = monitor_for(area.monitor_id)?;
            request_borderless();
            let controls = Arc::new(Controls::default());

            // The encoder lives on its own thread (Media Foundation objects
            // stay with the thread that made them), and the microphone with
            // it. It reports back once it is ready (saying whether the
            // microphone could be opened), and again with the outcome after
            // the last frame.
            let latest: Latest = Arc::default();
            let stop = Arc::new(AtomicBool::new(false));
            let (ready_tx, ready_rx) = mpsc::channel::<Result<Option<String>, String>>();
            let (done_tx, done_rx) = mpsc::channel();
            let (width, height) = (crop.width, crop.height);
            let path = path.to_path_buf();
            // `Some(None)`: the default input; `Some(Some(id))`: that device.
            let mic: Option<Option<String>> = audio.input.as_ref().map(|i| (!audio.default).then(|| i.id.clone()));
            thread::spawn({
                let latest = latest.clone();
                let stop = stop.clone();
                let controls = controls.clone();
                move || {
                    // The microphone first: the encoder only gets an audio
                    // track when there is something to fill it with.
                    let (mut source, mic_issue) = match mic {
                        None => (None, None),
                        Some(device) => match wasapi::Capture::open(device.as_deref()) {
                            Ok(capture) => (Some(capture), None),
                            Err(e) => (None, Some(format!("{e}; recording without sound."))),
                        },
                    };
                    let encoder = VideoEncoder::new(
                        VideoSettingsBuilder::new(width, height)
                            .sub_type(VideoSettingsSubType::H264)
                            .frame_rate(FPS)
                            .bitrate(bitrate_for(width, height)),
                        AudioSettingsBuilder::default()
                            .sample_rate(PCM_RATE)
                            .channel_count(PCM_CHANNELS)
                            .bit_per_sample(16)
                            .bitrate(128_000)
                            .disabled(source.is_none()),
                        ContainerSettingsBuilder::default().sub_type(ContainerSettingsSubType::MPEG4),
                        &path,
                    );
                    let encoder = match encoder {
                        Ok(encoder) => encoder,
                        Err(e) => {
                            let _ = ready_tx.send(Err(format!("cannot start the video encoder: {e}")));
                            return;
                        }
                    };
                    // What the microphone picked up while the encoder was
                    // being set up is dropped: the sound starts with the
                    // clock, together with the picture.
                    if let Some(capture) = source.as_mut() {
                        let _ = capture.pull();
                    }
                    let _ = ready_tx.send(Ok(mic_issue));
                    let outcome = pace_with(&latest, Encoder(encoder), &stop, FPS, source, &controls);
                    if matches!(outcome, Ok(0)) {
                        // Headers without a single frame are no recording:
                        // leave the file empty, which the caller reports.
                        let _ = std::fs::File::create(&path);
                    }
                    let _ = done_tx.send(outcome);
                }
            });
            let mic_issue = ready_rx
                .recv()
                .map_err(|_| "the video encoder thread ended unexpectedly".to_string())??;
            if let Some(issue) = mic_issue {
                eprintln!("[record] {issue}");
                audio.mute(issue);
            }

            let settings = Settings::new(
                monitor,
                cursor_setting(),
                border_setting(),
                SecondaryWindowSettings::Default,
                update_interval_setting(),
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                (crop, latest),
            );
            match Handler::start_free_threaded(settings) {
                Ok(control) => {
                    eprintln!(
                        "[record] {}x{} at ({}, {}) of monitor {}",
                        crop.width, crop.height, crop.x, crop.y, area.monitor_id
                    );
                    Ok(Self { control: Some(control), stop, controls, done: done_rx })
                }
                Err(e) => {
                    // Let the encoder thread close the file before the
                    // caller removes it.
                    stop.store(true, Ordering::SeqCst);
                    let _ = done_rx.recv_timeout(Duration::from_secs(5));
                    Err(format!("cannot start screen capture: {e}"))
                }
            }
        }

        /// Ends the capture, lets the encoder write the file's trailer and
        /// waits for it, `timeout` at most.
        pub fn stop(mut self, timeout: Duration) -> Result<(), String> {
            let capture = self.end_capture();
            self.stop.store(true, Ordering::SeqCst);
            let encoder = match self.done.recv_timeout(timeout) {
                Ok(Ok(0)) => Err("no frames were captured".into()),
                Ok(Ok(frames)) => {
                    eprintln!("[record] encoded {frames} frames");
                    Ok(())
                }
                Ok(Err(e)) => Err(e),
                Err(_) => Err("the video encoder did not finish in time".into()),
            };
            encoder.and(capture)
        }

        /// Ends the capture and lets the encoder finish on its own, without
        /// waiting (the tests reset the shared app between cases).
        #[cfg(test)]
        pub fn abandon(mut self) {
            let _ = self.end_capture();
            self.stop.store(true, Ordering::SeqCst);
        }

        fn end_capture(&mut self) -> Result<(), String> {
            match self.control.take() {
                Some(control) => control
                    .stop()
                    .map_err(|e| format!("screen capture ended with an error: {e}")),
                None => Ok(()),
            }
        }
    }

    /// The monitor `capture::geometry_of` gave this id: xcap's id is the
    /// HMONITOR handle's low 32 bits.
    fn monitor_for(id: u32) -> Result<Monitor, String> {
        Monitor::enumerate()
            .map_err(|e| format!("cannot list monitors: {e}"))?
            .into_iter()
            .find(|m| m.as_raw_hmonitor() as usize as u32 == id)
            .ok_or_else(|| format!("monitor {id} disappeared"))
    }

    /// The cursor goes into the video. Asking for it needs Windows 10 2004;
    /// earlier versions include it anyway.
    fn cursor_setting() -> CursorCaptureSettings {
        if GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false) {
            CursorCaptureSettings::WithCursor
        } else {
            CursorCaptureSettings::Default
        }
    }

    /// No capture border where an app may decline it (Windows 11, after
    /// `request_borderless`). Windows 10 draws its yellow frame around the
    /// recorded display regardless.
    fn border_setting() -> DrawBorderSettings {
        if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false) {
            DrawBorderSettings::WithoutBorder
        } else {
            DrawBorderSettings::Default
        }
    }

    /// No more than `FPS` frames per second from the compositor where that
    /// can be set (Windows 11 24H2+): it saves GPU-to-CPU copies the pacer
    /// would drop anyway.
    fn update_interval_setting() -> MinimumUpdateIntervalSettings {
        if GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false) {
            MinimumUpdateIntervalSettings::Custom(Duration::from_secs(1) / FPS)
        } else {
            MinimumUpdateIntervalSettings::Default
        }
    }

    /// Windows 11 keeps its border around a captured display unless the app
    /// has been granted borderless capture; the system remembers the
    /// answer. Skipped where the API does not exist, and a refusal only
    /// means the border stays.
    fn request_borderless() {
        let name = HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureAccess");
        if ApiInformation::IsTypePresent(&name).unwrap_or(false) {
            if let Ok(request) = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless) {
                let _ = request.join();
            }
        }
    }
}
