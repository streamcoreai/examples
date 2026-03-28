use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{prelude::*, widgets::*};
use tokio::sync::mpsc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use streamcore_rust_sdk::{Client, Config, EventHandler, FRAME_SIZE};

// -- Constants --

#[derive(Debug, Clone)]
enum UiMsg {
    Status(String),
    Transcript { role: String, text: String, partial: bool },
    VolumeLocal(f64),
    VolumeRemote(f64),
    Error(String),
}

struct App {
    status: String,
    transcripts: Vec<(String, String, bool)>,
    local_volume: Vec<f64>,
    remote_volume: Vec<f64>,
    is_muted: Arc<AtomicBool>,
    error: Option<String>,
}

impl App {
    fn new(is_muted: Arc<AtomicBool>) -> Self {
        Self {
            status: "Disconnected".to_string(),
            transcripts: Vec::new(),
            local_volume: vec![0.0; 40],
            remote_volume: vec![0.0; 40],
            is_muted,
            error: None,
        }
    }

    fn on_tick(&mut self) {
        // We could decay volumes here if we weren't getting constant updates
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let whip_url = std::env::var("WHIP_URL")
        .unwrap_or_else(|_| "http://localhost:8080/whip".to_string());

    let (ui_tx, mut ui_rx) = mpsc::channel::<UiMsg>(100);
    let is_muted = Arc::new(AtomicBool::new(true));

    // SDK Client
    let ui_tx_status = ui_tx.clone();
    let ui_tx_transcript = ui_tx.clone();
    let ui_tx_err = ui_tx.clone();

    let client = Arc::new(Client::new(
        Config {
            whip_endpoint: whip_url.clone(),
            ..Default::default()
        },
        EventHandler {
            on_status_change: Some(Box::new(move |status| {
                let _ = ui_tx_status.try_send(UiMsg::Status(status.to_string()));
            })),
            on_transcript: Some(Box::new(move |entry, _| {
                let _ = ui_tx_transcript.try_send(UiMsg::Transcript {
                    role: entry.role.clone(),
                    text: entry.text.clone(),
                    partial: entry.partial,
                });
            })),
            on_error: Some(Box::new(move |err| {
                let _ = ui_tx_err.try_send(UiMsg::Error(err.to_string()));
            })),
            on_data_channel_message: None,
        },
    ));

    let mut app = App::new(is_muted.clone());
    let tick_rate = Duration::from_millis(33); // ~30 FPS UI
    let mut last_tick = Instant::now();

    // Background connection task
    let client_conn = Arc::clone(&client);
    let ui_tx_conn_err = ui_tx.clone();
    tokio::spawn(async move {
        if let Err(e) = client_conn.connect().await {
            let _ = ui_tx_conn_err.try_send(UiMsg::Error(format!("Connect error: {}", e)));
        }
    });

    // Start audio tasks
    let client_audio = Arc::clone(&client);
    let is_muted_audio = is_muted.clone();
    let ui_tx_vol = ui_tx.clone();
    tokio::spawn(async move {
        if let Err(e) = run_mic_capture(client_audio, is_muted_audio, ui_tx_vol).await {
            log_error(&format!("Mic capture error: {}", e));
        }
    });

    let client_remote = Arc::clone(&client);
    let ui_tx_vol_remote = ui_tx.clone();
    tokio::spawn(async move {
        if let Err(e) = run_speaker_playback(client_remote, ui_tx_vol_remote).await {
            log_error(&format!("Speaker playback error: {}", e));
        }
    });

    // Main UI Loop
    loop {
        terminal.draw(|f| ui(f, &app))?;

        let timeout = tick_rate
            .checked_sub(last_tick.elapsed())
            .unwrap_or_else(|| Duration::from_secs(0));

        if event::poll(timeout)? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Char('q') | KeyCode::Esc => break,
                        KeyCode::Char('c') if key.modifiers.contains(event::KeyModifiers::CONTROL) => break,
                        KeyCode::Char(' ') => {
                            let muted = !app.is_muted.load(Ordering::Relaxed);
                            app.is_muted.store(muted, Ordering::Relaxed);
                        }
                        _ => {}
                    }
                }
            }
        }

        // Handle UI messages
        while let Ok(msg) = ui_rx.try_recv() {
            match msg {
                UiMsg::Status(s) => app.status = s,
                UiMsg::Transcript { role, text, partial } => {
                    if let Some(last) = app.transcripts.last_mut() {
                        if last.2 && last.0 == role {
                            *last = (role, text, partial);
                            continue;
                        }
                    }
                    app.transcripts.push((role, text, partial));
                    if app.transcripts.len() > 10 {
                        app.transcripts.remove(0);
                    }
                }
                UiMsg::VolumeLocal(v) => {
                    app.local_volume.push(v);
                    app.local_volume.remove(0);
                }
                UiMsg::VolumeRemote(v) => {
                    app.remote_volume.push(v);
                    app.remote_volume.remove(0);
                }
                UiMsg::Error(e) => app.error = Some(e),
            }
        }

        if last_tick.elapsed() >= tick_rate {
            app.on_tick();
            last_tick = Instant::now();
        }
    }

    // Restore terminal
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    Ok(())
}

