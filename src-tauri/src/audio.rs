// Derived from Socorin (https://github.com/huystr/socorin), Apache-2.0.
// MODIFIED for AnnotRec: Windows-only; settings-based `choose`, macOS and Linux paths removed.

//! Microphone listing and capture (WASAPI). Adapted from Socorin (Apache-2.0).
use serde::{Deserialize, Serialize};
/// One microphone, as the settings window lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    /// What the platform calls it: the AVFoundation unique id, the WASAPI
    /// endpoint id or the PulseAudio source name. Stored in the settings.
    pub id: String,
    pub name: String,
    /// The system's default input right now.
    pub default: bool,
}

/// What a recording takes as sound.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Choice {
    /// The microphone, or `None` for a silent recording.
    pub input: Option<Input>,
    /// `input` is the system default: the recorder asks for "the default
    /// input" rather than for that device by id, so a default that changes
    /// as the recording starts is followed.
    pub default: bool,
    /// Why there is no sound, or why another microphone than the chosen
    /// one is recorded. Shown on the recording bar.
    pub issue: Option<String>,
}

impl Choice {
    /// Drops the sound because of `why` (the recorder could not open the
    /// microphone, the permission is missing, …). Linux has neither case:
    /// ffmpeg opens the source itself.
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    pub fn mute(&mut self, why: String) {
        self.input = None;
        self.default = false;
        self.issue = Some(why);
    }
}

/// Said when the microphone is wanted but none is there.
pub const NO_MIC: &str = "No microphone is connected; recording without sound.";

/// The microphones present. Empty where there is none.
pub fn inputs() -> Vec<Input> {
    wasapi::inputs().unwrap_or_else(|e| {
        eprintln!("[audio] {e}");
        Vec::new()
    })
}

#[cfg(windows)]
pub(crate) mod wasapi {
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
            Media::Audio::{
                eCapture, eConsole, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
                MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, DEVICE_STATE_ACTIVE,
                WAVEFORMATEX, WAVE_FORMAT_PCM,
            },
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, StructuredStorage::PropVariantToStringAlloc,
                CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
            },
        },
    };

    use super::Input;
    use crate::wgc::{AudioSource, PCM_BLOCK, PCM_CHANNELS, PCM_RATE};

    /// COM on this thread (multi-threaded apartment; a thread that already
    /// has one, of either kind, is fine as well).
    fn com_init() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn enumerator() -> Result<IMMDeviceEnumerator, String> {
        com_init();
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| format!("cannot list audio devices: {e}"))
    }

    fn id_of(device: &IMMDevice) -> Result<String, String> {
        unsafe {
            let id: PWSTR = device.GetId().map_err(|e| format!("cannot read an audio device id: {e}"))?;
            let text = id.to_string().map_err(|e| format!("audio device id is not UTF-16: {e}"));
            CoTaskMemFree(Some(id.0 as *const _));
            text
        }
    }

    /// The name the Sound settings show; empty when it cannot be read.
    fn name_of(device: &IMMDevice) -> String {
        unsafe {
            let Ok(store) = device.OpenPropertyStore(STGM_READ) else {
                return String::new();
            };
            let Ok(value) = store.GetValue(&PKEY_Device_FriendlyName) else {
                return String::new();
            };
            match PropVariantToStringAlloc(&value) {
                Ok(text) => {
                    let name = text.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(text.0 as *const _));
                    name
                }
                Err(_) => String::new(),
            }
        }
    }

    /// The active capture endpoints, the console default flagged.
    pub fn inputs() -> Result<Vec<Input>, String> {
        let enumerator = enumerator()?;
        unsafe {
            let default_id = enumerator
                .GetDefaultAudioEndpoint(eCapture, eConsole)
                .ok()
                .and_then(|d| id_of(&d).ok());
            let devices = enumerator
                .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
                .map_err(|e| format!("cannot list microphones: {e}"))?;
            let count = devices.GetCount().map_err(|e| format!("cannot list microphones: {e}"))?;
            let mut list = Vec::new();
            for n in 0..count {
                let Ok(device) = devices.Item(n) else { continue };
                let Ok(id) = id_of(&device) else { continue };
                let name = name_of(&device);
                list.push(Input {
                    default: default_id.as_deref() == Some(id.as_str()),
                    name: if name.is_empty() { id.clone() } else { name },
                    id,
                });
            }
            Ok(list)
        }
    }

    /// A microphone being read.
    pub struct Capture {
        client: IAudioClient,
        reader: IAudioCaptureClient,
    }

    impl Capture {
        /// Opens `device_id` (`None`: the default input) in shared mode
        /// and starts the stream. The Windows privacy switch for the
        /// microphone makes this fail, as does a device that is gone.
        pub fn open(device_id: Option<&str>) -> Result<Self, String> {
            let enumerator = enumerator()?;
            unsafe {
                let device = match device_id {
                    Some(id) => {
                        let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
                        enumerator.GetDevice(PCWSTR(wide.as_ptr()))
                    }
                    None => enumerator.GetDefaultAudioEndpoint(eCapture, eConsole),
                }
                .map_err(|e| format!("no microphone: {e}"))?;
                let client: IAudioClient = device
                    .Activate(CLSCTX_ALL, None)
                    .map_err(|e| format!("cannot open the microphone: {e}"))?;
                let block = PCM_BLOCK as u32;
                let format = WAVEFORMATEX {
                    wFormatTag: WAVE_FORMAT_PCM as u16,
                    nChannels: PCM_CHANNELS as u16,
                    nSamplesPerSec: PCM_RATE,
                    nAvgBytesPerSec: PCM_RATE * block,
                    nBlockAlign: block as u16,
                    wBitsPerSample: (block / PCM_CHANNELS * 8) as u16,
                    cbSize: 0,
                };
                // A 200 ms buffer: the pacer empties it every 1/30 s.
                client
                    .Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                        2_000_000,
                        0,
                        &format,
                        None,
                    )
                    .map_err(|e| format!("cannot open the microphone: {e}"))?;
                let reader: IAudioCaptureClient = client
                    .GetService()
                    .map_err(|e| format!("cannot read the microphone: {e}"))?;
                client.Start().map_err(|e| format!("cannot start the microphone: {e}"))?;
                Ok(Self { client, reader })
            }
        }
    }

    impl AudioSource for Capture {
        fn pull(&mut self) -> Result<Vec<u8>, String> {
            let mut out = Vec::new();
            unsafe {
                loop {
                    let frames = self
                        .reader
                        .GetNextPacketSize()
                        .map_err(|e| format!("the microphone stopped: {e}"))?;
                    if frames == 0 {
                        break;
                    }
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut got = 0u32;
                    let mut flags = 0u32;
                    self.reader
                        .GetBuffer(&mut data, &mut got, &mut flags, None, None)
                        .map_err(|e| format!("the microphone stopped: {e}"))?;
                    let bytes = got as usize * PCM_BLOCK;
                    if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                        out.resize(out.len() + bytes, 0);
                    } else {
                        out.extend_from_slice(std::slice::from_raw_parts(data, bytes));
                    }
                    self.reader
                        .ReleaseBuffer(got)
                        .map_err(|e| format!("the microphone stopped: {e}"))?;
                }
            }
            Ok(out)
        }
    }

    impl Drop for Capture {
        fn drop(&mut self) {
            unsafe {
                let _ = self.client.Stop();
            }
        }
    }
}
