package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"sync/atomic"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/gordonklaus/portaudio"
	streamcoreai "github.com/streamcoreai/go-sdk"
)

var isMuted atomic.Bool
var program *tea.Program

type statusMsg streamcoreai.ConnectionStatus
type transcriptMsg struct {
	Role    string
	Text    string
	Partial bool
}
type errMsg struct{ err error }
type rtcConnectedMsg struct{}
type volumeMsg struct {
	level   float64
	isLocal bool
}

// Colors matching the rust-tui
var (
	purple = lipgloss.Color("#7D56F4")
	pink   = lipgloss.Color("#FF76B8")
	green  = lipgloss.Color("#04B575")
)

type model struct {
	status        streamcoreai.ConnectionStatus
	transcripts   []transcriptMsg
	localHistory  []float64
	remoteHistory []float64
	err           error
	client        *streamcoreai.Client
	cancelContext context.CancelFunc
	ctx           context.Context
	width         int
	height        int
	scrollOffset  int
}

func initialModel(ctx context.Context, client *streamcoreai.Client, cancel context.CancelFunc) model {
	return model{
		status:        "connecting",
		localHistory:  make([]float64, 40),
		remoteHistory: make([]float64, 40),
		client:        client,
		cancelContext: cancel,
		ctx:           ctx,
		width:         80,
		height:        24,
	}
}

func (m model) Init() tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Connect(m.ctx); err != nil {
			return errMsg{err}
		}
		go captureMic(m.ctx, m.client)
		go playRemote(m.ctx, m.client)
		return rtcConnectedMsg{}
	}
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q", "esc":
			m.cancelContext()
			return m, tea.Quit
		case " ":
			muted := !isMuted.Load()
			isMuted.Store(muted)
		}
	case rtcConnectedMsg:
		// handled via statusMsg
	case statusMsg:
		m.status = streamcoreai.ConnectionStatus(msg)
	case transcriptMsg:
		if len(m.transcripts) > 0 {
			lastIdx := len(m.transcripts) - 1
			if m.transcripts[lastIdx].Partial && m.transcripts[lastIdx].Role == msg.Role {
				m.transcripts[lastIdx] = msg
				return m, nil
			}
		}
		m.transcripts = append(m.transcripts, msg)
		// Auto-scroll to bottom when new transcript arrives
		m.scrollOffset = len(m.transcripts) // will be clamped in View
	case errMsg:
		m.err = msg.err
	case volumeMsg:
		if msg.isLocal {
			m.localHistory = append(m.localHistory, msg.level)
			if len(m.localHistory) > 40 {
				m.localHistory = m.localHistory[1:]
			}
		} else {
			m.remoteHistory = append(m.remoteHistory, msg.level)
			if len(m.remoteHistory) > 40 {
				m.remoteHistory = m.remoteHistory[1:]
			}
		}
	}

	return m, nil
}

// wrapText wraps text to fit within maxWidth, breaking on word boundaries.
func wrapText(text string, maxWidth int) []string {
	if maxWidth <= 0 || len(text) == 0 {
		return []string{text}
	}
	words := strings.Fields(text)
	if len(words) == 0 {
		return []string{""}
	}
	var lines []string
	currentLine := ""
	for _, word := range words {
		if currentLine == "" {
			if len(word) > maxWidth {
				// Break long words
				for len(word) > 0 {
					take := maxWidth
					if take > len(word) {
						take = len(word)
					}
					lines = append(lines, word[:take])
					word = word[take:]
				}
			} else {
				currentLine = word
			}
		} else if len(currentLine)+1+len(word) > maxWidth {
			lines = append(lines, currentLine)
			currentLine = word
		} else {
			currentLine += " " + word
		}
	}
	if currentLine != "" {
		lines = append(lines, currentLine)
	}
	if len(lines) == 0 {
		lines = []string{""}
	}
	return lines
}