fn ui(f: &mut Frame, app: &App) {
    let main_layout = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(3), // Header
            Constraint::Length(9), // Signal Monitor
            Constraint::Min(5),    // Transcript
            Constraint::Length(1), // Footer
        ])
        .split(f.size());

    // -- Header --
    let title_block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(Color::Rgb(125, 86, 244)));
    
    let title = Paragraph::new(Line::from(vec![
        Span::styled(" 🎙️  StreamCoreAI Voice Agent ", Style::default().fg(Color::White).bg(Color::Rgb(125, 86, 244)).add_modifier(Modifier::BOLD)),
        Span::styled("  Ratatui Dashboard  ", Style::default().fg(Color::Rgb(125, 86, 244)).add_modifier(Modifier::ITALIC)),
    ]))
    .alignment(Alignment::Center)
    .block(title_block);
    f.render_widget(title, main_layout[0]);

    // -- Signal Monitor (Consolidated Status + Waves) --
    let monitor_block = Block::default()
        .title(" SIGNAL MONITOR ")
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(Color::Rgb(255, 118, 184)));
    
    let monitor_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(30), Constraint::Percentage(70)])
        .split(monitor_block.inner(main_layout[1]));

    // Status Pane
    let status_color = if app.status == "connected" { Color::Green } else { Color::Yellow };
    let is_muted = app.is_muted.load(Ordering::Relaxed);
    let mute_color = if is_muted { Color::Red } else { Color::Green };
    let mute_text = if is_muted { "🔴 MUTED" } else { "🟢 ACTIVE" };

    let status_pane = Paragraph::new(vec![
        Line::from(vec![Span::raw("Network: "), Span::styled(&app.status, Style::default().fg(status_color).add_modifier(Modifier::BOLD))]),
        Line::from(""),
        Line::from(vec![Span::raw("Signal:  "), Span::styled(mute_text, Style::default().fg(mute_color).add_modifier(Modifier::BOLD))]),
    ]).alignment(Alignment::Left);
    
    f.render_widget(monitor_block, main_layout[1]);
    f.render_widget(status_pane, monitor_chunks[0]);

    // Waves Pane
    let user_wave = render_pulse_wave(&app.local_volume, Color::Rgb(255, 118, 184));
    let agent_wave = render_pulse_wave(&app.remote_volume, Color::Rgb(4, 181, 117));
    
    let waves_pane = Paragraph::new(vec![
        Line::from(""),
        Line::from(vec![Span::raw("YOU:   "), user_wave]),
        Line::from(""),
        Line::from(vec![Span::raw("AGENT: "), agent_wave]),
    ]);
    f.render_widget(waves_pane, monitor_chunks[1]);

    // -- Transcripts --
    let available_width = main_layout[2].width.saturating_sub(4) as usize; // borders + padding
    let label_width = 11; // " Agent ❯ " + " " visual width

    let mut lines: Vec<Line> = Vec::new();
    for (role, text, partial) in &app.transcripts {
        let name = if role == "assistant" { " Agent ❯ " } else { " You ❯   " };
        let name_style = if role == "assistant" { 
            Style::default().fg(Color::Black).bg(Color::Rgb(4, 181, 117)).add_modifier(Modifier::BOLD) 
        } else { 
            Style::default().fg(Color::Black).bg(Color::Rgb(255, 118, 184)).add_modifier(Modifier::BOLD) 
        };
        
        let mut content = text.clone();
        if *partial { content.push_str("..."); }

        // Word-wrap content to fit available width
        let first_line_max = available_width.saturating_sub(label_width);
        let cont_line_max = available_width.saturating_sub(label_width);
        let wrapped = wrap_text(&content, first_line_max, cont_line_max);

        for (i, chunk) in wrapped.iter().enumerate() {
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled(name, name_style),
                    Span::raw(" "),
                    Span::raw(chunk.clone()),
                ]));
            } else {
                // Indent continuation lines to align with the text after the label
                let padding = " ".repeat(label_width);
                lines.push(Line::from(vec![
                    Span::raw(padding),
                    Span::raw(chunk.clone()),
                ]));
            }
        }
    }

    // Calculate scroll to show the bottom of the transcript
    let visible_height = main_layout[2].height.saturating_sub(2) as usize; // minus borders
    let total_lines = lines.len();
    let scroll_offset = if total_lines > visible_height {
        (total_lines - visible_height) as u16
    } else {
        0
    };

    let transcript_block = Block::default()
        .title(" CONVERSATION HISTORY ")
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(Color::Rgb(125, 86, 244)));
    
    let transcript = Paragraph::new(lines)
        .block(transcript_block)
        .wrap(Wrap { trim: false })
        .scroll((scroll_offset, 0));
    f.render_widget(transcript, main_layout[2]);

    // -- Footer --
    let footer = Paragraph::new(Line::from(vec![
        Span::styled(" Q ", Style::default().fg(Color::Black).bg(Color::DarkGray)),
        Span::raw(" Quit   "),
        Span::styled(" SPACE ", Style::default().fg(Color::Black).bg(Color::DarkGray)),
        Span::raw(" Hold to Talk"),
    ]))
    .alignment(Alignment::Center);
    f.render_widget(footer, main_layout[3]);

    if let Some(err) = &app.error {
        let area = centered_rect(60, 20, f.size());
        f.render_widget(Clear, area);
        f.render_widget(
            Paragraph::new(err.as_str())
                .block(Block::default().title(" Error ").borders(Borders::ALL).border_type(BorderType::Rounded).border_style(Style::default().fg(Color::Red)))
                .style(Style::default().fg(Color::Red))
                .wrap(Wrap { trim: true }),
            area,
        );
    }
}

