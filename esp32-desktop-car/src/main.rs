//! Desktop-car firmware: a voice-driven 2-wheel robot.
//!
//! Hardware (ESP32-S3 + INMP441 mic + MAX98357A speaker + SSD1306 OLED +
//! TC1508 dual-H-bridge driving two N20 wheel motors):
//!
//! | Block            | Pins                                    |
//! | ---------------- | --------------------------------------- |
//! | Mic   (I2S RX)   | BCLK=5  DIN=6  WS=4                     |
//! | Spkr  (I2S TX)   | BCLK=15 DOUT=7 WS=16  (24 kHz)          |
//! | OLED  (I2C)      | SDA=41  SCL=42                          |
//! | Motor (LEDC PWM) | LF=12   LB=13  RF=14  RB=21             |
//! | Buttons          | BOOT=0  TOUCH=47 (either toggles mute)  |
//!
//! Mental model — same as every other voiceagent-esp32 example:
//!   1. App owns WiFi.
//!   2. App owns the media pipeline (mic, speaker, display, motors).
//!   3. App owns the main loop (PTT button, mute toggle…).
//!   4. SDK runs the WebRTC transport on its own thread; the agent
//!      surfaces a stateful handle plus a set of callbacks.
//!   5. The robot's drivetrain is exposed to the AI as a small set of
//!      RPC tools (`car.forward`, `car.turn_left`, `car.fancy`, …).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail};
use esp_idf_svc::eventloop::EspSystemEventLoop;
use esp_idf_svc::hal::gpio::{AnyIOPin, PinDriver, Pull};
use esp_idf_svc::hal::i2s::{
    config::{
        Config as I2sConfig, DataBitWidth, SlotMode, StdClkConfig, StdConfig, StdGpioConfig,
        StdSlotConfig,
    },
    I2sDriver, I2S1,
};
use esp_idf_svc::hal::ledc::{config::TimerConfig, LedcDriver, LedcTimerDriver, Resolution};
use esp_idf_svc::hal::modem::Modem;
use esp_idf_svc::hal::peripherals::Peripherals;
use esp_idf_svc::hal::units::Hertz;
use esp_idf_svc::nvs::EspDefaultNvsPartition;
use esp_idf_svc::wifi::{AuthMethod, BlockingWifi, ClientConfiguration, Configuration, EspWifi};

/// Set to `true` to skip the normal firmware and run a one-shot mic-slot
/// probe instead. Reads ~1 s of STEREO I2S audio, reports peak / average
/// level for the LEFT and RIGHT slot independently, then halts. Use to
/// determine which slot your INMP441 actually outputs on (depends on
/// whether its L/R pin is tied to GND or VCC). Flash with this `true`,
/// read the log, update `esp32/src/capture.rs` slot mask accordingly,
/// flip this back to `false`, rebuild.
const PROBE_MIC_SLOTS: bool = false;
use log::{info, warn};
use voiceagent_esp32 as va;

mod motor_controller;
mod oled_display;

use motor_controller::{MotorAction, MotorCommand, MotorController};
use oled_display::DisplayHandle;

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

/// If TOKEN_URL is configured, hit it (optionally with `Authorization:
/// Bearer <API_KEY>`) and extract the JWT the server returns. Pass that
/// JWT to `Agent::connect`. If TOKEN_URL is empty we connect anonymously
/// — works only when the server's `jwt_secret` is unset.
fn obtain_jwt(token_url: Option<&str>, api_key: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(url) = token_url else {
        info!("auth: TOKEN_URL not set — connecting anonymously");
        return Ok(None);
    };
    info!("auth: fetching JWT from {url}");
    let tok = va::whip::fetch_token(url, api_key)?;
    info!("auth: got JWT ({} chars)", tok.len());
    Ok(Some(tok))
}

