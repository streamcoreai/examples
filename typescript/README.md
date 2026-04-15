# TypeScript Voice Agent Example

A Next.js web app that connects to a Voice Agent server using the [TypeScript SDK](../../typescript-sdk/). Provides a browser-based UI with a mic button, real-time audio visualization, and live transcripts.

## Prerequisites

- **Node.js 20+**
- A running Voice Agent server (see [server/](../../server/))

## Running

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

By default the app connects to `http://localhost:8080/whip`. To change the endpoint, set the `NEXT_PUBLIC_WHIP_URL` environment variable:

```bash
NEXT_PUBLIC_WHIP_URL=http://your-server:8080/whip npm run dev
```

## Docker

```bash
docker build -t streamcoreai-example-ts .
docker run -p 3000:3000 streamcoreai-example-ts
```

Pass a custom WHIP URL at build time:

```bash
docker build --build-arg NEXT_PUBLIC_WHIP_URL=http://your-server:8080/whip -t streamcoreai-example-ts .
```

## What It Does

1. Opens a browser UI with a microphone button and audio visualizer.
2. Captures microphone audio via WebRTC and streams it to the Voice Agent server.
3. Plays back the agent's audio response in real time.
4. Displays live transcripts (user and agent) as they arrive over the data channel.

## Configuration

| Environment Variable       | Default                          | Description                                                                 |
| -------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `NEXT_PUBLIC_WHIP_URL`     | `http://localhost:8080/whip`     | WHIP signaling endpoint                                                     |
| `NEXT_PUBLIC_TOKEN_URL`    |                                  | Token endpoint URL (e.g. `http://localhost:8080/token`). Required when the server has JWT auth enabled. |
| `NEXT_PUBLIC_API_KEY`      |                                  | API key sent as `Bearer` header when fetching a token from the token URL.   |

### JWT Authentication

When the server has `jwt_secret` set, all `/whip` requests require a valid JWT. Add the following to your `.env.local`:

```env
NEXT_PUBLIC_WHIP_URL=http://localhost:8080/whip
NEXT_PUBLIC_TOKEN_URL=http://localhost:8080/token
NEXT_PUBLIC_API_KEY=sk-streamcore-demo-key
```
