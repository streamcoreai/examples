//! Two-wheel desktop-car drivetrain.
//!
//! The chassis has two N20 motors driven by a TC1508 (or compatible) dual
//! H-bridge. Each motor takes a pair of GPIOs (one for forward, one for
//! backward); duty cycle on the active pin sets speed while the inactive
//! pin must stay at zero to avoid shoot-through.
//!
//! Pin assignment (caller decides; this module is hardware-agnostic):
//!
//! - LF — left wheel forward
//! - LB — left wheel backward
//! - RF — right wheel forward
//! - RB — right wheel backward
//!
//! All four channels share one LEDC timer at 5 kHz / 10-bit, which gives
//! quiet motor operation and 1024 duty steps.
//!
//! The controller runs on its own thread. Commands are submitted via a
//! bounded channel so RPC handlers and buttons can fire-and-forget; the
//! worker serialises them and guarantees the motors come to a stop at the
//! end of each timed action.

use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::Result;
use esp_idf_svc::hal::ledc::LedcDriver;
use log::info;

#[derive(Clone, Copy, Debug)]
pub enum MotorAction {
    Stop,
    Forward,
    Backward,
    TurnLeft,
    TurnRight,
    /// Pivot: only right wheel drives forward.
    ForwardLeft,
    /// Pivot: only left wheel drives forward.
    ForwardRight,
    /// Pivot: only right wheel drives backward.
    BackLeft,
    /// Pivot: only left wheel drives backward.
    BackRight,
    /// Choreographed sequence; ignores caller's `duration_ms` after the
    /// first beat and runs for ~`duration_ms` total.
    Fancy,
    /// Quick left/right wiggle in place.
    Shake,
}

#[derive(Clone, Copy, Debug)]
pub struct MotorCommand {
    pub action: MotorAction,
    pub duration_ms: u32,
    pub speed_percent: u8,
}

impl MotorCommand {
    pub fn new(action: MotorAction, duration_ms: u32, speed_percent: u8) -> Self {
        Self {
            action,
            duration_ms,
            speed_percent: speed_percent.min(100),
        }
    }
}

#[derive(Clone)]
pub struct MotorController {
    tx: SyncSender<MotorCommand>,
}

impl MotorController {
    /// Spawn the motor worker. The four LEDC channels must already be
    /// bound to the four H-bridge inputs and share a single timer.
    pub fn spawn(
        mut lf: LedcDriver<'static>,
        mut lb: LedcDriver<'static>,
        mut rf: LedcDriver<'static>,
        mut rb: LedcDriver<'static>,
    ) -> Result<Arc<Self>> {
        let (tx, rx) = sync_channel::<MotorCommand>(8);
        let max_duty = lf.get_max_duty();

        thread::Builder::new()
            .name("motor-controller".into())
            .stack_size(5 * 1024)
            .spawn(move || {
                // Make sure nothing rolls on boot.
                let _ = lf.set_duty(0);
                let _ = lb.set_duty(0);
                let _ = rf.set_duty(0);
                let _ = rb.set_duty(0);

                while let Ok(cmd) = rx.recv() {
                    let d = scale(cmd.speed_percent, max_duty);
                    info!(
                        "motor: {:?} speed={}% duration={}ms",
                        cmd.action, cmd.speed_percent, cmd.duration_ms
                    );

                    match cmd.action {
                        MotorAction::Stop => {
                            set(&mut lf, &mut lb, &mut rf, &mut rb, 0, 0, 0, 0);
                            continue;
                        }
                        MotorAction::Forward => set(&mut lf, &mut lb, &mut rf, &mut rb, d, 0, d, 0),
                        MotorAction::Backward => set(&mut lf, &mut lb, &mut rf, &mut rb, 0, d, 0, d),
                        MotorAction::TurnLeft => set(&mut lf, &mut lb, &mut rf, &mut rb, 0, d, d, 0),
                        MotorAction::TurnRight => set(&mut lf, &mut lb, &mut rf, &mut rb, d, 0, 0, d),
                        MotorAction::ForwardLeft => {
                            set(&mut lf, &mut lb, &mut rf, &mut rb, 0, 0, d, 0)
                        }
                        MotorAction::ForwardRight => {
                            set(&mut lf, &mut lb, &mut rf, &mut rb, d, 0, 0, 0)
                        }
                        MotorAction::BackLeft => set(&mut lf, &mut lb, &mut rf, &mut rb, 0, 0, 0, d),
                        MotorAction::BackRight => set(&mut lf, &mut lb, &mut rf, &mut rb, 0, d, 0, 0),
                        MotorAction::Fancy => {
                            dance(&mut lf, &mut lb, &mut rf, &mut rb, d, cmd.duration_ms);
                            continue;
                        }
                        MotorAction::Shake => {
                            shake(&mut lf, &mut lb, &mut rf, &mut rb, d, cmd.duration_ms);
                            continue;
                        }
                    }

                    if cmd.duration_ms > 0 {
                        thread::sleep(Duration::from_millis(cmd.duration_ms as u64));
                        set(&mut lf, &mut lb, &mut rf, &mut rb, 0, 0, 0, 0);
                    }
                }
            })?;

        Ok(Arc::new(Self { tx }))
    }

