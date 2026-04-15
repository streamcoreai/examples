use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use crossterm::terminal;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use streamcore_rust_sdk::{Client, Config, EventHandler, FRAME_SIZE};
use tokio::sync::mpsc;

// ── Raw Mode Guard ────────────────────────────────────────────────────────────
// Ensures terminal raw mode is disabled if the process panics or drops.
struct RawModeGuard;
impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let whip_url =
        std::env::var("WHIP_URL").unwrap_or_else(|_| "http://localhost:8080/whip".to_string());
    let token_url = std::env::var("TOKEN_URL").ok();
    let api_key = std::env::var("API_KEY").ok();

    let client = Arc::new(Client::new(
        Config {
            whip_endpoint: whip_url,
            token_url,
            api_key,
            ..Default::default()
        },
        EventHandler {
            on_status_change: Some(Box::new(|status| {
                println!("[status] {status}");
            })),
            on_transcript: Some(Box::new(|entry, _all| {
                let role = &entry.role;
                let text = &entry.text;
                if entry.partial {
                    print!("\r[{role}] (partial) {text}");
                } else {
                    println!("\r[{role}] {text}");
                }
            })),
            on_error: Some(Box::new(|err| {
                eprintln!("[error] {err}");
            })),
            on_timing: None,
            on_agent_state_change: None,
            on_data_channel_message: None,
        },
    ));

    println!("Connecting to {} ...", client.config.whip_endpoint);
    client.connect().await?;

    let is_muted = Arc::new(AtomicBool::new(true));

    // Enable raw terminal mode immediately after connection to capture spacebar silently
    terminal::enable_raw_mode()?;
    let _guard = RawModeGuard;

    let is_muted_clone = Arc::clone(&is_muted);
    std::thread::spawn(move || {
        loop {
            if let Ok(Event::Key(key)) = event::read() {
                if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
                    // Safe exit directly from the blocking thread
                    let _ = terminal::disable_raw_mode();
                    std::process::exit(0);
                } else if key.code == KeyCode::Char(' ') {
                    let muted = !is_muted_clone.load(Ordering::Relaxed);
                    is_muted_clone.store(muted, Ordering::Relaxed);
                    if muted {
                        print!("\r\n[mic] 🔴 Muted. Press Space to talk...\r\n");
                    } else {
                        print!("\r\n[mic] 🟢 Unmuted. Agent is listening...\r\n");
                    }
                }
            }
        }
    });

    println!("\r\nConnected! Microphone is 🔴 MUTED. Press Spacebar to talk. (Ctrl+C to quit)\r\n");

    // ── Task 1: microphone → client.send_pcm ─────────────────────────────────
    let client_mic = Arc::clone(&client);
    let mic_is_muted = Arc::clone(&is_muted);
    tokio::spawn(async move {
        if let Err(e) = run_mic_capture(client_mic, mic_is_muted).await {
            eprintln!("[mic] {e}");
        }
    });

    // ── Task 2: client.recv_pcm → speaker ────────────────────────────────────
    let client_spk = Arc::clone(&client);
    tokio::spawn(async move {
        if let Err(e) = run_speaker_playback(client_spk).await {
            eprintln!("[speaker] {e}");
        }
    });

    tokio::signal::ctrl_c().await?;
    println!("\nShutting down...");
    client.disconnect().await;
    Ok(())
}

// ── Microphone capture ────────────────────────────────────────────────────────
//
// cpal uses a background callback thread; we bridge it to async via an mpsc
// channel that ships one full 20 ms frame (960 f32 samples) at a time.

async fn run_mic_capture(client: Arc<Client>, is_muted: Arc<AtomicBool>) -> anyhow::Result<()> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow::anyhow!("no default input device"))?;

    let default_config = device.default_input_config()?;
    let config = default_config.config();
    let input_channels = config.channels as usize;

    let (tx, mut rx) = mpsc::channel::<Vec<f32>>(8);

    std::thread::spawn(move || -> anyhow::Result<()> {
        let mut partial: Vec<f32> = Vec::with_capacity(FRAME_SIZE);
        let stream = device.build_input_stream(
            &config,
            move |data: &[f32], _info| {
                // If stereo, mix to mono
                let mono_data: Vec<f32> = data
                    .chunks(input_channels)
                    .map(|c| {
                        if c.len() > 1 {
                            (c[0] + c[1]) / 2.0
                        } else {
                            c[0]
                        }
                    })
                    .collect();

                partial.extend_from_slice(&mono_data);
                while partial.len() >= FRAME_SIZE {
                    let frame: Vec<f32> = partial.drain(..FRAME_SIZE).collect();
                    let _ = tx.try_send(frame);
                }
            },
            |err| eprintln!("[mic] cpal stream error: {err}"),
            None,
        )?;

        stream.play()?;
        std::thread::park();
        Ok(())
    });

    while let Some(mut frame) = rx.recv().await {
        // Core Mute Logic: Instantly zero-out all raw acoustic frequencies when muted
        if is_muted.load(Ordering::Relaxed) {
            frame.fill(0.0);
        }

        if let Err(e) = client.send_pcm(&frame).await {
            eprintln!("[mic] send_pcm: {e}");
        }
    }

    Ok(())
}

// ── Speaker playback ──────────────────────────────────────────────────────────
//
// The SDK decodes inbound RTP/Opus to PCM via client.recv_pcm(). We push
// the decoded frames into a cpal output stream for playback.

async fn run_speaker_playback(client: Arc<Client>) -> anyhow::Result<()> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| anyhow::anyhow!("no default output device"))?;

    let default_config = device.default_output_config()?;
    let config = default_config.config();
    let output_channels = config.channels as usize;

    let (tx, rx) = mpsc::channel::<Vec<f32>>(16);
    let rx = Arc::new(std::sync::Mutex::new(rx));

    std::thread::spawn(move || -> anyhow::Result<()> {
        let rx_cb = Arc::clone(&rx);
        let mut remaining: Vec<f32> = Vec::new();

        let stream = device.build_output_stream(
            &config,
            move |out: &mut [f32], _info| {
                let mut out_idx = 0;
                while out_idx < out.len() {
                    if remaining.is_empty() {
                        if let Ok(Some(mono_frame)) = rx_cb.lock().map(|mut g| g.try_recv().ok()) {
                            remaining.clear();
                            for &sample in &mono_frame {
                                for _ in 0..output_channels {
                                    remaining.push(sample);
                                }
                            }
                        } else {
                            out[out_idx..].fill(0.0);
                            return;
                        }
                    }

                    let taking = remaining.len().min(out.len() - out_idx);
                    out[out_idx..out_idx + taking].copy_from_slice(&remaining[..taking]);
                    remaining.drain(..taking);
                    out_idx += taking;
                }
            },
            |err| eprintln!("[speaker] cpal stream error: {err}"),
            None,
        )?;

        stream.play()?;
        std::thread::park();
        Ok(())
    });

    let mut pcm_out = vec![0.0f32; FRAME_SIZE];

    loop {
        match client.recv_pcm(&mut pcm_out).await {
            Ok(n) => {
                let frame = pcm_out[..n].to_vec();
                let _ = tx.try_send(frame);
            }
            Err(e) => {
                eprintln!("[speaker] recv_pcm: {e}");
                break;
            }
        }
    }

    Ok(())
}
