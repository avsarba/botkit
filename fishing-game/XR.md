# Loon Lake Angler: WebXR (VR) mode contract

Immersive VR for 6DoF headsets with two tracked controllers (Meta Quest 2/3/Pro, Pico, PC VR through a WebXR
browser). You stand on the dock, hold the rod in your hand, cast by actually swinging it, reel with the other hand,
set the hook with a real rod sweep, feel the fish through the controllers, and hold your catch up to look at it.
Desktop and phone play must keep working exactly as before. Read CONTRACT.md first; this file adds to it.

## Availability and hosting

- `navigator.xr?.isSessionSupported('immersive-vr')` resolves true -> show an "Enter VR" button on the title screen
  (next to Start) and in the pause menu. Anything else (no `navigator.xr`, false, a rejection or a SecurityError) ->
  the button stays hidden and nothing else changes. Never throw.
- Inside the claude.ai Artifact viewer the iframe normally does not grant `xr-spatial-tracking`, so VR will usually
  be unavailable there; the button then simply does not appear.
- `node build.mjs --standalone` (also run by `npm run build`) writes `dist/play.html`: the same page wrapped in a proper
  `<!doctype html>` skeleton (charset, viewport with viewport-fit=cover, the same small reset the Artifact viewer adds).
  Host it on any HTTPS static host (GitHub Pages works) or `npx serve dist` on a LAN + a secure-context setup, then open
  it in the headset browser. `dist/index.html` stays the Artifact version (no skeleton tags).

## Session

- `renderer.xr.enabled = true` always (cheap when not presenting). The session starts only from a click (the Enter VR
  button): `navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'], optionalFeatures:
  ['bounded-floor', 'hand-tracking', 'layers'] })`, falling back to `local` if `local-floor` is refused (then offset
  the rig by 1.6 m standing height). `renderer.xr.setReferenceSpaceType('local-floor')`, `renderer.xr.setSession(s)`.
  Framebuffer scale and fixed foveation come from the XR quality profile (below). Audio starts from the same click.
- Entering VR from the title starts the game (READY) at once; entering from the pause menu resumes the game in the
  headset. Leaving VR (session `end`, from the menu or the headset's system button) returns to the desktop view in the
  current state, with the camera back at the dock eye and everything re-parented as before. Exit VR in the VR menu
  leaves the game paused (that menu is the pause), so the player finds the page's own pause menu; a session ended from
  the headset leaves it as it was. Entering/leaving can happen any number of times without leaks or duplicated listeners.
- `renderer.setAnimationLoop` is already used (it drives XR frames too). Nothing may call `requestAnimationFrame` for
  per-frame work while presenting (it does not fire in XR). Every frame renders while presenting, paused or not (the
  headset needs a frame and the menu lives in the scene).
- The 2D page while presenting: the headset browser may blur or hide it as the session starts (Quest does). Window `blur`
  and `document` `visibilitychange` never pause the game while a granted session is being started or presents, and the
  sound keeps playing (a request still pending, e.g. behind a browser permission prompt, does not count: the desktop
  game keeps pausing on blur / a hidden tab meanwhile); instead the session's own `visibilitychange` (the headset's
  system menu: `visible-blurred` / `hidden`) pauses in every playing state, which opens the VR menu (apps are expected to
  pause while the system UI has focus, and with hand tracking it is the way to the menu). three.js owns the drawing
  buffer while presenting: the game's resize handler and the quality manager never resize it or change the pixel ratio
  then (three.js warns "Can't change size while VR device is presenting"), and the desktop's adaptive quality also holds
  still while a granted session is being started (three.js has already noted the size and pixel ratio it restores on
  exit); one resize runs on exit. A granted session that three.js cannot start (it ends during the start-up, a
  reference space is refused) leaves nothing behind: the size / pixel ratio come back, one resize runs, and Enter VR
  works again.
