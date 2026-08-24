# Voice Bot

A voice agent with a face. A Babylon.js robot connects to a StreamCore server over WebRTC with
[`@streamcore/js-sdk`](https://www.npmjs.com/package/@streamcore/js-sdk), then reacts to both halves of
the conversation — its eyes follow you, its mouth moves to the agent's voice, and it visibly waits,
thinks and answers. Ask it to come closer or turn around and it walks, driven by the same server-side
tools that steer the ESP32 car.

![The bot, mid-conversation](docs/preview.webp)

Unlike the other client samples, this one is not minimal. It exists to answer a specific question:
what does a StreamCore session look like when the interface is a character instead of a waveform.

## Run it

You need a StreamCore server on `:8080`. See <https://streamcore.ai/llms.txt> for the fastest way to
get one.

```bash
npm install
cp .env.local.example .env.local
npm run dev            # https://localhost:3000
```

`next dev` runs with `--experimental-https` because `getUserMedia` needs a secure context. Accept the
self-signed certificate the first time.

If no server is listening, the connect button stays cancellable and, after nine seconds, says which
URL it is waiting on. A dial you cannot call off is the worst way to find out the server is down.

If your server's `config.toml` sets a `jwt_secret`, it will reject unauthenticated connections — fill
in `NEXT_PUBLIC_TOKEN_URL` (and `NEXT_PUBLIC_API_KEY`) as `.env.local.example` describes. Connection
failures say which of these is wrong rather than reporting `TypeError: Failed to fetch`.

The prepared model (`public/models/bot.glb`, 5.2 MB) is committed, so this works from a clean clone.
If you have the 82 MB authoring export at `models/bot.glb` and want to rebuild it:

```bash
npm run prepare:model              # defaults: 10% of triangles, 2K textures
npm run prepare:model -- --ratio 0.25 --texture 4096
```

## Giving a rigless model a face

The source model is a single 1.5-million-triangle mesh with **no skeleton, no blend shapes and no
animations**, and its face is painted directly into a 4K base colour texture. There is nothing to
pose. So the face is not animated — it is *drawn*, every frame, and projected onto the visor.

**At build time** (`scripts/prepare-model.mjs`):

- Every triangle inside the measured visor box is rasterised into UV space, and those texels are
  flattened back to the colour of the glass. That deletes the painted-on eyes and smile.
- The cyan left in the texture — ear rings, chest badge — becomes an emissive mask, so those parts
  can be driven by the agent's voice at runtime instead of being flat paint.

**At runtime** (`lib/bot/faceMaterial.ts`):

- The body mesh is cloned. Babylon shares geometry between clones, so this costs a draw call rather
  than a second copy of 150k triangles.
- The clone's shader decides what is visor by sampling the *base colour texture itself*: near-black
  is glass, near-white is the bezel around it. Because the mask comes from the texture, it follows
  the curve of the glass exactly and cannot drift out of alignment with the geometry.
- The face canvas is composited with premultiplied alpha, so the visor keeps its own specular
  highlight everywhere the face isn't drawing. Replacing the whole screen with a flat rectangle is
  what makes this sort of thing look like a sticker.

Only the box needs measuring, and it lives in `lib/bot/visor.json` as fractions of the model's
bounding box — shared by the build script and the runtime, and still correct if the model is
re-exported at a different scale.

## What the face is made of

`lib/bot/expression.ts` holds sixteen numbers — eye openness and curvature, brow raise and angle,
mouth open/width/curve, gaze, glow, tint — and damps each toward a target at its own rate. Every
expression is a partial override of the resting set.

| Session state | Face |
|---|---|
| Idle / disconnected | `offline` — eyes shut, glow down to a trickle |
| Connecting | `boot` — squinting, dim |
| Connected + `listening` | `listening` — wide eyes, brows up, small ready smile |
| Connected + `thinking` | `thinking` — violet, gaze off to one side, mouth becomes three pulsing dots |
| Connected + `speaking` | `speaking` — mouth driven by the agent's audio |
| Muted | `muted` — eyes averted, mouth clamped |
| Error | `error` — amber, brows angled in, frown |

On top of that sit the involuntary details: blinks on a random interval with the occasional double
blink, saccades between them, a breathing pulse on the glow, eyes narrowing on loud syllables. The
bot also turns a fraction of the way toward your pointer, and clicking it makes it smile.

The mouth is driven by an RMS envelope of the agent's audio, normalised against a decaying ceiling
so a quiet TTS voice moves it as much as a loud one, with a fast attack and slow release. A width
target re-rolled a few times a second keeps it from pumping like a metronome.

## Standing still convincingly

The runtime rig below drives the limbs, but only while the bot is walking; standing still it cannot
turn its head without turning its feet. Every idle movement is whole-body, which rules out big
gestures and makes regularity fatal — a single sine wave reads as machinery inside two cycles.
`lib/bot/idleMotion.ts` layers three things that never line up with each other:

- **Breathing** on its own slow clock, about eleven a minute, with the depth drifting so no two
  breaths are quite the same size.
- **Continuous noise** — a low-frequency wander on every axis at once, each with its own frequency and
  seed so they never come back into phase.
- **Gestures**, fired on a random schedule and allowed to overlap: weight shifts that sway onto one
  foot and hold there, glances the eyes lead by a good margin, head tilts, nods that decay rather than
  hold, and small settles.

Rotations pivot between the feet, because that is where the model's origin sits — which is what a
standing body does when it shifts its weight.

Attention goes stale on purpose. A pointer that has not moved for a couple of seconds stops being
something the bot is being asked to look at, so it goes back to looking around the room on its own.
While the agent is speaking the gesture rate roughly doubles and shifts toward nods, and loud
syllables get a little extra emphasis.

Measured over forty seconds: yaw stays inside roughly ±8°, pitch and roll under 2°, and the body
drifts about a centimetre — enough that it never looks frozen, not enough to look like it is sliding.

## The room

The bot stands in a Gaussian splat scan of an office (`hightech-office.spz`, 768k splats, 12 MB).
Toggle it from the header; the studio stage is still there behind it.

Two things about the format are worth knowing, because they decided how this is wired:

- **The loader mirrors the scan by default.** With `flipY` left off, it applies `scaling.y *= -1` to
  the splat mesh, because splats trained the usual way come out Y-down. This one is neither Y-down
  nor Y-up — it is **Z-up** — so that flip is not a correction but a reflection across the length of
  the corridor. Passing `flipY: true`, which means "leave the data alone", is what makes any of the
  placement below work.
- **The file is SPZ v3 wrapped in gzip, so Babylon's built-in parser reads it.** The loader otherwise
  defaults to fetching a WASM module from unpkg, and SPZ **v4+ (raw NGSP)** files *require* it — the
  native fallback rejects them outright. This one does not, so `spzLibraryUrl` is explicitly set to
  `undefined` and nothing here depends on a CDN at runtime. Check the first bytes before swapping a
  scan in: `1f8b` is the gzip this reads, `4e475350` is NGSP and needs the WASM path.
- **The `.ply` a scanning app exports next to the splats is usually the collider mesh, not splats.**
  The one in `models/` is an Open3D triangle mesh — 202k vertices, 400k faces, vertex colours, no
  splat attributes. It is useful for picking, physics or camera collision, none of which this example
  does, so nothing loads it — the floor plane and the walkable area below are both measured off the
  splats directly.

Placement is measured off the point cloud rather than eyeballed. This is the routine to repeat for
any scan you drop in, and the first step is not a formality — skipping it is what once had the bot
standing on a wall.

1. **Work out which way is up.** Project the cloud along each axis in turn and look at the three
   images: only one of them is a floor plan. Here that is the projection along Z, so the scan is
   Z-up, with the floor a slab at z ≈ -1.55 and the ceiling another at z ≈ +2.6.
2. **Level it.** A least-squares fit over the 116k splats in that slab, interior only so the walls
   stay out of it, puts the floor 2.8° off level — normal for a handheld scan, and glaring once a
   perfectly vertical bot stands on it. The scan is rotated to bring that normal onto +Y. Fitted
   rather than RANSAC'd: RANSAC on this cloud returned a normal with a roll component that is not in
   the floor, and "correcting" that tilted the room the other way.
3. **Then decide how big the bot is in it.** Not the same question as what the scan measures. This
   one is at roughly twice metric scale and `ROOM.scale` is 1.25, which leaves the bot small enough
   in the corridor to read as a robot standing in an office rather than one looming over it. A scan
   that comes out metric is not automatically done: at scale 1 the bot is whatever height its model
   says, and since it is the only object in frame whose size the eye already knows, everything else
   gets measured against it — a real room can end up reading as a cupboard.
4. **Turn it.** The room is 17.3 units along its length and about 7 across. Left unrotated, the
   camera's pullback sits outside a side wall, so the scan gets a quarter turn and the camera looks
   down the length of the office instead.
5. **Find real floor to stand on.** The bounding box centre — the obvious place to put the bot — is
   *inside the desk row*. So everything 0.25–2.2 units above the fitted floor is binned into 25 cm
   cells as obstruction, and the free cells scored on clear radius and how far the open floor runs
   each way. The winner has 1.25 units of clear radius, 5.5 units of open corridor on the side the
   camera pulls back into, and 9 behind the bot for a backdrop with some depth.

The constants that come out of this live in `lib/bot/config.ts`, next to the measurements that
produced them.

One thing does not fall out of the measurements at all: where to put the camera, and whether it
should move. It does not. It stands 5.2 m down the corridor, 2 m up, and stays there — the bot walks
around inside the frame rather than the frame going with it. A camera that follows makes the room
slide past a bot pinned to the middle of the screen, and one mounted behind its shoulders makes the
whole thing read as something you are steering. Neither is a robot standing in an office.

Standing still is what makes the two numbers above matter. **5.2 m** is nearly as far back as the
room allows: the open corridor on the camera's side runs 6.9, but the last of it is the near desk
row, and splats a metre from the lens are white smears across the bottom of the frame rather than
furniture. **2 m up** is a head above standing height, which is what drops that desk row out of the
bottom of the frame; at eye level it sits dead ahead and the shot looks straight through it. From
here the whole plaza the bot walks around in is in shot, so the walk bounds can come from the floor
rather than the framing.

The drag is fenced in for the same reason the shot was chosen that way. `minBeta`/`maxBeta` allow
2.8 m of camera height down to 1.45 m and no further: the previous limits ran past π/2, and past π/2
the camera is *below* what it is aiming at — on the floor, looking up the aisle through the near
desks, which is the one framing in this room with nothing going for it. Sideways is capped at 0.28
radians, about 1.4 m of swing, because from 5 m back an angle covers a lot of ground and the room is
5 across.

`CAMERA.bounds` backs that up, and is what is left of the old chase-camera insurance: a box the
camera has to stay inside, since splats give a raycast nothing to hit. Only a drag can reach it now,
and it pulls the shot in rather than through. Still the first thing to check if you swap in a
tighter scan.

Splats carry their own baked lighting and take no part in the scene's, so switching the room on also
moves the light rig — key light down from 2.6 to 1.15, exposure from 1.15 to 0.95, and the void
dressing (gradient backdrop, floor light pool) off, since it only exists to give the bot somewhere to
be. The hemispheric fill's ground colour moves with it too, since bounce takes the colour of the
floor it came off — cool grey for this blue-lit office, and worth changing if you swap in a warm
scan, or the bot reads as composited in rather than standing there. The contact shadow stays either
way: a bot floating a centimetre above a real floor is obvious.

**On performance, an honest caveat.** 768k splats is a lot, and the only GPU available while building
this was a software rasteriser, so the frame rate here has never been measured on real hardware. The
scene is defensive about it: the room does not load at all on low-tier hardware, and if the frame rate
stays under 40 once post-processing has already been cut back, the scene drops the room by itself and
tells the UI it did. Check it on your target device before assuming it is free.

## Telling it to move

Ask the bot to come closer, back up, turn left, stop, or do a little dance, and it does. None of that
is parsed in the browser — the server already ships the vocabulary, and this example is the second
client to speak it.

The server registers eleven native `movement.*` tools (`server/internal/tools/movement.go`) and offers them to
the model in both the classic STT→LLM→TTS path and the realtime speech-to-speech one. When the model
calls one, the server does not execute anything: it intercepts the call, base64-wraps a small JSON
body, and pushes it down the same `events` data channel the transcripts use.

```json
{"type":"data","topic":"movement.command","payload":"eyJhY3Rpb24iOiJ0dXJuX2xlZnQiLCJkdXJhdGlvbl9tcyI6ODAwfQ=="}
```

```json
{"action":"turn_left","duration_ms":800,"speed_percent":80}
```

It is fire-and-forget. Nothing is waiting on the client, and the model has already been handed a
spoken acknowledgement (*"Turning left."*) before the packet is on the wire. That is why there is no
result to send back and no call id to correlate — the same reason the ESP32 firmware in
[`examples/esp32-desktop-car`](../esp32-desktop-car) can drop a command into a bounded queue and
return immediately.

So the two clients are the same client, as far as the server is concerned. `lib/bot/movementCommand.ts`
decodes exactly the payload the firmware's `parse_movement_command` decodes, repeating its defaults table
rather than assuming one, because the server omits `duration_ms` and `speed_percent` entirely when
the model did not name them. A browser tab and a two-wheel robot answer the same sentence the same
way; one of them turns a mesh, the other turns a motor.

The translation to a walking body is the only part that differs. The car varies wheel duty cycle,
whereas this bot always walks at one comfortable pace, so `speed_percent` is folded into *how far* it
goes rather than how fast — over a fixed duration the two come to the same distance, which is what
the model was reasoning about when it picked the number. The four `pivot_*` actions become curved
walks, with a curvature in radians per metre, so they read as an arc instead of a spin.

**"Keep walking until I say stop"** needs `continuous: true`, because every other move is a fixed
duration and the longest one is ten seconds. Without it the model answers an open-ended request with
a single step and then narrates itself as still going, which the screen flatly contradicts.
Continuous asks for more floor than the room has and lets the walk bounds trim it, so the bot walks
to the far end and halts — or stops early when `movement.stop` arrives. The flag is `omitempty` on the
wire, so firmware that has never heard of it reads the duration exactly as before.

One wording trap, since the server cannot see which client is connected: the `movement.*` descriptions,
the spoken acknowledgements and the driver skill all used to say "drive". A walking character then
narrates itself as driving, which a user notices immediately. All three are device-neutral now, and
the skill tells the model to mirror whatever verb the user used.

`lib/bot/locomotion.ts` runs it, and `lib/bot/rig.ts` moves the legs — see below, because the model
arrives without a skeleton. On top of the limbs the whole body carries a bob on every step, a lean
that comes from acceleration rather than speed (upright at a steady walk, tipped forward pulling
away, tipped back braking), and a roll on half the bob's frequency so weight reads as transferring
foot to foot. Idle fidgeting drops to a quarter while the bot is walking; left at full strength it
turns a walk into a stagger.

The walk cycle advances with **distance travelled, not with time**, so the legs keep pace with the
ground instead of with the clock — at half speed the bot takes the same strides, more slowly.
Turning on the spot covers no ground but the feet still move, so it feeds the same cycle at a
reduced rate; without that the bot pirouettes with its feet welded together.

Three details that are easy to get wrong:

- **Steps queue, they do not replace.** One sentence often carries two ("go forward and turn left"),
  and running them in order is the only reading that matches what was asked. `stop` is the exception:
  it clears the queue and brakes.
- **The floor decals have to travel with the bot**, or it slides off its own shadow. The contact
  shadow and the glow ring hang off a `ground` node that tracks it; the floor light pool does not,
  since that is stage lighting for the void rather than something the bot carries around.
- **The walkable floor is not a box.** Around the standing spot the desk rows open into a plaza 5.3
  across; beyond it, both ways, the floor pinches to an aisle about 1.5 wide that runs most of the
  length of the room. `WALK` describes that shape — a wide span near the origin tapering to a narrow
  one past it — rather than the largest rectangle that fits inside both, which is the aisle's width
  and leaves the plaza unused.
- **Measure the span, not a ray.** The clearance numbers that picked the standing spot came from
  tracing how far the open floor runs along the centre line. That ray threads neatly between the
  desks and reports the aisle as being as wide as the plaza. Taking the *widest clear span at each
  step* instead is what shows the pinch. Getting this wrong either walks the bot through furniture
  or, as it did here, fences it into a fraction of the room.
- **Watch the units.** The occupancy grid is in scan units and `WALK` is in world units, so
  everything measured off the grid has to be multiplied by `ROOM.scale` on the way in. A half-width
  that quietly skipped that step is how the bot ended up with barely half the aisle it had.
- **The bounds also have to be read against the size of one command.** A default `movement.forward` is
  1500 ms at 80%, which is 0.74 m. An earlier version capped the bot at 0.9 m toward the camera, so
  it hit the wall on its second step and every "come closer" after that moved it exactly nothing.
  Penned in that tightly it does not read as bounded, it reads as broken.
- **The camera does not help.** It stands still, so every one of these bounds is also how far the
  bot may get from the middle of the shot, and how much smaller it is allowed to become. The room
  makes that affordable: from 5.2 m back the plaza is comfortably inside the frame, so the bounds
  can still come from the floor rather than the framing. It is worth re-checking against the shot if
  you widen them.

Distances come out where the arithmetic says they should — `movement.forward` at the model's default
1500 ms and 80% travels 0.75 m, `movement.turn_left` at 800 ms turns 70°, and walking into the desks
clamps instead of clipping. There is a console hook in dev, so none of this needs a server to try:

```js
__voiceBot.scene.drive({ action: "forward", durationMs: 1500, speedPercent: 80 })
__voiceBot.scene.drive({ action: "fancy", durationMs: 3000, speedPercent: 80 })
__voiceBot.scene.recentre()
__voiceBot.drive.current.forward = 1     // and 0 to let go again
```

## Driving it yourself

The same feet take **WASD** — or the arrow keys, or the pad in the bottom-left corner on a
touchscreen. W and S walk, A and D turn on the spot, shift runs, R walks the bot back to where it
started. Turning rather than strafing, because turning is what the bot can do: the keys reach
exactly the vocabulary the `movement.*` tools do, no more.

A held key is a state, not a command, so it does not join the queue — it empties it. Whoever is at
the keyboard has just contradicted whatever the model asked for, and two of them steering the same
feet reads as a fault rather than as a negotiation. `Locomotion.setDrive` is called every frame for
that reason instead of on the keypress: a command that arrived *during* a drive would otherwise sit
in the queue and play out when the key came up, from a position and a heading it was never computed
for.

The furniture is the other difference. A commanded step is trimmed to the available floor before it
starts, so it can never reach a desk. A key can be held into one for as long as you like, and
clamping the position alone leaves the bot walking on the spot against it — so held driving looks
`WALK.clearance` ahead and stops instead.

Two small things that would otherwise bite:

- **Babylon's `ArcRotateCamera` claims the arrow keys by default**, so the camera and the bot both
  answered them. That input is removed in `stage.ts`.
- **The pressed keys are React state; the drive itself is a ref.** The state is only there to light
  the buttons up, and it changes on a keypress rather than sixty times a second. The scene reads the
  ref in the render loop, the same way it reads the audio levels — see below.

**The camera does not go with them.** It does not move at all: it stands in the room, aimed at the
standing spot, and the bot walks around inside the frame. Walk it away and you are looking at its
back from across the office; bring it round and you get the face. Mounting the camera behind the
shoulders instead — the third-person shot every game uses — makes it read as something you are
*steering* rather than something you are watching, and puts the face this whole example is about
permanently out of frame.

## Arms and head

The feet are only half of it. `bot.*` tools — fourteen of them, in
`server/internal/tools/bot.go` — move the head and arms without the bot going
anywhere: wave, raise either arm or both, point either way, look
left/right/up/down, sweep its head around the room, nod, shake its head, and
rest back to neutral.

Raising *one* arm needs its own tool rather than a side argument on
`bot.raise_arms`. With only the both-arms tool available the model answered
"put your left hand up" with the nearest thing it had, which was both — and a
bot raising two arms for a request about one is obvious on screen. Each side is
a separate tool for the same reason `movement.turn_left` and `movement.turn_right` are:
tool choice is more reliable than argument extraction.

They ride the same fire-and-forget path as the drivetrain, on their own topic:

```json
{"type":"data","topic":"bot.gesture","payload":"eyJhY3Rpb24iOiJ3YXZlIiwiZHVyYXRpb25fbXMiOjE4MDB9"}
```

A separate topic rather than more `movement.*` actions, because a two-wheel
drivetrain has no arms — a device can ignore `bot.gesture` wholesale instead of
having to know which actions it cannot perform. The browser queues both kinds in
one ordered list, since "turn left and wave" has an order.

**Left and right are the bot's own**, seen from where it stands, matching
`movement.turn_left`. Worth stating because the bot faces you: its left hand is the
one on the right of your screen, and the rig weights sides that way too. The
first version had them viewer-relative and `point_right` raised the wrong arm.

Gestures hold and then release themselves, so nothing has to remember to put the
arms back down, and a new one displaces whatever was playing rather than
stacking on top. Each takes over only the joints it names: `look_left` turns the
head while the arms keep swinging with the walk, because the walk pose and the
gesture pose are blended per joint rather than wholesale.

Three things about posing this particular model:

- **Babylon indexes bones by creation order.** The vertex weights address bones
  by constant, so the two have to agree, and adding the head bone before the
  ankles silently shifted them apart. At rest every bone is identity, so nothing
  looked wrong until the bot walked — and then the head swung with a foot and
  neither ankle counter-rotated. It reads as a rigging problem rather than an
  off-by-two, so `attach` now asserts the order matches.

- **Raise the arms sideways, not forwards.** Swinging them up about the same
  axis the walk uses takes them straight through the head — the arms are nearly
  as long as the gap between shoulder and crown. Abduction, out from the chest,
  is what reads as "arms up".
- **The head is the widest part of the bot.** The arm weights are gated on
  width, because the hands hang outside the legs at the same height. Gating the
  head the same way drops its own sides back onto the body; it is gated on
  height alone, at the neck — the narrowest band on the model, at 0.58–0.63.

`bot.look_around` is the one gesture that needed more than a single oscillator.
A lone sine reads as machinery within about two cycles — the same problem the
idle motion solves by layering three clocks — so the sweep runs the head's yaw
and pitch on frequencies that do not divide into each other, and the two never
come back into phase. It is also deliberately slow and wide next to
`bot.shake_head`, which is the same channel at four times the rate; without that
separation "look around" and "say no" read as one gesture at two speeds.

The `bot-gestures` skill also tells the model to use these unprompted where they
fit: waving when it greets someone, nodding when it agrees. With a cap, because
a robot that nods after every sentence stops reading as one that means it.

```js
__voiceBot.scene.gesture({ kind: "wave", seconds: 2 })
__voiceBot.scene.gesture({ kind: "point_left", seconds: 3 })
```

This needs `@streamcore/js-sdk` **0.1.7 or newer**: earlier versions parse the `data` packet and then
drop it on the floor, since the union type had no case for it. The SDK now surfaces it as
`onData(topic, payload)` with the base64 already decoded.

## Rigging a model that has no rig

The bot is exported as a single welded mesh: one node, one primitive, no skin, no animations. That
is survivable while it stands still, and obviously wrong the moment it walks somewhere — the legs
just slide along underneath it.

So the skeleton is built at load time from the mesh's own proportions rather than baked into the
asset. Seven bones — a root that never moves, two hips, two shoulders, two ankles — and every vertex
weighted to one of them by where it sits in the bounding box. It costs one pass over 136k vertices,
changes nothing in the model pipeline, and survives a re-export of the bot at a different scale.

Working out which vertices are which was the part worth measuring. Sliced by height, the legs run up
the middle out to about 0.62 of the half-width, and the **hands hang outside them at the same
height**, from 0.17 up, with a clear gap between the two at 0.55–0.64. So leg weights are gated on
width as well as height: everything below the hip is emphatically not leg. Weights ramp with a
smoothstep rather than switching at a threshold, or the mesh tears open along whatever line the
threshold fell on.

Two things about this were easy to get wrong, and both cost a debugging round:

- **The mesh's local space is not the world's.** Skinning happens in mesh-local coordinates, and this
  model's glTF node carries a +90° X rotation, so local −Z is world up and local +Z is *down*. A
  height probe written the obvious way measures the bot upside down and reports the top of its head
  as its feet. `deriveAxes` reads the mapping back off the mesh's world matrix instead of assuming
  it, so a re-export with a different convention still rigs correctly.
- **`Bone.updateMatrix` is not how you pose a bone.** It overwrites the bone's *bind* matrix as well
  as its local one, so the inverse bind cancels the pose exactly and the mesh never moves — a rig
  that looks correct in every debug print and does nothing on screen. `setAxisAngle` is the right
  call.

The ankles exist only to keep the soles flat. The foot is welded to the shin, so with hips alone the
bot tip-toes: the sole tilts through the full swing angle. Each ankle gives back 65% of its hip's
rotation, which lands the foot close to level at the extremes of the stride.

Arms counter the leg on their own side. A bot swinging both forward at once reads as marching.

## Audio levels

Two envelopes reach the scene, and neither goes through React state — at 60fps that would re-render
the tree 60 times a second. Both are written into a ref that the render loop reads:

- **The user's microphone** comes from the SDK's `onAudioLevel`.
- **The agent's voice** needs its own `AnalyserNode` on `client.remoteStream`, in
  `hooks/useVoiceAgent.ts`. It works because the SDK has already attached that stream to an audio
  element; a `MediaStreamAudioSourceNode` on its own does not pull frames in Chrome.

## The model pipeline

| | Source | Prepared |
|---|---|---|
| Size | 81.9 MB | 5.2 MB |
| Triangles | 1,500,012 | 149,998 |
| Textures | 3 × 4096² PNG | 3 × 2048² WebP + emissive mask |

The room scan is copied through untouched — splat files are already compressed and there is nothing
useful to do to them offline.

Simplification is meshoptimizer, textures go to WebP, and geometry is quantised with
`KHR_mesh_quantization` — which Babylon reads natively. Draco and meshopt compression would shave off
more, but both need a decoder shipped and wired up; quantisation needs nothing.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_WHIP_URL` | `http://localhost:8080/whip` | The server's WHIP endpoint |
| `NEXT_PUBLIC_TOKEN_URL` | — | Optional. Endpoint issuing a short-lived JWT per connect |
| `NEXT_PUBLIC_API_KEY` | — | Optional. Bearer token for the token endpoint above |

Never put a provider key here. Provider credentials belong in the server's `config.toml`.

## Performance

- Quality is picked from core count and whether it is a phone, then stepped down automatically if the
  frame rate sits under 40 for a couple of seconds — hardware scaling, bloom kernel, MSAA samples,
  grain and chromatic aberration all follow it.
- The face canvas is 512 px wide. It is uploaded to the GPU every frame, and the visor never covers
  many pixels on screen.
- Camera framing adapts to viewport shape. Babylon's field of view is vertical, which would otherwise
  put the bot's head through the top of a phone screen.
- Babylon is imported dynamically, so it stays out of the first-load bundle.

## Layout

```
app/                     Next.js shell
components/              Canvas host, control dock, movement pad, transcript, metrics
hooks/useVoiceAgent.ts   SDK wrapper: status, agent state, transcripts, audio levels
lib/bot/
  botScene.ts            Loads the model, runs the frame loop, idle motion
  stage.ts               Engine, camera, lights, environment, floor, post-processing
  faceMaterial.ts        The visor shader and the mesh it draws on
  facePainter.ts         Canvas drawing for eyes, brows, mouth, mic meter
  expression.ts          Face parameters, expression table, blinks and saccades
  idleMotion.ts          Breathing, noise and gestures for a body that cannot pose
  room.ts                Loads and places the Gaussian splat office scan
  locomotion.ts          Walking, turning, and the keys that drive it by hand
  visor.json             The visor box, shared with the build script
scripts/prepare-model.mjs  82 MB authoring export → 5.2 MB web model
```

In development, `window.__voiceBot` exposes the scene and the level refs, so you can drive the face
without a server on the other end:

```js
__voiceBot.scene.setSignals({ expression: "thinking", connected: true, muted: false });
__voiceBot.levels.current.agent = 0.6;
__voiceBot.scene.react("happy", 3);
```
