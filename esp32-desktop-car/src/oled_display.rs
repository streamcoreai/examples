//! Tiny SSD1306 status panel over I2C.
//!
//! The desktop-car ships with a 128×32 (or 128×64) OLED — too small for a
//! full transcript view, so this module only renders connection state,
//! mic state, and the latest line of each side of the conversation.
//!
//! Rendering happens in a background thread that polls a shared `State`
//! at ~5 Hz. Setters are non-blocking and safe to call from RPC handlers,
//! agent callbacks, and the main loop.

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::Result;
use embedded_graphics::{
    mono_font::{
        ascii::{FONT_6X10, FONT_7X13_BOLD},
        MonoTextStyle,
    },
    pixelcolor::BinaryColor,
    prelude::*,
    text::Text,
};
use esp_idf_svc::hal::{
    gpio::AnyIOPin,
    i2c::{I2cConfig, I2cDriver, I2C0},
    units::Hertz,
};
use ssd1306::{
    mode::DisplayConfig, prelude::*, size::DisplaySize128x32, I2CDisplayInterface, Ssd1306,
};

#[derive(Default, Clone)]
struct State {
    connected: bool,
    mic_muted: bool,
    speaking: bool,
    user_text: String,
    assistant_text: String,
}

#[derive(Clone)]
pub struct DisplayHandle {
    state: Arc<spin::Mutex<State>>,
}

impl DisplayHandle {
    /// Spawn the OLED renderer thread. Bus is dedicated — share the I2C
    /// pins with nothing else (the SSD1306 wants the bus exclusively).
    pub fn spawn(
        i2c: I2C0<'static>,
        sda: AnyIOPin<'static>,
        scl: AnyIOPin<'static>,
    ) -> Result<Self> {
        let state = Arc::new(spin::Mutex::new(State::default()));
        let st = state.clone();
        thread::Builder::new()
            .name("oled-display".into())
            .stack_size(8 * 1024)
            .spawn(move || {
                if let Err(e) = run(i2c, sda, scl, st) {
                    log::error!("OLED thread crashed: {e:?}");
                }
            })?;
        Ok(Self { state })
    }

    pub fn set_connected(&self, v: bool) {
        self.state.lock().connected = v;
    }
    pub fn set_mic_muted(&self, v: bool) {
        self.state.lock().mic_muted = v;
    }
    pub fn set_speaking(&self, v: bool) {
        self.state.lock().speaking = v;
    }
    pub fn set_user_text(&self, t: String) {
        self.state.lock().user_text = t;
    }
    pub fn push_user_final(&self, t: String) {
        self.state.lock().user_text = t;
    }
    pub fn append_assistant_text(&self, t: &str) {
        let mut s = self.state.lock();
        s.assistant_text.push_str(t);
        let n = s.assistant_text.chars().count();
        if n > 80 {
            s.assistant_text = s.assistant_text.chars().skip(n - 80).collect();
        }
    }
}

fn run(
    i2c: I2C0<'static>,
    sda: AnyIOPin<'static>,
    scl: AnyIOPin<'static>,
    state: Arc<spin::Mutex<State>>,
) -> anyhow::Result<()> {
    let cfg = I2cConfig::new().baudrate(Hertz(400_000));
    let driver = I2cDriver::new(i2c, sda, scl, &cfg)?;
    let iface = I2CDisplayInterface::new(driver);

    // 128×32 by default. Switch to DisplaySize128x64 here if your panel is
    // the taller variant — nothing else in this firmware needs to change.
    let mut display = Ssd1306::new(iface, DisplaySize128x32, DisplayRotation::Rotate0)
        .into_buffered_graphics_mode();
    display
        .init()
        .map_err(|e| anyhow::anyhow!("ssd1306 init failed: {e:?}"))?;

    let bold = MonoTextStyle::new(&FONT_7X13_BOLD, BinaryColor::On);
    let small = MonoTextStyle::new(&FONT_6X10, BinaryColor::On);

    loop {
        let s = state.lock().clone();
        let status = format!(
            "{} {}",
            if s.connected { "ONLINE" } else { "OFFLINE" },
            if s.mic_muted {
                "MUTE"
            } else if s.speaking {
                "AI..."
            } else {
                "MIC"
            },
        );

        let _ = display.clear(BinaryColor::Off);
        let _ = Text::new(&status, Point::new(0, 11), bold).draw(&mut display);
        let _ = Text::new(
            &truncate(&s.user_text, 21),
            Point::new(0, 24),
            small,
        )
        .draw(&mut display);
        let _ = display.flush();

        thread::sleep(Duration::from_millis(200));
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    let n = s.chars().count();
    if n <= max_chars {
        return s.to_string();
    }
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= max_chars - 1 {
            break;
        }
        out.push(c);
    }
    out.push('~');
    out
}
