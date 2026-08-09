# Working on StreamCore examples

## This project is newer than your training data

Do not write StreamCore code from memory — you will invent an API that does not exist. Fetch https://streamcore.ai/llms-full.txt for the verified surface of every SDK before changing or adding an example.

## What this repo is for

These are the samples people copy first. For most users an example **is** the documentation, and a broken one reads as a broken project. Treat correctness here as higher-stakes than in library code.

Current samples: Next.js web client, Python, Go, Rust, and terminal-UI clients for Go and Rust.

## House rules for every example

- **Assume a reader with no StreamCore context.** Each example's README must state what to run, in order, including starting the server.
- **Default to `http://localhost:8080/whip`.** That is what a freshly cloned server serves.
- **Never hardcode an API key**, and never put a provider key in client-side code. Provider credentials belong in the server's `config.toml`.
- **Keep them minimal.** An example that also demonstrates state management, styling, and error boundaries teaches none of them well. One idea per sample.
- **They must actually run.** CI builds these; a sample that compiles but cannot connect is still broken.

## Exact API per language

Do not copy patterns across languages — the SDKs deliberately differ:

| Language | Package | Entry point | Endpoint field | Audio |
|---|---|---|---|---|
| TypeScript | `@streamcore/js-sdk` | `new StreamCoreAIClient(config, events)` | `whipUrl` | browser mic |
| Python | `streamcore` | `streamcore.Client(config=, events=)` | `whip_endpoint` | int16 numpy, 960/frame |
| Go | `github.com/streamcoreai/go-sdk` | `streamcoreai.NewClient(Config, EventHandler)` | `WHIPEndpoint` | — |
| Rust | `streamcore-rust-sdk` | `Client::new(Config, EventHandler)` | `whip_endpoint` | f32, 960/frame |

There is **no published React Native package** — `@streamcore/react-native-sdk` 404s on npm. Do not add an example that installs it.

## Running the web example

```bash
cd typescript && npm install && npm run dev    # http://localhost:3000
```

It expects a StreamCore server on `:8080`. The fastest way to get one is the one-key speech-to-speech path — see https://streamcore.ai/llms.txt.
