"""A complete bring-your-own-agent endpoint for StreamCore, using only the
standard library.

    python3 agent.py                      # listens on :9000
    AGENT_API_KEY=secret python3 agent.py

StreamCore does speech in and speech out. This process owns the intelligence:
what to say, what to remember, and who to remember it for.

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

# Two stores, because StreamCore tells us two different things about a caller.
#
# session_id is one conversation. It rotates when the conversation resets, so
# anything keyed here is forgotten at the end of the call — the right home for
# "what were we just talking about".
#
# resource_id is the person, stable across separate calls. It only arrives when
# the deployment asserts an identity (a signed token claim, or a phone number
# from sip-server), so it is the right home for "what do I know about you".
conversations: dict[str, dict] = {}  # session_id  -> {"turns": [...]}
people: dict[str, dict] = {}  # resource_id -> {"name": str, "calls": int}


class AgentHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 (name fixed by BaseHTTPRequestHandler)
        # StreamCore sends [agent] api_key as a bearer token when configured.
        if API_KEY and self.headers.get("Authorization") != f"Bearer {API_KEY}":
            self._text(401, "unauthorized")
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            # A non-2xx fails the turn and the caller hears nothing, which is
            # the right outcome for a request we cannot understand.
            self._text(400, "expected a JSON body")
            return

        session_id = body.get("session_id", "")
        resource_id = body.get("resource_id")  # absent when nobody is identified
        text = body.get("text", "")
        system = body.get("system", "")

        # "oneshot" is a stateless background transform — the rolling summary,
        # today. It must not touch conversation memory: it is StreamCore asking
        # us to process text on its behalf, not the caller saying something. The
        # result is used internally and never spoken, so buffered JSON is fine.
        if body.get("type") == "oneshot":
            self._json(200, {"text": summarise(system, text)})
            return

        reply = respond(session_id, resource_id, text, system)

        # text/event-stream lets StreamCore speak each sentence while the rest
        # is still being generated, which is the difference between a natural
        # reply and a long silence. Swap in the buffered form only if your agent
        # cannot stream:
        #
        #     self._json(200, {"text": reply})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        for chunk in re.findall(r"\S+\s?", reply):
            # Barge-in: when the caller interrupts, StreamCore cancels the
            # request and the socket breaks. Stop generating — the words would
            # be thrown away, and with a real model you are still paying.
            if not self._write_chunk(f"data: {json.dumps({'delta': chunk})}\n\n"):
                return
            time.sleep(0.04)  # real generation is not instant
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
    """Decide what to say. Replace this with your model, framework, or backend."""
    conversation = conversations.setdefault(session_id, {"turns": []})
    conversation["turns"].append(text)

    # Anonymous is a normal state: resource_id is absent when the deployment
    # asserts no identity. Guard rather than keying memory on None, which would
    # pool every anonymous caller into one shared person.
    person = people.setdefault(resource_id, {"calls": 0}) if resource_id else None
    if person and len(conversation["turns"]) == 1:
        person["calls"] += 1

    # `system` carries skill text the server appends. Prepend it to your prompt;
    # here we just acknowledge that it exists.
    if system:
        print(f"[agent] system prompt: {system[:60]}…")

    remembered = re.search(r"my name is (\w+)", text, re.IGNORECASE)
    if remembered and person:
        person["name"] = remembered.group(1)
        return f"Nice to meet you, {person['name']}. I'll remember that for next time."

    # The payoff of resource_id: this is a *different call*, with a different
    # session_id, and the agent still knows who it is talking to.
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