/// Word-wrap text into lines that fit within max_width.
/// first_line_max is the max chars for the first line, cont_max for continuation lines.
fn wrap_text(text: &str, first_line_max: usize, cont_max: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let mut result = Vec::new();
    let mut current_line = String::new();
    let max_width = first_line_max;

    for word in text.split_whitespace() {
        let line_max = if result.is_empty() { max_width } else { cont_max };
        if current_line.is_empty() {
            if word.len() > line_max && line_max > 0 {
                // Word is longer than the line — break it
                let mut remaining = word;
                while !remaining.is_empty() {
                    let lm = if result.is_empty() && current_line.is_empty() { max_width } else { cont_max };
                    let take = lm.min(remaining.len());
                    if take == 0 { break; }
                    result.push(remaining[..take].to_string());
                    remaining = &remaining[take..];
                }
            } else {
                current_line = word.to_string();
            }
        } else if current_line.len() + 1 + word.len() > line_max {
            result.push(current_line);
            current_line = word.to_string();
        } else {
            current_line.push(' ');
            current_line.push_str(word);
        }
    }
    if !current_line.is_empty() {
        result.push(current_line);
    }
    if result.is_empty() {
        result.push(String::new());
    }
    result
}

fn render_pulse_wave(history: &[f64], color: Color) -> Span<'static> {
    let current = history.last().copied().unwrap_or(0.0);
    let width = 45;
    let center = width / 2;
    let num_bars = (current * center as f64) as usize;
    
    let mut s = String::with_capacity(width);
    for i in 0..width {
        let dist = if i > center { i - center } else { center - i };
        if dist < num_bars {
            // Gradient effect: █ for core, ▓ for mid, ▒ for edges, ░ for tips
            let ch = if dist >= num_bars - 1 { '░' } 
                      else if dist >= num_bars - 2 { '▒' }
                      else if dist >= num_bars - 3 { '▓' }
                      else { '█' };
            s.push(ch);
        } else {
            s.push(' ');
        }
    }
    Span::styled(format!("[{}]", s), Style::default().fg(color))
}

fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(r);

    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}

// -- Audio Logic (reused and modified from simple rust example) --

fn calculate_rms(pcm: &[f32]) -> f64 {
    if pcm.is_empty() { return 0.0; }
    let sum: f32 = pcm.iter().map(|&x| x * x).sum();
    let rms = (sum / pcm.len() as f32).sqrt();
    // Normalize: human speech in Float32 usually peaks around 0.05 - 0.2 RMS
    let level = (rms as f64) / 0.15;
    level.min(1.0)
}

async fn run_mic_capture(
    client: Arc<Client>,
    is_muted: Arc<AtomicBool>,
    ui_tx: mpsc::Sender<UiMsg>,
) -> Result<()> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| anyhow::anyhow!("No input device"))?;
    let config = device.default_input_config()?.config();
    let input_channels = config.channels as usize;

    let (tx, mut rx) = mpsc::channel::<Vec<f32>>(8);
    std::thread::spawn(move || {
        let mut partial = Vec::with_capacity(FRAME_SIZE);
        let stream = device.build_input_stream(&config, move |data: &[f32], _| {
            let mono: Vec<f32> = data.chunks(input_channels).map(|c| if c.len() > 1 { (c[0] + c[1]) / 2.0 } else { c[0] }).collect();
            partial.extend_from_slice(&mono);
            while partial.len() >= FRAME_SIZE {
                let frame: Vec<f32> = partial.drain(..FRAME_SIZE).collect();
                let _ = tx.try_send(frame);
            }
        }, |_| {}, None).unwrap();
        stream.play().unwrap();
        std::thread::park();
    });

    while let Some(mut frame) = rx.recv().await {
        let rms = calculate_rms(&frame);
        let _ = ui_tx.try_send(UiMsg::VolumeLocal(rms));

        if is_muted.load(Ordering::Relaxed) {
            frame.fill(0.0);
        }

        let _ = client.send_pcm(&frame).await;
    }
    Ok(())
}

async fn run_speaker_playback(
    client: Arc<Client>,
    ui_tx: mpsc::Sender<UiMsg>,
) -> Result<()> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or_else(|| anyhow::anyhow!("No output device"))?;
    let config = device.default_output_config()?.config();
    let output_channels = config.channels as usize;

    let (tx, mut rx) = mpsc::channel::<Vec<f32>>(16);
    std::thread::spawn(move || {
        let mut remaining = Vec::new();
        let stream = device.build_output_stream(&config, move |out: &mut [f32], _| {
            let mut idx = 0;
            while idx < out.len() {
                if remaining.is_empty() {
                    if let Ok(frame) = rx.try_recv() {
                        for s in frame { for _ in 0..output_channels { remaining.push(s); } }
                    } else { out[idx..].fill(0.0); return; }
                }
                let take = remaining.len().min(out.len() - idx);
                out[idx..idx+take].copy_from_slice(&remaining[..take]);
                remaining.drain(..take);
                idx += take;
            }
        }, |_| {}, None).unwrap();
        stream.play().unwrap();
        std::thread::park();
    });

    let mut pcm_out = vec![0.0f32; FRAME_SIZE];
    loop {
        match client.recv_pcm(&mut pcm_out).await {
            Ok(n) => {
                let frame = pcm_out[..n].to_vec();
                let rms = calculate_rms(&frame);
                let _ = ui_tx.try_send(UiMsg::VolumeRemote(rms));
                let _ = tx.try_send(frame);
            }
            Err(_) => break,
        }
    }
    Ok(())
}

fn log_error(_s: &str) {
    // In a real app we'd log to a file
}
