//! Headless firmware: WiFi + mic + speaker + everything via callbacks.
//!
//! No display, no camera, no PTT button — purpose-built for boards that
//! drive their own UI through callbacks (LEDs, external display, telemetry,
//! data-stream subscribers, etc.).
//!
//! Demonstrates `publish_data` (topic-based packets) and `on_data` (inbound
//! topics from the server).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

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

fn main() -> anyhow::Result<()> {
    va::system_init();
    let p = Peripherals::take()?;

    let _wifi = va::wifi::connect_sta(
        p.modem,
        env_or!("WIFI_SSID", "your-wifi-ssid"),
        env_or!("WIFI_PASSWORD", "your-wifi-password"),
    )?;

    let mic = va::I2sMicCapturer::new(
        p.i2s1,
        p.pins.gpio41.degrade_input_output(),
        p.pins.gpio2.degrade_input_output(),
        p.pins.gpio42.degrade_input_output(),
        true,
    )?;
    let speaker = va::I2sSpeakerRenderer::new(
        p.i2s0,
        p.pins.gpio46.degrade_input_output(),
        p.pins.gpio3.degrade_input_output(),
        p.pins.gpio1.degrade_input_output(),
        24_000,
    )?;

    let utterance = Arc::new(AtomicU32::new(0));
    let counter_cb = utterance.clone();

    let agent = va::Agent::create(va::AgentOptions {
        publish: Some(va::PublishOptions {
            capturer: Box::new(mic),
        }),
        subscribe: Some(va::SubscribeOptions {
            renderer: Box::new(speaker),
        }),
        on_state_changed: Some(Box::new(|s| info!("state: {s:?}"))),
        on_transcript: Some(Box::new(move |text, is_final| {
            if is_final {
                let n = counter_cb.fetch_add(1, Ordering::Relaxed) + 1;
                info!("[utterance #{n}] you: {text}");
            }
        })),
        on_response: Some(Box::new(|text| info!("ai: {text}"))),
        on_error: Some(Box::new(|m| warn!("server: {m}"))),
        // Topic-based inbound packets (publish_data on the server side).
        on_data: Some(Box::new(|topic, payload| {
            info!(
                "data on '{}': {} bytes ({:?}...)",
                topic,
                payload.len(),
                &payload[..payload.len().min(16)]
            );
        })),
        // Catches any unhandled JSON event — useful for debugging custom
        // server-side protocols.
        on_raw_event: Some(Box::new(|raw| {
            log::trace!("raw dc frame: {raw}");
        })),
        ..Default::default()
    })?;

    // Demonstrate device → server topic-addressed packets.
    agent.rpc_register("ping", |inv| {
        info!("ping called, params: {}", inv.params);
        inv.return_ok(serde_json::json!({"pong": true, "uptime_secs": uptime_secs()}));
    })?;

    agent.connect(
        env_or!("WHIP_ENDPOINT", "http://192.168.1.100:8080/whip"),
        None,
    )?;

    // App owns the loop. Push a heartbeat packet every 30s.
    let mut last_heartbeat = std::time::Instant::now();
    while agent.state() != va::ConnectionState::Connected {
        std::thread::sleep(Duration::from_millis(50));
    }
    agent.set_mic_enabled(true)?;

    loop {
        if last_heartbeat.elapsed() > Duration::from_secs(30) {
            let payload = serde_json::json!({"uptime_secs": uptime_secs()}).to_string();
            let _ = agent.publish_data("heartbeat", payload.as_bytes());
            last_heartbeat = std::time::Instant::now();
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn uptime_secs() -> u64 {
    unsafe { esp_idf_sys::esp_timer_get_time() as u64 / 1_000_000 }
}
