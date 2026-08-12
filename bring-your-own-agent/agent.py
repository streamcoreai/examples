"""A bring-your-own-agent endpoint for StreamCore, standard library only.

    python3 agent.py
    AGENT_API_KEY=secret python3 agent.py

StreamCore does speech in and speech out. This process decides what to say.
The Node version in this folder is the same contract, line for line.
"""

from __future__ import annotations

import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "9000"))
API_KEY = os.environ.get("AGENT_API_KEY", "")

# Two stores, because the server tells us two different things about a caller.
# session_id is one conversation and rotates when it resets, so anything kept
# under it dies with the call. resource_id is the person, stable across calls,
# and only shows up when the deployment identifies people at all.
conversations: dict[str, dict] = {}  # session_id  -> {"turns": [...]}
people: dict[str, dict] = {}  # resource_id -> {"name": str, "calls": int}


class AgentHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 (name fixed by BaseHTTPRequestHandler)
        # Sent when [agent] api_key is configured.
        if API_KEY and self.headers.get("Authorization") != f"Bearer {API_KEY}":
            self._text(401, "unauthorized")
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            # Any non-2xx fails the turn and the caller hears nothing.
            self._text(400, "expected a JSON body")
            return

        session_id = body.get("session_id", "")
        resource_id = body.get("resource_id")  # absent when nobody is identified
        text = body.get("text", "")
        system = body.get("system", "")

        # A oneshot is the server asking us to process some text on its behalf
        # (the rolling summary, today), not the caller saying something. Keep it
        # out of conversation memory. The result is never spoken.
        if body.get("type") == "oneshot":
            self._json(200, {"text": summarise(system, text)})
            return

        reply = respond(session_id, resource_id, text, system)

        # Streaming lets the server speak sentence one while sentence two is
        # still being written. The buffered alternative is self._json(200, ...).
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        for chunk in re.findall(r"\S+\s?", reply):
            # A dead socket is barge-in: the caller interrupted and the server
            # cancelled, so anything generated from here is thrown away.
            if not self._write_chunk(f"data: {json.dumps({'delta': chunk})}\n\n"):
                return
            time.sleep(0.04)  # stand-in for generation time
        if self._write_chunk("data: [DONE]\n\n"):
            self._write_chunk("")  # terminating zero-length chunk

    def log_message(self, fmt: str, *args) -> None:
        print(f"[agent] {fmt % args}")

    # -- transport helpers -------------------------------------------------

    def _write_chunk(self, payload: str) -> bool:
        """Write one HTTP chunk. False once the caller has hung up."""
        try:
            raw = payload.encode()
            self.wfile.write(f"{len(raw):X}\r\n".encode() + raw + b"\r\n")
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            return False

    def _json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _text(self, status: int, message: str) -> None:
        raw = message.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def respond(session_id: str, resource_id: str | None, text: str, system: str) -> str:
    """Decide what to say. Swap in your model, framework, or backend."""
    conversation = conversations.setdefault(session_id, {"turns": []})
    conversation["turns"].append(text)

    # No resource_id means nobody was identified. Guard rather than keying on
    # None, which would file every anonymous caller under one person.
    person = people.setdefault(resource_id, {"calls": 0}) if resource_id else None
    if person and len(conversation["turns"]) == 1:
        person["calls"] += 1

    # Skill text the server appends. Prepend it to your prompt.
    if system:
        print(f"[agent] system prompt: {system[:60]}…")

    remembered = re.search(r"my name is (\w+)", text, re.IGNORECASE)
    if remembered and person:
        person["name"] = remembered.group(1)
        return f"Nice to meet you, {person['name']}. I'll remember that for next time."

    # New session_id, same resource_id, and we still know who this is.
    if person and person.get("name") and len(conversation["turns"]) == 1:
        return (
            f"Welcome back, {person['name']}. This is call number "
            f"{person['calls']}. What can I do for you?"
        )

    if person and len(conversation["turns"]) == 1:
        return "Hello. I don't think we've met — tell me your name and I'll remember it."

    return f"You said: {text}. That's turn {len(conversation['turns'])} of this conversation."


def summarise(system: str, text: str) -> str:
    """Answer a background transform. The prompt pair arrives in system + text."""
    print(f"[agent] oneshot: {str(system)[:60]}…")
    return " ".join(text.split()[:40])


if __name__ == "__main__":
    print(f"[agent] listening on http://localhost:{PORT}")
    print("[agent] point the server's [agent] url here, then call it")
    ThreadingHTTPServer(("", PORT), AgentHandler).serve_forever()
