// A bring-your-own-agent endpoint for StreamCore, in one file with no
// dependencies. Run it, point the server's [agent] url at it, and every turn of
// the conversation arrives here.
//
//   node agent.mjs
//   AGENT_API_KEY=secret node agent.mjs
//
// StreamCore does speech in and speech out. This process decides what to say.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9000);
const API_KEY = process.env.AGENT_API_KEY ?? "";

// Two stores, because the server tells us two different things about a caller.
// session_id is one conversation and rotates when it resets, so anything kept
// under it dies with the call. resource_id is the person, stable across calls,
// and only shows up when the deployment identifies people at all.
const conversations = new Map(); // session_id  -> { turns: string[] }
const people = new Map(); // resource_id -> { name?: string, calls: number }

const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  // Sent when [agent] api_key is configured.
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
    res.writeHead(401).end("unauthorized");
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    // Any non-2xx fails the turn and the caller hears nothing.
    res.writeHead(400).end("expected a JSON body");
    return;
  }

  const { session_id: sessionID, resource_id: resourceID, type, text, system } = body;

  // A oneshot is the server asking us to process some text on its behalf (the
  // rolling summary, today), not the caller saying something. Keep it out of
  // conversation memory. The result is never spoken, so buffering is fine.
  if (type === "oneshot") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: summarise(system, text) }));
    return;
  }

  const reply = respond({ sessionID, resourceID, text, system });

  // Streaming lets the server speak sentence one while sentence two is still
  // being written. The buffered alternative:
  //
  //   res.writeHead(200, { "content-type": "application/json" });
  //   res.end(JSON.stringify({ text: reply }));
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // Barge-in. The caller interrupted, the server cancelled the request, and
  // anything generated from here is thrown away.
  let cancelled = false;
  req.on("close", () => {
    cancelled = true;
  });

  for (const chunk of reply.match(/[^ ]+ ?/g) ?? []) {
    if (cancelled) return;
    res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
    await sleep(40); // stand-in for generation time
  }
  if (cancelled) return;
  res.write("data: [DONE]\n\n");
  res.end();
});

/** Decide what to say. Swap in your model, framework, or backend. */
function respond({ sessionID, resourceID, text, system }) {
  const conversation = getOr(conversations, sessionID, () => ({ turns: [] }));
  conversation.turns.push(text);

  // No resource_id means nobody was identified. Guard rather than keying on
  // undefined, which would file every anonymous caller under one person.
  const person = resourceID ? getOr(people, resourceID, () => ({ calls: 0 })) : null;
  if (person && conversation.turns.length === 1) person.calls += 1;

  // Skill text the server appends. Prepend it to your prompt.
  if (system) console.log(`[agent] system prompt: ${system.slice(0, 60)}…`);

  const remembered = text.match(/my name is (\w+)/i);
  if (remembered && person) {
    person.name = remembered[1];
    return `Nice to meet you, ${person.name}. I'll remember that for next time.`;
  }

  // New session_id, same resource_id, and we still know who this is.
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