// renderPulseWave renders a symmetric centered pulse matching the rust-tui style
func renderPulseWave(history []float64, color lipgloss.Color) string {
	if len(history) == 0 {
		return lipgloss.NewStyle().Foreground(color).Render("[                                             ]")
	}
	currentVol := history[len(history)-1]
	width := 45
	center := width / 2
	numBars := int(currentVol * float64(center))
	if numBars > center {
		numBars = center
	}

	buf := make([]rune, width)
	for i := range buf {
		buf[i] = ' '
	}

	for i := 0; i < numBars; i++ {
		var ch rune
		switch {
		case i >= numBars-1:
			ch = '░'
		case i >= numBars-2:
			ch = '▒'
		case i >= numBars-3:
			ch = '▓'
		default:
			ch = '█'
		}
		if center+i < width {
			buf[center+i] = ch
		}
		if center-i >= 0 && center-i < width {
			buf[center-i] = ch
		}
	}
	return lipgloss.NewStyle().Foreground(color).Render(fmt.Sprintf("[%s]", string(buf)))
}

// borderedBox draws content inside a rounded border box with a title
func borderedBox(title string, content string, borderColor lipgloss.Color, width, height int) string {
	style := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(borderColor).
		Width(width-2).   // account for border chars
		Height(height-2). // account for border lines
		Padding(0, 1)

	titleStyle := lipgloss.NewStyle().
		Foreground(borderColor).
		Bold(true)

	box := style.Render(content)
	// Replace the top border section with the title
	lines := strings.Split(box, "\n")
	if len(lines) > 0 && len(title) > 0 {
		titleRendered := titleStyle.Render(" " + title + " ")
		topBorder := lines[0]
		// Insert title into the top border line
		if len(topBorder) > 4 {
			runeTop := []rune(topBorder)
			titleRunes := []rune(titleRendered)
			// We'll just replace chars starting at position 2
			insertPos := 2
			if insertPos+len(titleRunes) < len(runeTop) {
				// For ANSI-styled title, we need to splice it in as a string
				lines[0] = string(runeTop[:insertPos]) + titleRendered + string(runeTop[insertPos+len([]rune(title))+2:])
			}
		}
		box = strings.Join(lines, "\n")
	}
	return box
}

