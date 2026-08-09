//! Minimal audio-only firmware: WiFi + mic + speaker. No display, no camera,
//! no RPC, no PTT.
//!
//! Mic is unmuted on connect and stays live the whole session — talk freely
//! and the agent will respond. ~80 lines including comments.

use std::time::Duration;

use esp_idf_svc::hal::peripherals::Peripherals;
use log::info;
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

    let agent = va::Agent::create(va::AgentOptions {
        publish: Some(va::PublishOptions {
            capturer: Box::new(mic),
        }),
        subscribe: Some(va::SubscribeOptions {
            renderer: Box::new(speaker),
        }),
        on_state_changed: Some(Box::new(|s| info!("state: {s:?}"))),
        ..Default::default()
    })?;

    agent.connect(
        env_or!("WHIP_ENDPOINT", "http://192.168.1.100:8080/whip"),
        None,
    )?;

    // Wait until connected, then leave the mic on permanently.
    while agent.state() != va::ConnectionState::Connected {
        std::thread::sleep(Duration::from_millis(50));
    }
    agent.set_mic_enabled(true)?;
    info!("Mic LIVE — talk to the agent");

    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}
