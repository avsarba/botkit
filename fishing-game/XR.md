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
- Entering VR from the title starts the game (READY) at once. Leaving VR (session `end`, from the menu or the headset's
  system button) returns to the desktop view in the current state, with the camera back at the dock eye and everything
  re-parented as before. Entering/leaving can happen any number of times without leaks or duplicated listeners.
- `renderer.setAnimationLoop` is already used (it drives XR frames too). Nothing may call `requestAnimationFrame` for
  per-frame work while presenting (it does not fire in XR).

## Player rig and comfort

- `rig` = a THREE.Group at `(0, DOCK.deckY, 0)` facing -Z. While presenting, the camera is a child of the rig so the
  headset pose is relative to the deck. The rod-hand and reel-hand controller grips/rays are also rig children.
- Snap turn: rod-hand thumbstick left/right past 0.7 -> rotate the rig 30 degrees about the headset position (one step per
  flick, re-armed below 0.3). No smooth locomotion; the player can walk physically.
- Never move or rotate the XR view from game code (no follow camera, no title drift, no fight camera) while presenting;
  `view.js` is bypassed. A soft fade to dark when the head leaves the deck area by more than 0.6 m (comfort + a hint).

## Hands and input (default: rod in the right hand; a menu setting swaps hands)

| action | how |
|---|---|
| Cast | READY: hold the rod-hand **trigger** (finger on the line, bail opens, haptic tick), swing the rod forward, **release the trigger** during the swing. Power and direction come from the rod-tip velocity at release (see below). Releasing with the tip nearly still drops a short lob (power ~0.12). |
| Reel | Reel-hand **trigger**, analog: speed = trigger value (dead zone 0.08) times TACKLE.reelRetrieveMps. Or turn the reel for real: circling the reel hand within ~25 cm of the reel handle at > 0.5 rev/s reels at the matching speed (about 0.8 m of line per turn at full speed). The larger of the two wins. |
| Slow retrieve | Light trigger pressure (analog), no modifier needed. |
| Set the hook | During STRIKE: sweep the rod up/back sharply (rod-tip speed > 2.2 m/s upward/backward, or rod pitch rate > 3 rad/s), or press the rod-hand **A/X** button. Lure bites while reeling = reel set, as on desktop (keep reeling). |
| Rod lift / side pressure | The real rod pose. rodLift01 = rod elevation above horizontal (0 deg -> 0, 60 deg or more -> 1); rodSide = rod direction's lateral offset from the line toward the fish, -1..1 (+ = rod swept to the player's right). Pumping = raising then lowering the real rod. |
| Drag | Rod-hand thumbstick up/down: one 0.05 step per flick (repeats every 0.25 s while held). |
| Snap turn | Rod-hand thumbstick left/right. |
| Lures | READY only: reel-hand **X/Y** (or A/B on a left-handed setup) cycles to the next/previous lure. |
| Menu / pause | Reel-hand **menu** button (or thumbstick click): opens the VR menu panel and pauses. |
| Keep / Release | On the catch card: rod-hand **A** = Keep, **B** = Release, or point a ray at the card buttons and pull a trigger. |