    /// Queue a command. Drops silently if the channel is full — the queue
    /// is intentionally short so a flood of RPC calls cannot pile up
    /// minutes of motor activity.
    pub fn send(&self, cmd: MotorCommand) {
        let _ = self.tx.try_send(cmd);
    }
}

fn scale(speed_percent: u8, max_duty: u32) -> u32 {
    (max_duty as u64 * speed_percent.min(100) as u64 / 100) as u32
}

fn set(
    lf: &mut LedcDriver<'static>,
    lb: &mut LedcDriver<'static>,
    rf: &mut LedcDriver<'static>,
    rb: &mut LedcDriver<'static>,
    lf_d: u32,
    lb_d: u32,
    rf_d: u32,
    rb_d: u32,
) {
    let _ = lf.set_duty(lf_d);
    let _ = lb.set_duty(lb_d);
    let _ = rf.set_duty(rf_d);
    let _ = rb.set_duty(rb_d);
}

fn dance(
    lf: &mut LedcDriver<'static>,
    lb: &mut LedcDriver<'static>,
    rf: &mut LedcDriver<'static>,
    rb: &mut LedcDriver<'static>,
    speed: u32,
    total_ms: u32,
) {
    let beat = (total_ms / 8).max(80) as u64;
    let beats: [(u32, u32, u32, u32); 4] = [
        (speed, 0, 0, 0),     // forward-right pivot
        (0, 0, speed, 0),     // forward-left pivot
        (0, speed, 0, 0),     // back-right pivot
        (0, 0, 0, speed),     // back-left pivot
    ];
    for _ in 0..2 {
        for &(a, b, c, d) in &beats {
            set(lf, lb, rf, rb, a, b, c, d);
            thread::sleep(Duration::from_millis(beat));
            set(lf, lb, rf, rb, 0, 0, 0, 0);
            thread::sleep(Duration::from_millis(beat / 2));
        }
    }
}

fn shake(
    lf: &mut LedcDriver<'static>,
    lb: &mut LedcDriver<'static>,
    rf: &mut LedcDriver<'static>,
    rb: &mut LedcDriver<'static>,
    speed: u32,
    total_ms: u32,
) {
    let half = (total_ms / 6).max(60) as u64;
    for _ in 0..3 {
        set(lf, lb, rf, rb, 0, speed, speed, 0);
        thread::sleep(Duration::from_millis(half));
        set(lf, lb, rf, rb, speed, 0, 0, speed);
        thread::sleep(Duration::from_millis(half));
    }
    set(lf, lb, rf, rb, 0, 0, 0, 0);
}
