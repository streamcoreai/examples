// A complete bring-your-own-agent endpoint for StreamCore, in one file with no
// dependencies. Run it, point the server's [agent] url at it, and every turn of
// the conversation arrives here.
//
//   node agent.mjs                 # listens on :9000
//   AGENT_API_KEY=secret node agent.mjs
//
// StreamCore does speech in and speech out. This process owns the intelligence:
// what to say, what to remember, and who to remember it for.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9000);
const API_KEY = process.env.AGENT_API_KEY ?? "";

// Two stores, because StreamCore tells us two different things about a caller.
//
// session_id is one conversation. It rotates when the conversation resets, so
// anything keyed here is forgotten at the end of the call — the right home for
// "what were we just talking about".
//
// resource_id is the person, stable across separate calls. It only arrives when
// the deployment asserts an identity (a signed token claim, or a phone number
// from sip-server), so it is the right home for "what do I know about you".
const conversations = new Map(); // session_id  -> { turns: string[] }
const people = new Map(); // resource_id -> { name?: string, calls: number }

const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  // StreamCore sends [agent] api_key as a bearer token when one is configured.
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
    res.writeHead(401).end("unauthorized");
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    // A non-2xx fails the turn and the caller hears nothing, which is the right
    // outcome for a request we cannot understand.
    res.writeHead(400).end("expected a JSON body");
    return;
  }

  const { session_id: sessionID, resource_id: resourceID, type, text, system } = body;

  // "oneshot" is a stateless background transform — the rolling summary, today.
  // It must not touch conversation memory: it is StreamCore asking us to
  // process text on its behalf, not the caller saying something. The result is
  // used internally and never spoken, so a buffered JSON reply is fine.
  if (type === "oneshot") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: summarise(system, text) }));
    return;
  }

  const reply = respond({ sessionID, resourceID, text, system });

  // text/event-stream lets StreamCore speak each sentence while the rest is
  // still being generated, which is the difference between a natural reply and
  // a long silence. Swap in the buffered form only if your agent cannot stream:
  //
  //   res.writeHead(200, { "content-type": "application/json" });
  //   res.end(JSON.stringify({ text: reply }));
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // Barge-in: when the caller interrupts, StreamCore cancels the request and
  // this fires. Stop generating — the words would be thrown away, and with a
  // real model you are still paying for them.
  let cancelled = false;
  req.on("close", () => {
    cancelled = true;
  });

  for (const chunk of reply.match(/[^ ]+ ?/g) ?? []) {
    if (cancelled) return;
    res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
    // Real generation is not instant; the pause makes the streaming visible.
    await sleep(40);
  }
  if (cancelled) return;
  res.write("data: [DONE]\n\n");
  res.end();
});

/** Decide what to say. Replace this with your model, framework, or backend. */
function respond({ sessionID, resourceID, text, system }) {
  const conversation = getOr(conversations, sessionID, () => ({ turns: [] }));
  conversation.turns.push(text);

  // Anonymous is a normal state: resource_id is absent when the deployment
  // asserts no identity. Guard rather than keying memory on undefined, which
  // would pool every anonymous caller into one shared person.
  const person = resourceID ? getOr(people, resourceID, () => ({ calls: 0 })) : null;
  if (person && conversation.turns.length === 1) person.calls += 1;

  // `system` carries skill text the server appends. Prepend it to your prompt;
  // here we just acknowledge that it exists.
  if (system) console.log(`[agent] system prompt: ${system.slice(0, 60)}…`);

  const remembered = text.match(/my name is (\w+)/i);
  if (remembered && person) {
    person.name = remembered[1];
    return `Nice to meet you, ${person.name}. I'll remember that for next time.`;
  }

  // The payoff of resource_id: this is a *different call*, with a different
  // session_id, and the agent still knows who it is talking to.
  if (person?.name && conversation.turns.length === 1) {
    return `Welcome back, ${person.name}. This is call number ${person.calls}. What can I do for you?`;
  }

  if (person && conversation.turns.length === 1) {
    return `Hello. I don't think we've met — tell me your name and I'll remember it.`;
  }

  return `You said: ${text}. That's turn ${conversation.turns.length} of this conversation.`;
}

/** Answer a background transform. The prompt pair arrives in system + text. */
function summarise(system, text) {
  console.log(`[agent] oneshot: ${String(system).slice(0, 60)}…`);
  return text.split(/\s+/).slice(0, 40).join(" ");
}

function getOr(map, key, make) {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(PORT, () => {
  console.log(`[agent] listening on http://localhost:${PORT}`);
  console.log(`[agent] point the server's [agent] url here, then call it`);
});