fn main() -> anyhow::Result<()> {
    va::system_init();
    let p = Peripherals::take()?;
    log_heap("boot");

    if PROBE_MIC_SLOTS {
        // Captures stereo audio for ~3 s, prints per-channel levels, then
        // halts. Use this once when bringing up a new board to figure out
        // whether the INMP441 lives on the LEFT or RIGHT slot.
        if let Err(e) = probe_mic_slots(
            p.i2s1,
            p.pins.gpio5.degrade_input_output(),
            p.pins.gpio6.degrade_input_output(),
            p.pins.gpio4.degrade_input_output(),
        ) {
            warn!("mic probe failed: {e:?}");
        }
        info!("probe done — set PROBE_MIC_SLOTS = false in main.rs and rebuild");
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    // ------------------------------------------------------------------ 1.
    // WiFi. Local helper instead of va::wifi::connect_sta — the SDK helper
    // hard-codes WPA2-only, which fails against WPA3 / WPA2-WPA3 mixed
    // routers. We also log the SSID up front so it's obvious whether the
    // `.env` baked into the firmware actually matches your network.
    let _wifi = connect_wifi(
        p.modem,
        env_or!("WIFI_SSID", "your-wifi-ssid"),
        env_or!("WIFI_PASSWORD", "your-wifi-password"),
    )?;
    log_heap("after wifi");

    // ------------------------------------------------------------------ 2.
    // Audio pipeline.
    // AFE on (WEBRTC NS + AGC). Wake-word detection is wired through the
    // SDK (via `new_with_wakenet`) but currently OFF — flipping it on
    // requires the matching ESP-SR sdkconfig + model partition setup,
    // see sdkconfig.defaults for the steps.
    let use_afe = true;
    let mic = va::I2sMicCapturer::new(
        p.i2s1,
        p.pins.gpio5.degrade_input_output(), // BCLK
        p.pins.gpio6.degrade_input_output(), // DIN
        p.pins.gpio4.degrade_input_output(), // WS
        use_afe,
    )?;
    log_heap("after mic");
    let speaker = va::I2sSpeakerRenderer::new(
        p.i2s0,
        p.pins.gpio15.degrade_input_output(), // BCLK
        p.pins.gpio7.degrade_input_output(),  // DOUT
        p.pins.gpio16.degrade_input_output(), // WS
        24_000,
    )?;
    log_heap("after speaker");

    // ------------------------------------------------------------------ 3.
    // Drivetrain: four LEDC channels share a single 5 kHz, 10-bit timer.
    let timer_cfg = TimerConfig::new()
        .frequency(Hertz(5_000))
        .resolution(Resolution::Bits10);
    let timer = LedcTimerDriver::new(p.ledc.timer0, &timer_cfg)?;
    // Leak the timer so the LedcDrivers below can hold a 'static borrow
    // and the resulting `MotorController` is itself `'static + Send`.
    let timer: &'static _ = Box::leak(Box::new(timer));
    log_heap("before motor spawn");
    let motor = MotorController::spawn(
        LedcDriver::new(p.ledc.channel0, timer, p.pins.gpio12)?, // LF
        LedcDriver::new(p.ledc.channel1, timer, p.pins.gpio13)?, // LB
        LedcDriver::new(p.ledc.channel2, timer, p.pins.gpio14)?, // RF
        LedcDriver::new(p.ledc.channel3, timer, p.pins.gpio21)?, // RB
    )?;
    log_heap("after motor spawn");

    // ------------------------------------------------------------------ 4.
    // OLED status panel.
    let display = DisplayHandle::spawn(
        p.i2c0,
        p.pins.gpio41.degrade_input_output(), // SDA
        p.pins.gpio42.degrade_input_output(), // SCL
    )?;

    let display_state = display.clone();
    let display_ui = display.clone();
    let display_resp = display.clone();
    let display_mic = display.clone();

    let connected = Arc::new(AtomicBool::new(false));
    let connected_cb = connected.clone();

    let motor_for_data = motor.clone();
    let display_wake = display.clone();

    // ------------------------------------------------------------------ 5.
    // Agent — create now (no network yet), wire callbacks.
    let agent = va::Agent::create(va::AgentOptions {
        publish: Some(va::PublishOptions {
            capturer: Box::new(mic),
        }),
        subscribe: Some(va::SubscribeOptions {
            renderer: Box::new(speaker),
        }),
        on_state_changed: Some(Box::new(move |s| {
            info!("agent state: {s:?}");
            let online = s == va::ConnectionState::Connected;
            display_state.set_connected(online);
            connected_cb.store(online, Ordering::SeqCst);
        })),
        on_transcript: Some(Box::new(move |text, is_final| {
            info!("user: {text} (final={is_final})");
            if is_final {
                display_ui.push_user_final(text.into());
            } else {
                display_ui.set_user_text(text.into());
            }
        })),
        on_response: Some(Box::new(move |text| {
            info!("ai: {text}");
            display_resp.append_assistant_text(text);
            display_resp.set_speaking(true);
        })),
        // Drivetrain commands arrive over the "car.command" topic — the
        // server's native car.* tools translate every LLM tool call into
        // a topic-addressed data packet, which the SDK delivers here.
        on_data: Some(Box::new(move |topic: &str, bytes: &[u8]| {
            if topic != "car.command" {
                return;
            }
            match parse_car_command(bytes) {
                Some((action, duration_ms, speed)) => {
                    motor_for_data.send(MotorCommand::new(action, duration_ms, speed));
                }
                None => warn!("ignoring malformed car.command payload"),
            }
        })),
        on_error: Some(Box::new(|m| warn!("server error: {m}"))),
        // on_wake_word hook stays connected once wake-word is enabled —
        // left as a no-op placeholder so the firmware compiles with the
        // wake-off config too.
        ..Default::default()
    })?;
    drop(display_wake);

    agent.rpc_register("get_device_info", |inv| {
        inv.return_ok(serde_json::json!({
            "model":  "esp32-s3-desktop-car",
            "wheels": 2,
            "sdk":    env!("CARGO_PKG_VERSION"),
        }));
    })?;

    // ------------------------------------------------------------------ 6.
    // Connect.
    //
    // The server's /whip endpoint is JWT-protected when `jwt_secret` is
    // set in config.toml. We must POST /token first to mint a JWT (using
    // API_KEY as a bearer if the server also requires it), then hand the
    // JWT to `agent.connect`. Passing TOKEN_URL directly here would send
    // "Bearer http://…/token" as the auth header — which is exactly the
    // "HTTP 401: invalid token" we used to see.
    let jwt = obtain_jwt(opt(env_or!("TOKEN_URL", "")), opt(env_or!("API_KEY", "")))?;
    agent.connect(
        env_or!("WHIP_ENDPOINT", "http://192.168.1.100:8080/whip"),
        jwt.as_deref(),
    )?;

    // ------------------------------------------------------------------ 7.
    // Main loop: mic streams continuously (no default mute — voice
    // activation is via on-device wake word "Hi ESP", surfaced through
    // the on_wake_word callback above). BOOT (GPIO0) or touch pad
    // (GPIO47) still act as a manual mute toggle if you need a privacy
    // switch.
    let boot_btn = PinDriver::input(p.pins.gpio0.degrade_input_output(), Pull::Up)?;
    let touch_btn = PinDriver::input(p.pins.gpio47.degrade_input_output(), Pull::Up)?;

    let mut last_boot = false;
    let mut last_touch = false;
    let mut muted = false;
    let mut tick: u32 = 0;
    // Mic starts live on connection so the wake word can be heard.
    let mut mic_was_enabled = false;

    info!("ready — say \"Hi ESP\" to wake. BOOT/touch toggles manual mute.");

    loop {
        let boot_now = boot_btn.is_low();
        let touch_now = touch_btn.is_low();

        // Once connected, ensure the mic is enabled so the WakeNet stage
        // gets samples. This is the "unmute by default" behaviour.
        if !mic_was_enabled && connected.load(Ordering::SeqCst) && !muted {
            let _ = agent.set_mic_enabled(true);
            display_mic.set_mic_muted(false);
            mic_was_enabled = true;
        }

        // Falling edge on EITHER button = one mute toggle (manual override).
        let edge = (boot_now && !last_boot) || (touch_now && !last_touch);
        if edge {
            muted = !muted;
            if connected.load(Ordering::SeqCst) {
                let _ = agent.set_mic_enabled(!muted);
            }
            display_mic.set_mic_muted(muted);
            info!("mic {}", if muted { "MUTED" } else { "LIVE" });
        }
        last_boot = boot_now;
        last_touch = touch_now;

        // Clear the "AI is speaking" display flag after a quiet beat.
        tick = tick.wrapping_add(1);
        if tick % 50 == 0 {
            display_mic.set_speaking(false);
        }

        // 20 ms loop = effective debounce; no separate debouncer needed.
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// One-shot diagnostic: opens I2S1 in STEREO mode (captures both LEFT and
/// RIGHT slots), grabs ~3 seconds of audio, and prints peak + average
/// magnitude per channel. The channel with substantially higher levels
/// during normal room ambience / speech is where your INMP441 actually
/// outputs — use that for `StdSlotMask::Left` or `StdSlotMask::Right` in
/// `esp32/src/capture.rs`.
fn probe_mic_slots(
    i2s: I2S1<'static>,
    bclk: AnyIOPin<'static>,
    din: AnyIOPin<'static>,
    ws: AnyIOPin<'static>,
) -> anyhow::Result<()> {
    use esp_idf_svc::hal::delay::TickType;

    // Stereo, 32-bit data, Philips, left-aligned. Identical wire config
    // to the SDK's mono path so the only thing that changes is we keep
    // *both* slots in the DMA buffer instead of LEFT only.
    let slot = StdSlotConfig::philips_slot_default(DataBitWidth::Bits32, SlotMode::Stereo)
        .left_align(true);
    let cfg = StdConfig::new(
        I2sConfig::default()
            .dma_buffer_count(8)
            .frames_per_buffer(480),
        StdClkConfig::from_sample_rate_hz(16_000),
        slot,
        StdGpioConfig::default(),
    );
    let mut driver = I2sDriver::new_std_rx(i2s, &cfg, bclk, din, AnyIOPin::none(), ws)?;
    driver.rx_enable()?;
    info!("PROBE: capturing 3 s of stereo audio — talk normally now…");

    // 3 s at 16 kHz stereo, 4 bytes per slot = 16000 * 3 * 8 = 384000 bytes.
    const TOTAL_BYTES: usize = 384_000;
    const CHUNK: usize = 4 * 1024;
    let mut buf = vec![0u8; CHUNK];
    let mut left_peak: i32 = 0;
    let mut right_peak: i32 = 0;
    let mut left_sum: u64 = 0;
    let mut right_sum: u64 = 0;
    let mut frames: u64 = 0;
    let mut read_total: usize = 0;
    let tmo = TickType::new_millis(500).0;

    while read_total < TOTAL_BYTES {
        let to_read = CHUNK.min(TOTAL_BYTES - read_total);
        let n = driver.read(&mut buf[..to_read], tmo)?;
        if n == 0 {
            warn!("PROBE: I2S read returned 0 — bailing");
            break;
        }
        // 8 bytes per stereo frame (4 left + 4 right, little-endian).
        for chunk in buf[..n].chunks_exact(8) {
            let l = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) >> 12;
            let r = i32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) >> 12;
            let la = l.unsigned_abs() as u64;
            let ra = r.unsigned_abs() as u64;
            if la as i32 > left_peak {
                left_peak = la as i32;
            }
            if ra as i32 > right_peak {
                right_peak = ra as i32;
            }
            left_sum += la;
            right_sum += ra;
            frames += 1;
        }
        read_total += n;
    }
    let _ = driver.rx_disable();

    let l_avg = if frames > 0 { left_sum / frames } else { 0 };
    let r_avg = if frames > 0 { right_sum / frames } else { 0 };
    info!("PROBE: frames={frames}");
    info!("PROBE: LEFT  peak={left_peak:>6}  avg={l_avg:>5}");
    info!("PROBE: RIGHT peak={right_peak:>6}  avg={r_avg:>5}");
    if left_peak > right_peak.saturating_mul(2) {
        info!("PROBE: => mic is on LEFT slot. In esp32/src/capture.rs use StdSlotMask::Left.");
    } else if right_peak > left_peak.saturating_mul(2) {
        info!("PROBE: => mic is on RIGHT slot. In esp32/src/capture.rs use StdSlotMask::Right.");
    } else {
        warn!(
            "PROBE: both channels read similar levels. INMP441 L/R may be floating, \
             power could be bad, or there's no real signal. Check VDD=3.3 V, GND, \
             and try tapping the mic while running the probe again."
        );
    }
    Ok(())
}

/// Log internal DRAM free + largest contiguous block. ENOMEM during
/// pthread_create is almost always "largest_block is smaller than the
/// requested stack" — this helper makes that diagnosable from the boot
/// log.
fn log_heap(tag: &str) {
    use esp_idf_svc::sys::{heap_caps_get_free_size, heap_caps_get_largest_free_block};
    const MALLOC_CAP_INTERNAL: u32 = 1 << 11; // bit-flag from esp_heap_caps.h
    const MALLOC_CAP_SPIRAM: u32 = 1 << 10;
    unsafe {
        let i_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
        let i_blk = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
        let p_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
        info!("HEAP[{tag}]: internal_free={i_free} (largest_block={i_blk})  psram_free={p_free}");
    }
}

/// WiFi station helper with WPA2/WPA3 auto and a scan-first diagnostic.
///
/// The SDK's `va::wifi::connect_sta` hard-codes `AuthMethod::WPA2Personal`
/// and gives no log output if the AP isn't reachable — both unhelpful on
/// modern routers. This helper:
///   * logs the SSID + lengths up front (catches missing `.env`),
///   * runs a scan first and dumps the visible APs if the target SSID is
///     not seen (catches "5 GHz only" and typos),
///   * uses `WPA2WPA3Personal` auth which covers both WPA2 and WPA3.
fn connect_wifi(
    modem: Modem<'static>,
    ssid: &str,
    password: &str,
) -> anyhow::Result<Box<EspWifi<'static>>> {
    info!(
        "WiFi: connecting to SSID {:?} (ssid_len={}, password_len={})",
        ssid,
        ssid.len(),
        password.len()
    );
    if ssid.is_empty() || ssid == "your-wifi-ssid" {
        bail!("WIFI_SSID is unset — write it into .env and rebuild");
    }

    let sysloop = EspSystemEventLoop::take()?;
    let nvs = EspDefaultNvsPartition::take()?;
    let mut wifi = Box::new(EspWifi::new(modem, sysloop.clone(), Some(nvs))?);

    let mut ssid_buf = heapless::String::<32>::new();
    ssid_buf
        .push_str(ssid)
        .map_err(|_| anyhow!("SSID too long (>32)"))?;
    let mut pass_buf = heapless::String::<64>::new();
    pass_buf
        .push_str(password)
        .map_err(|_| anyhow!("password too long (>64)"))?;

    let auth = if password.is_empty() {
        AuthMethod::None
    } else {
        AuthMethod::WPA2WPA3Personal
    };

    wifi.set_configuration(&Configuration::Client(ClientConfiguration {
        ssid: ssid_buf,
        password: pass_buf,
        auth_method: auth,
        ..Default::default()
    }))?;

    let mut blocking = BlockingWifi::wrap(&mut *wifi, sysloop)?;
    blocking.start()?;

    // Scan first so we can give a useful error if the SSID isn't visible
    // (most often: hidden network, typo, or 5-GHz-only on a smart-connect
    // router — ESP32-S3 is 2.4 GHz only).
    match blocking.scan() {
        Ok(aps) => {
            let visible = aps.iter().any(|ap| ap.ssid.as_str() == ssid);
            if !visible {
                warn!(
                    "WiFi: SSID {:?} not found in {} visible AP(s) — listing them:",
                    ssid,
                    aps.len()
                );
                for ap in &aps {
                    warn!(
                        "  - {:?} ch={} rssi={} auth={:?}",
                        ap.ssid.as_str(),
                        ap.channel,
                        ap.signal_strength,
                        ap.auth_method
                    );
                }
                warn!(
                    "WiFi: not visible can mean (a) typo, (b) hidden SSID, \
                     or (c) the network is 5 GHz only — ESP32-S3 is 2.4 GHz."
                );
            } else {
                info!("WiFi: SSID found in scan, associating...");
            }
        }
        Err(e) => warn!("WiFi: scan failed: {e:?} — trying connect anyway"),
    }

    blocking.connect()?;
    info!("WiFi: associated, waiting for IP...");
    blocking.wait_netif_up()?;

    let ip_info = blocking.wifi().sta_netif().get_ip_info()?;
    info!("WiFi: got IP {:?}", ip_info.ip);
    if ip_info.ip.is_unspecified() {
        bail!("WiFi associated but did not get an IP — check DHCP / MAC filtering");
    }
    Ok(wifi)
}

