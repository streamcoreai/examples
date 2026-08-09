//! Comprehensive voice-agent firmware: WiFi + mic + speaker + display +
//! camera + push-to-talk + RPC.
//!
//! This is the LiveKit-style mental model:
//!   1. App owns WiFi.
//!   2. App owns the media pipeline (capturer + renderer + display + camera).
//!   3. App owns the main loop (push-to-talk button, reconnect, sleep…).
//!   4. SDK runs the WebRTC transport in a background thread.
//!
//! Targets ESP32-S3 WROOM-1 with INMP441 mic, MAX98357A speaker, ST7789
//! 240×280 display, OV2640 camera, and the boot button as PTT.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use esp_idf_svc::hal::gpio::{PinDriver, Pull};
use esp_idf_svc::hal::peripherals::Peripherals;
use log::{info, warn};
use voiceagent_esp32 as va;

macro_rules! env_or {
    ($k:literal, $d:literal) => {
        match option_env!($k) {
            Some(v) => v,
            None => $d,
        }
    };
}
fn opt(s: &'static str) -> Option<&'static str> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn main() -> anyhow::Result<()> {
    va::system_init();
    let p = Peripherals::take()?;

    // ------------------------------------------------------------------ 1.
    // WiFi — the SDK no longer does this for you (matches LiveKit).
    info!("Connecting WiFi...");
    let _wifi = va::wifi::connect_sta(
        p.modem,
        env_or!("WIFI_SSID", "your-wifi-ssid"),
        env_or!("WIFI_PASSWORD", "your-wifi-password"),
    )?;

    // ------------------------------------------------------------------ 2.
    // Media pipeline — capturer + renderer + display + camera.
    let mic = va::I2sMicCapturer::new(
        p.i2s1,
        p.pins.gpio41.degrade_input_output(),
        p.pins.gpio2.degrade_input_output(),
        p.pins.gpio42.degrade_input_output(),
        true, // AFE on
    )?;
    let speaker = va::I2sSpeakerRenderer::new(
        p.i2s0,
        p.pins.gpio46.degrade_input_output(),
        p.pins.gpio3.degrade_input_output(),
        p.pins.gpio1.degrade_input_output(),
        24_000,
    )?;
    let display = va::display::DisplayHandle::spawn(
        p.spi2,
        p.pins.gpio47.degrade_input_output(),
        p.pins.gpio21.degrade_input_output(),
        p.pins.gpio14.degrade_input_output(),
        p.pins.gpio45.degrade_input_output(),
        p.pins.gpio48.degrade_input_output(),
    )?;
    if let Err(e) = va::camera::init() {
        warn!("camera init failed (vision RPC will fail): {e}");
    }

    let display_ui = display.clone();
    let display_state = display.clone();
    let display_resp = display.clone();
    let display_speak = display.clone();

    let connected = Arc::new(AtomicBool::new(false));
    let connected_cb = connected.clone();

    // ------------------------------------------------------------------ 3.
    // Build the agent. `create()` is non-blocking; nothing connects yet.
    let agent = va::Agent::create(va::AgentOptions {
        publish: Some(va::PublishOptions {
            capturer: Box::new(mic),
        }),
        subscribe: Some(va::SubscribeOptions {
            renderer: Box::new(speaker),
        }),
        on_state_changed: Some(Box::new(move |s| {
            info!("agent state: {s:?}");
            display_state.set_connected(s == va::ConnectionState::Connected);
            connected_cb.store(s == va::ConnectionState::Connected, Ordering::SeqCst);
        })),
        on_transcript: Some(Box::new(move |text, is_final| {
            info!("user said: {text} (final={is_final})");
            if is_final {
                display_ui.push_user_final(text.into());
            } else {
                display_ui.set_user_text(text.into());
            }
        })),
        on_response: Some(Box::new(move |text| {
            info!("assistant: {text}");
            display_resp.append_assistant_text(text);
        })),
        on_error: Some(Box::new(|m| warn!("server error: {m}"))),
        ..Default::default()
    })?;

    // ------------------------------------------------------------------ 4.
    // Register RPC handlers — this is how the AI invokes device tools.
    // (Replaces the hardcoded `request_image` flow from the old SDK.)
    let agent_for_photo = agent.clone();
    agent.rpc_register("capture_photo", move |inv| {
        info!("RPC capture_photo called with params: {}", inv.params);
        let send = |s: &str| {
            let _ = agent_for_photo.publish_data("vision.image_chunk", s.as_bytes());
            Ok(())
        };
        match va::camera::capture_and_send(&send) {
            Ok(()) => inv.return_ok(serde_json::json!({"status": "ok"})),
            Err(e) => inv.return_err(1, &format!("{e}")),
        }
    })?;

    agent.rpc_register("get_device_info", |inv| {
        inv.return_ok(serde_json::json!({
            "model": "esp32-s3-wroom-1",
            "sdk":   env!("CARGO_PKG_VERSION"),
        }));
    })?;

    // ------------------------------------------------------------------ 5.
    // Connect — returns immediately; status comes via on_state_changed.
    agent.connect(
        env_or!("WHIP_ENDPOINT", "http://192.168.1.100:8080/whip"),
        opt(env_or!("TOKEN_URL", "")),
    )?;

    // ------------------------------------------------------------------ 6.
    // Main loop — push-to-talk button + speaking-indicator polling. The
    // app is in charge here; the agent runs in its own thread.
    let button = PinDriver::input(p.pins.gpio0.degrade_input_output(), Pull::Up)?;
    let mut last_pressed = false;
    let mut last_speaking_tick: u32 = 0;

    loop {
        let pressed = button.is_low();
        if pressed != last_pressed {
            if connected.load(Ordering::SeqCst) {
                let _ = agent.set_mic_enabled(pressed);
                display_speak.set_mic_muted(!pressed);
                info!(
                    "PTT {}",
                    if pressed {
                        "PRESSED — mic LIVE"
                    } else {
                        "RELEASED — mic muted"
                    }
                );
            }
            last_pressed = pressed;
        }

        // Heartbeat (keeps display VU bar from going stale).
        last_speaking_tick = last_speaking_tick.wrapping_add(1);
        if last_speaking_tick % 50 == 0 {
            display_speak.set_speaking(false);
        }

        std::thread::sleep(Duration::from_millis(20));
    }
}
