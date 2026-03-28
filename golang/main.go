package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync/atomic"
	"time"

	"github.com/eiannone/keyboard"
	"github.com/gordonklaus/portaudio"
	streamcoreai "github.com/streamcoreai/voice-agent-sdk-go"
)

var isMuted atomic.Bool

func main() {
	whipURL := "http://localhost:8080/whip"
	if u := os.Getenv("WHIP_URL"); u != "" {
		whipURL = u
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	client := streamcoreai.NewClient(
		streamcoreai.Config{
			WHIPEndpoint: whipURL,
		},
		streamcoreai.EventHandler{
			OnStatusChange: func(status streamcoreai.ConnectionStatus) {
				fmt.Printf("[status] %s\n", status)
				if status == streamcoreai.StatusDisconnected || status == streamcoreai.StatusError {
					cancel()
				}
			},
			OnTranscript: func(entry streamcoreai.TranscriptEntry, all []streamcoreai.TranscriptEntry) {
				tag := "user"
				if entry.Role == "assistant" {
					tag = "agent"
				}
				if entry.Partial {
					fmt.Printf("\r[%s] (partial) %s", tag, entry.Text)
				} else {
					fmt.Printf("\r[%s] %s\n", tag, entry.Text)
				}
			},
			OnError: func(err error) {
				log.Printf("[error] %v", err)
			},
		},
	)

	log.Printf("Connecting to %s ...", whipURL)
	if err := client.Connect(ctx); err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer client.Disconnect()

	// Initialise PortAudio once; both goroutines share the same PA session.
	if err := portaudio.Initialize(); err != nil {
		log.Fatalf("portaudio: initialize: %v", err)
	}
	defer portaudio.Terminate()

	// Set up keyboard input globally for spacebar toggles
	isMuted.Store(true)
	if err := keyboard.Open(); err != nil {
		log.Printf("[keyboard] failed to open raw terminal: %v", err)
	} else {
		defer keyboard.Close()
		go func() {
			for {
				_, key, err := keyboard.GetKey()
				if err != nil {
					break
				}
				if key == keyboard.KeySpace {
					muted := !isMuted.Load()
					isMuted.Store(muted)
					if muted {
						fmt.Print("\n[mic] 🔴 Muted. Press Space to talk...")
					} else {
						fmt.Print("\n[mic] 🟢 Unmuted. Agent is listening...")
					}
				} else if key == keyboard.KeyCtrlC {
					cancel()
					break
				}
			}
		}()
	}

	fmt.Println("\nConnected! Microphone is 🔴 MUTED. Press Spacebar to talk. (Ctrl+C to quit)")

	// ── Goroutine 1: microphone → SDK encodes Opus → RTP → server ───────────
	go captureMic(ctx, client)

	// ── Goroutine 2: server → SDK decodes Opus → PCM → speaker ─────────────
	go playRemote(ctx, client)

	<-ctx.Done()
	fmt.Println("\nShutting down...")
}

// captureMic reads 20 ms PCM frames from the default input device and
// sends them to the voice agent via the SDK.
func captureMic(ctx context.Context, client *streamcoreai.Client) {
	pcm := make([]int16, streamcoreai.FrameSize)
	stream, err := portaudio.OpenDefaultStream(
		streamcoreai.Channels, 0,
		float64(streamcoreai.SampleRate),
		streamcoreai.FrameSize, pcm,
	)
	if err != nil {
		log.Printf("[mic] open input stream: %v", err)
		return
	}
	defer stream.Close()
	if err := stream.Start(); err != nil {
		log.Printf("[mic] start input stream: %v", err)
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
			log.Printf("[mic] read: %v", err)
			time.Sleep(time.Millisecond)
			continue
		}

		if isMuted.Load() {
			for i := range pcm {
				pcm[i] = 0
			}
		}

		if err := client.SendPCM(pcm); err != nil {
			time.Sleep(5 * time.Millisecond)
		}
	}
}

// playRemote receives decoded PCM audio from the agent via the SDK and
// plays it through the default output device.
func playRemote(ctx context.Context, client *streamcoreai.Client) {
	pcm := make([]int16, streamcoreai.FrameSize)
	stream, err := portaudio.OpenDefaultStream(
		0, streamcoreai.Channels,
		float64(streamcoreai.SampleRate),
		streamcoreai.FrameSize, pcm,
	)
	if err != nil {
		log.Printf("[speaker] open output stream: %v", err)
		return
	}
	defer stream.Close()
	if err := stream.Start(); err != nil {
		log.Printf("[speaker] start output stream: %v", err)
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

		if err := stream.Write(); err != nil {
			log.Printf("[speaker] write: %v", err)
		}
	}
}