- While presenting the camera's near plane is 0.05 m (a fish or a glove held up to the face stays whole); 0.1 on exit.
- A halt while presenting (the VR menu, the journal) stops the simulation but not the hands: the tackle keeps the line
  on the hand-held rod tip meanwhile (`tackle.xrHold()`, no physics), and the first simulated frame after any halt or
  session start is a discontinuity for the input's velocity history and the tackle (the rod's move meanwhile is never
  read as a swing: no hookset, no cast speed, no whip of the line).
- The page UI (`ui.setXRPresenting(on)`): hidden and `inert` while presenting, with a one-line "Playing in VR" note in
  its place (what a PC VR monitor shows), so a mouse or keyboard at the desk cannot press its buttons; it keeps being
  updated so it is current on exit. The desktop pointer / Space / steering input is suspended (the DOM hold button and
  touch strikes are ignored too); the other key shortcuts (Esc, J, M, U, 1-4, [ ]) still work and reach the VR panels.
  Behind the headset the page's own dialogs do not take keys, so Esc / P open and close the VR menu (closing an open
  journal first) in every state, the catch card included.

## Player rig and comfort

- `rig` = a THREE.Group at `(0, DOCK.deckY, 0)` facing -Z. While presenting, the camera is a child of the rig so the
  headset pose is relative to the deck. The rod-hand and reel-hand controller grips/rays are also rig children. On the
  first frame of a session and after a reference-space `reset` the rig slides horizontally so the head starts over the
  dock end, wherever the player stands in the room.
- Snap turn: rod-hand thumbstick left/right past 0.7 -> rotate the rig 30 degrees about the headset position (one step per
  flick, re-armed below 0.3). No smooth locomotion; the player can walk physically.
- Never move or rotate the XR view from game code (no follow camera, no title drift, no fight camera) while presenting;
  `view.js` is bypassed. A soft fade to dark when the head leaves the deck area by more than 0.6 m (comfort + a hint).

## Hands and input (default: rod in the right hand; a menu setting swaps hands)

Hand tracking (no controllers): a pinch works as that hand's trigger; there are no stick or button gestures.