func (m model) View() string {
	w := m.width
	h := m.height

	// Layout: 1 margin top, 3 header, 1 gap, 7 signal monitor, 1 gap, remaining transcript, 1 footer, 1 margin bottom
	headerH := 3
	monitorH := 7
	footerH := 1
	margin := 1
	transcriptH := h - headerH - monitorH - footerH - (margin * 2) - 2 // 2 for gaps
	if transcriptH < 3 {
		transcriptH = 3
	}

	innerW := w - (margin * 2)
	if innerW < 20 {
		innerW = 20
	}

	// == Header ==
	titleText := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("#FFFFFF")).
		Background(purple).
		Padding(0, 1).
		Render(" 🎙️  StreamCoreAI Voice Agent ")

	subtitleText := lipgloss.NewStyle().
		Italic(true).
		Foreground(purple).
		Render("  Ratatui Dashboard  ")

	headerContent := titleText + subtitleText
	header := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(purple).
		Width(innerW - 2).
		Align(lipgloss.Center).
		Render(headerContent)

	// == Signal Monitor ==
	statusColor := lipgloss.Color("#FFFF00")
	if m.status == streamcoreai.StatusConnected {
		statusColor = green
	}
	muted := isMuted.Load()
	muteText := "🔴 MUTED"
	muteColor := lipgloss.Color("#FF0000")
	if !muted {
		muteText = "🟢 ACTIVE"
		muteColor = green
	}

	statusPane := fmt.Sprintf("Network: %s\n\nSignal:  %s",
		lipgloss.NewStyle().Foreground(statusColor).Bold(true).Render(string(m.status)),
		lipgloss.NewStyle().Foreground(muteColor).Bold(true).Render(muteText),
	)

	userWave := renderPulseWave(m.localHistory, pink)
	agentWave := renderPulseWave(m.remoteHistory, green)
	wavesPane := fmt.Sprintf("\n        YOU:   %s\n\n        AGENT: %s", userWave, agentWave)

	// Combine status and waves side by side
	statusWidth := 25
	wavesWidth := innerW - statusWidth - 6 // borders + padding
	if wavesWidth < 30 {
		wavesWidth = 30
	}
	statusRendered := lipgloss.NewStyle().Width(statusWidth).Render(statusPane)
	wavesRendered := lipgloss.NewStyle().Width(wavesWidth).Render(wavesPane)
	monitorContent := lipgloss.JoinHorizontal(lipgloss.Top, statusRendered, wavesRendered)

	monitor := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(pink).
		Width(innerW-2).
		Height(monitorH-2).
		Padding(0, 1).
		Render(monitorContent)

	// Inject title into monitor border
	monitorLines := strings.Split(monitor, "\n")
	if len(monitorLines) > 0 {
		monitorTitle := lipgloss.NewStyle().Foreground(pink).Bold(true).Render(" SIGNAL MONITOR ")
		topLine := monitorLines[0]
		runes := []rune(topLine)
		if len(runes) > 4 {
			monitorLines[0] = string(runes[:2]) + monitorTitle + string(runes[2+len([]rune(" SIGNAL MONITOR "))+2:])
		}
		monitor = strings.Join(monitorLines, "\n")
	}

	// == Conversation History (scrollable) ==
	contentHeight := transcriptH - 2 // minus border
	if contentHeight < 1 {
		contentHeight = 1
	}

	labelWidth := 11                        // visual width of " Agent ❯ " + " "
	textMaxWidth := innerW - 6 - labelWidth // borders + padding
	if textMaxWidth < 10 {
		textMaxWidth = 10
	}

	var transcriptLines []string
	for _, t := range m.transcripts {
		var label string
		if t.Role == "assistant" {
			label = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#000000")).
				Background(green).
				Bold(true).
				Render(" Agent ❯ ")
		} else {
			label = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#000000")).
				Background(pink).
				Bold(true).
				Render(" You ❯   ")
		}
		txt := t.Text
		if t.Partial {
			txt += "..."
		}

		wrapped := wrapText(txt, textMaxWidth)
		for i, chunk := range wrapped {
			if i == 0 {
				transcriptLines = append(transcriptLines, label+" "+chunk)
			} else {
				padding := strings.Repeat(" ", labelWidth)
				transcriptLines = append(transcriptLines, padding+chunk)
			}
		}
	}

	// Handle scrolling: show the last `contentHeight` lines, auto-scrolled to bottom
	visibleLines := make([]string, contentHeight)
	startIdx := 0
	if len(transcriptLines) > contentHeight {
		startIdx = len(transcriptLines) - contentHeight
	}
	for i := 0; i < contentHeight; i++ {
		idx := startIdx + i
		if idx < len(transcriptLines) {
			visibleLines[i] = transcriptLines[idx]
		} else {
			visibleLines[i] = ""
		}
	}

	transcriptContent := strings.Join(visibleLines, "\n")
	transcript := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(purple).
		Width(innerW-2).
		Height(contentHeight).
		Padding(0, 1).
		Render(transcriptContent)

	// Inject title into transcript border
	tLines := strings.Split(transcript, "\n")
	if len(tLines) > 0 {
		tTitle := lipgloss.NewStyle().Foreground(purple).Bold(true).Render(" CONVERSATION HISTORY ")
		topLine := tLines[0]
		runes := []rune(topLine)
		if len(runes) > 4 {
			tLines[0] = string(runes[:2]) + tTitle + string(runes[2+len([]rune(" CONVERSATION HISTORY "))+2:])
		}
		transcript = strings.Join(tLines, "\n")
	}

	// == Footer ==
	qKey := lipgloss.NewStyle().Foreground(lipgloss.Color("#000000")).Background(lipgloss.Color("#666666")).Render(" Q ")
	spaceKey := lipgloss.NewStyle().Foreground(lipgloss.Color("#000000")).Background(lipgloss.Color("#666666")).Render(" SPACE ")
	footer := lipgloss.NewStyle().Width(innerW).Align(lipgloss.Center).Render(
		qKey + " Quit   " + spaceKey + " Hold to Talk",
	)

	// == Error overlay ==
	errOverlay := ""
	if m.err != nil {
		errOverlay = "\n" + lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("#FF0000")).
			Foreground(lipgloss.Color("#FF0000")).
			Padding(1, 2).
			Width(innerW/2).
			Align(lipgloss.Center).
			Render(fmt.Sprintf("Error: %v", m.err))
	}

	// == Assemble full view ==
	content := lipgloss.JoinVertical(lipgloss.Left,
		header,
		monitor,
		transcript,
		footer,
		errOverlay,
	)

	// Center the whole thing in the terminal
	return lipgloss.Place(w, h, lipgloss.Center, lipgloss.Center, content)
}