/// Parse a `car.command` payload coming over the data channel. The server
/// emits JSON `{"action": "...", "duration_ms": ..., "speed_percent": ...}`;
/// duration / speed are optional and clamped here defensively (the server
/// already clamps, but a hostile sender should not be able to spin the
/// wheels for an hour).
fn parse_car_command(bytes: &[u8]) -> Option<(MotorAction, u32, u8)> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let action = match v.get("action").and_then(|x| x.as_str())? {
        "forward" => MotorAction::Forward,
        "backward" => MotorAction::Backward,
        "turn_left" => MotorAction::TurnLeft,
        "turn_right" => MotorAction::TurnRight,
        "pivot_forward_left" => MotorAction::ForwardLeft,
        "pivot_forward_right" => MotorAction::ForwardRight,
        "pivot_back_left" => MotorAction::BackLeft,
        "pivot_back_right" => MotorAction::BackRight,
        "stop" => MotorAction::Stop,
        "fancy" => MotorAction::Fancy,
        "shake" => MotorAction::Shake,
        other => {
            warn!("unknown car action: {other}");
            return None;
        }
    };

    let (default_dur, default_speed) = match action {
        MotorAction::Stop => (0u32, 0u8),
        MotorAction::Fancy => (3000, 80),
        MotorAction::Shake => (1200, 90),
        _ => (1500, 80),
    };
    let duration_ms = v
        .get("duration_ms")
        .and_then(|x| x.as_u64())
        .unwrap_or(default_dur as u64)
        .min(10_000) as u32;
    let speed = v
        .get("speed_percent")
        .and_then(|x| x.as_u64())
        .unwrap_or(default_speed as u64)
        .min(100) as u8;
    Some((action, duration_ms, speed))
}