| action | how |
|---|---|
| Cast | READY: hold the rod-hand **trigger** (finger on the line, bail opens, haptic tick), swing the rod forward, **release the trigger** during the swing. Power and direction come from the rod-tip velocity at release (see below). Releasing with the tip nearly still drops a short lob (power ~0.12), after a hold of at least 0.15 s: a quicker tap with the tip still is no cast (back to READY, like a desktop click under 0.12 s). A rod controller that goes away mid-swing (not just a tracking blip) cancels the cast. |
| Reel | Reel-hand **trigger**, analog: speed = (trigger - 0.08) / 0.92 (dead zone 0.08) times TACKLE.reelRetrieveMps. Or turn the reel for real: circling the reel hand within ~25 cm of the reel handle at > 0.5 rev/s reels at the matching speed, with the reel's own gear: about 0.52 m of line per turn (`TACKLE.reelRetrieveMps` 0.78 m/s at `TACKLE.reelTurnsPerS` 1.5 turns/s, the same reel the desktop animates), so 1.5 rev/s and faster is the full retrieve. The larger of the two wins. Forward only: circling the other way is anti-reverse (no retrieve), and the reel handle follows the circling hand forward. |
| Slow retrieve | Light trigger pressure (analog), no modifier needed. |
| Set the hook | During STRIKE: sweep the rod up/back sharply (rod-tip speed > 2.2 m/s upward/backward, or rod pitch rate > 3 rad/s), or press the rod-hand **A/X** button. The tip here is the rigid blank's (reel seat + rod direction x 1.755 m, straight from the controller pose), never the tackle's bent tip-top: a bite's load and bounce on the rod must not set the hook by itself. Lure bites while reeling = reel set, as on desktop (keep reeling). In WAITING with bait, only a clearly deliberate sweep within 0.6 s of a nibble is an early strike (> 4 m/s or > 3 rad/s for 2 consecutive frames; easing the rod up to watch the float is not one), or A/X. |
| Rod lift / side pressure | The real rod pose. rodLift01 = rod elevation above horizontal (0 deg -> 0, 60 deg or more -> 1); rodSide = rod direction's lateral offset from the line toward the fish, -1..1 (+ = rod swept to the player's right). Pumping = raising then lowering the real rod. The rod runs straight through the fist (`XR_ROD_TILT_RAD` in config.js, 0: along the grip's forward axis, which on a Touch controller is ~45 deg above the pointing ray), so a level ray holds the rod ~45 deg up. |
| Drag | Rod-hand thumbstick up/down: one 0.05 step per flick (repeats every 0.25 s while held). |
| Snap turn | Rod-hand thumbstick left/right. |
| Lures | READY only: reel-hand **X/Y** (or A/B on a left-handed setup) cycles to the next/previous lure. |
| Menu / pause | Reel-hand **thumbstick click** (Quest does not expose its menu button to WebXR): opens the VR menu panel and pauses; again resumes (or closes an open journal). The headset's system menu pauses into it too. |
| Keep / Release | On the catch card: rod-hand **A** = Keep, **B** = Release, or point a ray at the card buttons and pull a trigger. |

The controls name the hand everywhere in the headset (prompts: "Hold the right trigger...", "... left trigger reels
in"; mirrored for a left-handed rod). The first READY of a session shows a one-time hint "X / Y: change lure · left
stick click: menu"; the rod trigger pressed while the line is out (WAITING, FIGHTING), where it does nothing, points at
the one that reels ("The left trigger reels", at most every 5 s). The VR menu has a Controls block listing this table
for the hands as set up.

Rod-tip cast mapping: `v` = tip velocity (world, over the last ~60 ms of game time) at trigger release: the faster of
the tackle's bent tip-top's (`tackle.getRodTip`), so the rod whipping through adds to the swing, and the rigid blank's
(reel seat + rod direction x 1.755 m, from the controller pose): a rod still loading at the release (its tip lagging
behind a stroke that is still speeding up) never throws shorter than the swing itself, so a harder swing always
throws farther (with the bent tip alone, a stroke peaking at 1000 deg/s released at 6.7 m/s, shorter than one at 450).
`speed = |v|`, `power01 = max(0.12, clamp((speed - 1.5) / 22, 0, 1))` (under 0.5 m/s: the 0.12 lob; monotonic,
nothing throws shorter than the lob). A lure leaves at about the tip speed, and the desktop's full-power launch
corresponds to some 20-25 m/s of tip speed: a relaxed stroke (~220 deg/s of wrist at the release) throws ~10-12 m, a
hard one (~450-500 deg/s) some 20-25 m, ~700 deg/s and more nearly all the way (to be tuned against headset
recordings). `direction` = horizontal
part of `v` (or the rod's horizontal pointing direction if the horizontal part is under 1 m/s), turned toward where the
player looks by w = 0.7 x |yaw rate| / (|yaw rate| + |pitch rate|) of the rod at release: an overhead cast keeps the
tip's path exactly, a flat sidearm sweep (whose tip moves sideways across the target, with no rod load or lure weight
to time the release by) goes mostly where the player looks.
Launch pitch = the higher of the elevation of `v` and the rod's own elevation at release less 25 degrees, clamped to
8..55 degrees (a lob: 25). The tip of a rod swinging forward past vertical is already moving down, so the tip's path alone
would launch every overhead cast at the 8 degree floor, about a third short of the desktop's range for the same power;
the rod unloading as the line is let go lifts the lure: let go at "11 o'clock" (rod ~55 degrees up) and it flies out at
~30 degrees (the desktop's launch pitch), earlier goes higher, later lower; a sidearm cast stays low and an underhand
flick keeps its upward path. Launch speed per power is the desktop calibration. Casting behind the player (direction
more than 110 degrees from the lake direction, world -Z: the rig's -Z at session start, which snap turns do not change,
so a player who turned around still cannot cast onto the dock or the shore) is ignored with a short "Cast out over the
water" hint.

## Haptics (gamepad.hapticActuators[0].pulse / inputSource.gamepad.vibrationActuator fallback, always guarded)

nibble: rod hand 0.25 x 35 ms. bite / float goes under: rod hand 0.7 x 110 ms. hookset: rod hand 1.0 x 60 ms. fight:
rod hand continuous rumble ~ 0.05 + 0.55 * tension01 (smoothed, from the fight's per-frame mean tension; re-pulsed every
~50 ms), silent while the line is slack (tension01 < 0.02 or the fight's slack-line judgement): the slack is felt; extra
0.9 x 40 ms spikes on head shakes and jumps. drag slipping: reel hand clicks, one 0.35 x 12 ms pulse per ~3 cm of line paid out (cap 30 Hz). reeling: very light
0.05 ticks per handle turn (~0.52 m of line). line snap: rod hand 1.0 x 180 ms then silence. lure lands: 0.2 x 25 ms. UI
hover/press: 0.1 x 10 ms. bail opens (cast hold starts): rod hand 0.15 x 15 ms. Nothing pulses unless a session presents.

## World-space UI (DOM overlays are not visible in VR)

All panels are canvas-textured planes (`CanvasTexture`, SRGB, mipmapped with trilinear filtering and anisotropy 4: a
headset's eye buffer shows them 2-4x smaller than drawn, and plain bilinear minification makes thin strokes and small
text crawl; uploaded premultiplied and blended as premultiplied color so the mips never darken the edges; redrawn only
when a value changed, at most ~15 Hz), unlit (`MeshBasicMaterial`, toneMapped false, fog false, depthTest true: a panel
drawn over the player's own nearer hand or rod would give conflicting stereo depth cues), same design tokens and fonts as
the DOM UI (wait for `document.fonts.ready` before the first draw). The panel and ray shader programs compile when the
HUD first goes up, not on the frame a panel first shows.
- **Wrist gauge** on the reel hand (on top of the forearm just behind the wrist, tilted toward the eyes, ~13 x 9 cm; back
  there it stays clear of the rod handle and glove while the reel hand turns the reel): tension dial 0 -> line test with
  the drag tick and red zone, line out, drag, lure, clock, fish-on dot. Its canvas is 3 px per mm (390 x 270, still ~2x
  what the eye buffer resolves at ~40 cm), redrawn at most ~10 Hz, with the readouts quantized to what it can show
  (tension to half a pound / kilo, the needle to 1 % of line test).
- **Prompt strip**: head-lazy panel ~1.6 m ahead, ~22 degrees below eye level, re-centers when the head turns more than 35
  degrees away (smooth, never jerky). Shows `hud.prompt` (sentence case, fades like the DOM prompt) and the STRIKE cue:
  7 degrees above the horizon along the head's heading, but never more than 18 degrees above where the head points (so
  it stays in view while the player looks down at the wrist or the reel). The strip keeps its prompt ("Strike! Sweep the
  rod up") while the cue shows.
- **Catch**: the landed fish is held in the reel hand at real size (high-detail mesh, held by the lower jaw, body hanging,
  gently flexing), and a field-notebook card panel (same content as the DOM card) floats beside it facing the player, on
  the reel hand's outer side (away from the rod hand), and slides further out whenever the rod, seen from the eyes,
  would cross it. Keep/Release per the input table. The DOM showcase overlay pass is not used in VR. The held fish's
  shader programs are compiled at session start for the XR level (and for each new level) and kept for the session.
- **VR menu** (pause): floating panel with Resume, Lure picker, Time presets, Sound on/off, Units, Rod hand (right/left),
  Journal, Exit VR (no graphics quality: the XR profile below adapts by itself), and a Controls block (the input table,
  for the hands as set up). It opens where the player looks. Controller
  rays (thin line + dot, only visible while a menu, the journal or the card is open) and trigger to press; hover highlight
  + haptic tick. A trigger press anywhere on an open panel is taken by the panel and never reaches the game. Whatever
  pauses the game (the stick click, the headset's system menu, `debug.pause(true)`) opens this menu.
- **Journal**: panel listing species (caught count, best weight/length, tip for uncaught) and recent catches. Opened
  from the menu it takes the menu panel's place (the menu stays open underneath, still paused) and Close returns to it;
  J or the reel-stick click close it too.

## Rendering while presenting

- Water: planar reflection and depth pre-pass off (the existing `uUseRefl = 0 / uUseDepth = 0` path with the env map and
  analytic far-shore band). Any offscreen pass that still runs while presenting must set `renderer.xr.enabled = false` for
  its duration and restore it (passes.js already does for the reflection).
- Environment: PMREM re-bakes and any other offscreen render guard `renderer.xr.enabled` the same way. Sky/cloud/star domes
  follow the viewer's position (`camera.matrixWorld`, which three keeps in sync with the headset). The sky dome draws
  after the opaque scenery (early-Z skips every sky pixel the scenery covers). Nothing is fogged by where the head points:
  the terrain, every patched scenery material (forest, shell, ridges' haze, shore, birds) and the water fog per fragment
  with the sun / mid / side / away horizon colors blended by the azimuth of the fragment's own view ray
  (`env.fogUniforms`); `scene.fog.color` and `env.horizonColor` are world-fixed (the horizon out over the lake), for the
  near things and whole-lake terms. (The desktop gets the same: its far ridges no longer recolor as the camera pans.) Without the planar
  mirror the water's far-shore band follows the real skyline in VR (`env.skylineOccluderAt(azimuth)`: treeline and hills
  per azimuth) instead of the fixed 3.4 degree band the desktop's 'low' level uses. Terrain and scenery culling use the
  XR camera (both eyes' frustum, with a margin for head roll).
- Shadows at most 1024. XR quality profile: 'high' -> framebufferScale 1.0, foveation 0.5; 'medium' -> 0.9, 0.8; 'low' ->
  0.75, 1.0; the profile's name is also the scene's quality level while presenting. Profile in XR: always 'low' on
  standalone headsets (user agent contains OculusBrowser, Quest, Pico or Mobile VR: a level picked for the 2D page there
  would not hold the headset's frame rate); elsewhere (PC VR) a level picked by hand in the pause menu, else 'medium'.
  A standalone headset's 2D page also builds the lake at 'low' (the device default, unless a level was picked by hand):
  the runtime switch to 'low' only thins instance counts, while the forest detail, terrain rings, cloud slices, PMREM
  size, fish variants and shadow casters are fixed when the lake is built (built at 'high' the headset drew ~2x the
  triangles). On the 'low' profile the session asks for 72 Hz (`updateTargetFrameRate`, when supported; a Quest 3 runs
  WebXR at 90 by default). Adaptive quality measures XR frame time against the session's frame rate: slow frames first
  raise foveation to 1, then step the scene level down at a calm moment (READY), then, with nothing left to shed, step
  the display rate down (never under 72 Hz); sustained headroom climbs back the same way, never above the profile or the
  rate the session started at; a level picked by hand stays put. The framebuffer scale is fixed for a session (a three.js
  limit). On exit the desktop's level, auto mode and pixel ratio come back.
- Water at the XR 'low' level: its multiplicative (transmittance) pass uses the flat surface's Fresnel and skips the wave
  and detail normal (a uniform branch, no recompile); splash rings still run there for their foam.
- Scenery culling in XR: a circular cone (the head can roll) whose azimuth extent is worked out per chunk from the chunk's
  own elevation range (looking down at the reel, a horizon chunk needs about +-65 deg, not every azimuth); the mirror
  image's elevation test is skipped (no planar mirror in VR). three.js 0.170 has no multiview: every draw is issued once
  per eye.
- The fishing line (LineMaterial) keeps a thin, visible width in the headset (per-eye resolution); the float's screen-space
  minimum size uses the per-eye projection.
- The first-person desktop rod (camera-attached, drawn at 0.5 scale) becomes the real rod in the rod-hand grip at full scale;
  the gloved hand model goes on the rod hand and a second glove on the reel hand. The desktop landing ring is not shown.
- The landed fish in the hand is part of the lake scene (`showcase.setXR`); on the desktop the showcase compiles its fish
  without blocking (`compileAsync`), and a fish hidden while that compile is still pending (a quick Keep, or entering /
  leaving VR on the catch card) is detached at once and disposed only once the compile settles (three.js' readiness
  check would otherwise read a disposed material and throw).

## Module ownership for the XR work

- **xr-core**: new `src/xr/session.js`, `src/xr/input.js`, `src/xr/haptics.js`, `src/xr/index.js`; edits `src/main.js`,
  `src/game/game.js`, `src/game/view.js`, `src/game/input.js`, `src/game/quality.js`, `build.mjs` (standalone) and
  `package.json` scripts. Owns the rig, session lifecycle, XR input -> `frame.input` + game actions, haptics, and the
  wiring of every other module's XR API.
- **xr-tackle**: `src/tackle/**`. Adds `tackle.setXRMode(on, { rodGrip, reelGrip })` (rod model on the rod grip at full
  scale with the handle in the palm and the blank pointing along the grip's forward axis, tilted by config.js
  `XR_ROD_TILT_RAD` (0: straight through the fist; shared with the XR input); reel glove on the reel grip; forearm-less
  gloves whose cuffs end in a rounded dome; restores the desktop view model when off), `tackle.xrHold()` (the game is
  halted: keep the line on the hand-held tip, no physics), `tackle.cast(power01, direction, { pitchRad })` (optional launch
  pitch; default unchanged), `tackle.getRodBase(target)` (world position of the reel seat) and `tackle.getReelHandle(target)`
  (world position of the reel handle knob, for crank detection), `tackle.xrTeleported()` (core calls it when the rig jumps:
  a snap turn or a recenter; the hanging rig re-hangs under the tip and the line near the tip moves along, instead of the
  tip-speed test alone, which misses a 30 degree turn once frames take longer than ~30 ms), line width/min-size handling
  in XR.
- **xr-hud**: new `src/xr/hud.js` (+ `src/xr/panels/*.js`); edits `src/ui/**` and `src/index.template.html` only to add the
  Enter VR buttons (title + pause) and `ui.setXRAvailable(bool)` / handler `onEnterVR()`. `createXRHud({ renderer, scene,
  camera, events, handlers, species, config })` returns `{ setActive(on, { rodGrip, reelGrip, rodRay, reelRay, rig }),
  update(hud, frame, xin), strikeCue(opts), showCatch(record, flags), hideCatch(), openMenu(state), closeMenu(),
  isMenuOpen(), openJournal(records), closeJournal(), toast(text, kind), select(hand) -> bool (true if a panel button took
  the press), get pointerOverPanel(), dispose() }`. `handlers` is the DOM UI's handler object plus `onExitVR()` and
  `onRodHand(hand)`.
- **xr-render**: `src/water/**`, `src/environment/**`, `src/scenery/**`, `src/fish/**`, `src/game/showcase.js`.
  Adds `showcase.setXR(on, { holdGrip })` (in VR, `show()` puts the high-detail fish in the hold grip, held by the jaw; no
  overlay pass; `hide()` disposes), makes water/environment passes XR-safe and XR-cheap per "Rendering while presenting",
  and checks fish/scenery shaders for anything that assumes a single view (e.g. `cameraPosition` is fine; custom screen-space
  lookups must use per-eye data).

## Debug hooks and testing

- `window.__game.debug.xr = { available(), enter(), exit(), status() }` (status: presenting, referenceSpace, profile,
  framebufferScale, hands, lastCast, pointerOverPanel). Also: status has the rig, head, rod (dir, lift, tip velocity,
  trigger), reel (trigger, crank reading and handle), hookMetric, the HUD's own status (`ui`: menu / journal / card open,
  ray hover), the game settings, recent haptics and the quality; `lastCast` has power01, speedMps, yawDeg (+ = right of
  the lake axis), pitchDeg, tipElevDeg, rodDeg, lob, behind. `waitFrames(n)` resolves after n XR frames; `everyFrame(fn)`
  runs fn after each XR frame's controller read until it returns false (drive a gesture one pose per frame, whatever the
  frame time); `setRodHand(h)`; `panelTarget(panel, buttonId)` -> `{ world, local }` centre of a VR panel button
  (`local` in the reference space the emulator's poses use), for pointing a ray; `toRig([x, y, z])` a world point in
  that space.
- Harness: `node tools/harness.mjs --xr ...` installs IWER (Meta's WebXR emulator, dev dependency only, never shipped) as
  `navigator.xr` before page scripts, emulating a Quest 3; scenarios move the headset/controllers and press buttons through
  `window.__xrDevice` (`__xrDevice.position/quaternion`, `__xrDevice.controllers.right|left.position/quaternion`,
  `.updateButtonValue('trigger'|'squeeze'|'a-button'|'b-button'|'x-button'|'y-button'|'thumbstick'|'thumbrest', v)`,
  `.updateAxes('thumbstick', x, y)`; set `__xrDevice.stereoEnabled = true` for side-by-side eye screenshots). Check the
  exact button ids in node_modules/iwer (gamepad config for metaQuest3). The emulator is not a GPU headset: judge
  correctness and framing, not frame rate. `--raw` serves the file as it is instead of inside the Artifact viewer's
  skeleton, for `dist/play.html` (`--xr --raw --file dist/play.html`), which is tracked in git next to `dist/index.html`.
- The regression scenario is `tools/scenarios/xr.mjs` (`npm run build`, then
  `node tools/harness.mjs --xr --scenario tools/scenarios/xr.mjs --out out/xr --size 960x540`): the title's Enter VR
  button, casts at three swing speeds and to both sides (plus a lob and a cast toward the shore), every lure, the analog
  reel trigger and the crank gesture, two catches (flick and A hooksets, lift / side / trigger fights, Keep with A,
  Release with B), the VR menu (time, units, sound, journal, rod hand), left-handed play and snap turns, Exit VR, the
  desktop afterwards, re-entry from the pause menu and a headset-side `session.end()`, with stereo shots at the key
  moments. It also fakes the page blurring / being hidden, a window resize and the headset's system menu while
  presenting, and uses a desk mouse and keyboard (the hidden page's buttons and Space do nothing, Esc opens the menu).
  Gestures are played one pose per XR frame with `debug.setFixedDt(0.05)` (every rendered frame steps the game exactly
  50 ms; an emulated frame sometimes comes early, which would make that frame's pose step look faster), so gesture
  speeds hold however slow or uneven the frames are. Casts are played at 25 ms steps (`setFixedDt(0.025)` for the
  gesture), each with a real backswing and a short pause (a pose jump into the wind-up would load the rod with a huge
  acceleration spike and leave it ringing, which makes the release speed depend on the ring's phase), then a stroke
  whose wrist speed rises to its peak at the release, as a real cast's does. It also checks a spinner bite with the rod
  held still (at 72 Hz steps: no hookset by itself), the STRIKE cue while looking down, sidearm and three-quarter casts,
  reverse cranking, the catch card and the wrist gauge clear of the rod, no shader compile for the fish in the hand,
  and the line staying on the rod tip while the game is paused and the hand moves. `XR_ONLY=casts,reel,...` runs a
  subset.