func main() {
	f, _ := os.OpenFile("debug.log", os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o666)
	log.SetOutput(f)

	whipURL := "http://localhost:8080/whip"
	if u := os.Getenv("WHIP_URL"); u != "" {
		whipURL = u
	}
	tokenURL := os.Getenv("TOKEN_URL")
	apiKey := os.Getenv("API_KEY")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	isMuted.Store(true)

	if err := portaudio.Initialize(); err != nil {
		fmt.Printf("portaudio init error: %v\n", err)
		os.Exit(1)
	}
	defer portaudio.Terminate()

	client := streamcoreai.NewClient(
		streamcoreai.Config{
			WHIPEndpoint: whipURL,
			TokenURL:     tokenURL,
			APIKey:       apiKey,
		},
		streamcoreai.EventHandler{
			OnStatusChange: func(status streamcoreai.ConnectionStatus) {
				if program != nil {
					program.Send(statusMsg(status))
				}
				if status == streamcoreai.StatusDisconnected || status == streamcoreai.StatusError {
					cancel()
				}
			},
			OnTranscript: func(entry streamcoreai.TranscriptEntry, all []streamcoreai.TranscriptEntry) {
				if program != nil {
					program.Send(transcriptMsg{
						Role:    entry.Role,
						Text:    entry.Text,
						Partial: entry.Partial,
					})
				}
			},
			OnError: func(err error) {
				if program != nil {
					program.Send(errMsg{err})
				}
			},
		},
	)

	// Use WithAltScreen for fullscreen mode (no terminal scrolling)
	program = tea.NewProgram(initialModel(ctx, client, cancel), tea.WithAltScreen())

	if _, err := program.Run(); err != nil {
		fmt.Printf("TUI Error: %v\n", err)
		os.Exit(1)
	}
}

// calculateRMS processes audio frames into normalized visual floats
func calculateRMS(pcm []int16) float64 {
	var sum float64
	for _, sample := range pcm {
		sum += float64(sample) * float64(sample)
	}
	rms := math.Sqrt(sum / float64(len(pcm)))
	level := rms / 2000.0
	if level > 1.0 {
		level = 1.0
	}
	return level
}

func captureMic(ctx context.Context, client *streamcoreai.Client) {
	pcm := make([]int16, streamcoreai.FrameSize)
	stream, err := portaudio.OpenDefaultStream(
		streamcoreai.Channels, 0,
		float64(streamcoreai.SampleRate),
		streamcoreai.FrameSize, pcm,
	)
	if err != nil {
		return
	}
	defer stream.Close()
	if err := stream.Start(); err != nil {
		return
	}
	defer stream.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		if err := stream.Read(); err != nil {
			time.Sleep(time.Millisecond)
			continue
		}

		if isMuted.Load() {
			for i := range pcm {
				pcm[i] = 0
			}
		}

		if program != nil {
			program.Send(volumeMsg{level: calculateRMS(pcm), isLocal: true})
		}

		if err := client.SendPCM(pcm); err != nil {
			time.Sleep(5 * time.Millisecond)
		}
	}
}

func playRemote(ctx context.Context, client *streamcoreai.Client) {
	pcm := make([]int16, streamcoreai.FrameSize)
	stream, err := portaudio.OpenDefaultStream(
		0, streamcoreai.Channels,
		float64(streamcoreai.SampleRate),
		streamcoreai.FrameSize, pcm,
	)
	if err != nil {
		return
	}
	defer stream.Close()
	if err := stream.Start(); err != nil {
		return
	}
	defer stream.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		nSamples, err := client.RecvPCM(pcm)
		if err != nil {
			return
		}

		for i := nSamples; i < streamcoreai.FrameSize; i++ {
			pcm[i] = 0
		}

		if program != nil {
			program.Send(volumeMsg{level: calculateRMS(pcm), isLocal: false})
		}

		if err := stream.Write(); err != nil {
		}
	}
}