Rod-tip cast mapping: `v` = tip velocity (world, smoothed over ~60 ms) at trigger release. `speed = |v|`,
`power01 = clamp((speed - 1.2) / 10.0, 0.08, 1)`, `direction` = horizontal part of `v` (or the rod's horizontal pointing
direction if the horizontal part is under 1 m/s), launch pitch = elevation of `v` clamped to 8..55 degrees. Casting behind
the player (direction more than 110 degrees from the rig's -Z) is ignored with a short "Cast out over the water" hint.

## Haptics (gamepad.hapticActuators[0].pulse / inputSource.gamepad.vibrationActuator fallback, always guarded)

nibble: rod hand 0.25 x 35 ms. bite / float goes under: rod hand 0.7 x 110 ms. hookset: rod hand 1.0 x 60 ms. fight:
rod hand continuous rumble ~ 0.08 + 0.55 * tension01 (re-pulsed every ~50 ms), extra 0.9 x 40 ms spikes on head shakes and
jumps. drag slipping: reel hand clicks, one 0.35 x 12 ms pulse per ~3 cm of line paid out (cap 30 Hz). reeling: very light
0.05 ticks per handle turn. line snap: rod hand 1.0 x 180 ms then silence. lure lands: 0.2 x 25 ms. UI hover/press: 0.1 x 10 ms.

## World-space UI (DOM overlays are not visible in VR)

All panels are canvas-textured planes (`CanvasTexture`, SRGB, mipmaps off, linear filter, redrawn only when a value
changed, at most ~15 Hz), unlit (`MeshBasicMaterial`, toneMapped false, fog false, depthTest true), same design tokens and
fonts as the DOM UI (wait for `document.fonts.ready` before the first draw).
- **Wrist gauge** on the reel hand (back of the wrist, tilted toward the eyes, ~13 x 9 cm): tension dial 0 -> line test with
  the drag tick and red zone, line out, drag, lure, clock, fish-on dot.
- **Prompt strip**: head-lazy panel ~1.6 m ahead, ~22 degrees below eye level, re-centers when the head turns more than 35
  degrees away (smooth, never jerky). Shows `hud.prompt` (sentence case, fades like the DOM prompt) and the STRIKE cue.
- **Catch**: the landed fish is held in the reel hand at real size (high-detail mesh, held by the lower jaw, body hanging,
  gently flexing), and a field-notebook card panel (same content as the DOM card) floats beside it facing the player.
  Keep/Release per the input table. The DOM showcase overlay pass is not used in VR.
- **VR menu** (pause): floating panel with Resume, Lure picker, Time presets, Sound on/off, Units, Rod hand (right/left),
  Journal, Exit VR. Controller rays (thin line + dot, only visible while a menu/card is open or the ray is over a panel)
  and trigger to press; hover highlight + haptic tick.
- **Journal**: panel listing species (caught count, best weight/length, tip for uncaught) and recent catches.

## Rendering while presenting

- Water: planar reflection and depth pre-pass off (the existing `uUseRefl = 0 / uUseDepth = 0` path with the env map and
  analytic far-shore band). Any offscreen pass that still runs while presenting must set `renderer.xr.enabled = false` for
  its duration and restore it (passes.js already does for the reflection).
- Environment: PMREM re-bakes and any other offscreen render guard `renderer.xr.enabled` the same way. Sky/cloud/star domes
  follow the viewer's position (`camera.matrixWorld`, which three keeps in sync with the headset).
- Shadows at most 1024. XR quality profile: 'high' -> framebufferScale 1.0, foveation 0.5; 'medium' -> 0.9, 0.8; 'low' ->
  0.75, 1.0. Default profile in XR: 'low' on standalone headsets (user agent contains OculusBrowser, Quest, Pico or
  Mobile VR), 'medium' otherwise; adaptive quality measures XR frame time against the session's frame rate.
- The fishing line (LineMaterial) keeps a thin, visible width in the headset (per-eye resolution); the float's screen-space
  minimum size uses the per-eye projection.
- The first-person desktop rod (camera-attached, drawn at 0.5 scale) becomes the real rod in the rod-hand grip at full scale;
  the gloved hand model goes on the rod hand and a second glove on the reel hand.

## Module ownership for the XR work

- **xr-core**: new `src/xr/session.js`, `src/xr/input.js`, `src/xr/haptics.js`, `src/xr/index.js`; edits `src/main.js`,
  `src/game/game.js`, `src/game/view.js`, `src/game/input.js`, `src/game/quality.js`, `build.mjs` (standalone) and
  `package.json` scripts. Owns the rig, session lifecycle, XR input -> `frame.input` + game actions, haptics, and the
  wiring of every other module's XR API.
- **xr-tackle**: `src/tackle/**`. Adds `tackle.setXRMode(on, { rodGrip, reelGrip })` (rod model on the rod grip at full
  scale with the handle in the palm and the blank pointing along the grip's forward axis tilted ~20 degrees up; reel glove on
  the reel grip; restores the desktop view model when off), `tackle.cast(power01, direction, { pitchRad })` (optional launch
  pitch; default unchanged), `tackle.getRodBase(target)` (world position of the reel seat) and `tackle.getReelHandle(target)`
  (world position of the reel handle knob, for crank detection), line width/min-size handling in XR.
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
  framebufferScale, hands, lastCast, pointerOverPanel).
- Harness: `node tools/harness.mjs --xr ...` installs IWER (Meta's WebXR emulator, dev dependency only, never shipped) as
  `navigator.xr` before page scripts, emulating a Quest 3; scenarios move the headset/controllers and press buttons through
  `window.__xrDevice` (`__xrDevice.position/quaternion`, `__xrDevice.controllers.right|left.position/quaternion`,
  `.updateButtonValue('trigger'|'squeeze'|'a-button'|'b-button'|'x-button'|'y-button'|'thumbstick', v)`,
  `.updateAxes('thumbstick', x, y)`; set `__xrDevice.stereoEnabled = true` for side-by-side eye screenshots). Check the
  exact button ids in node_modules/iwer (gamepad config for metaQuest3). The emulator is not a GPU headset: judge
  correctness and framing, not frame rate.
