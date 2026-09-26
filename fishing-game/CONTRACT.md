# Loon Lake Angler: module contract

A realistic first-person freshwater fishing game that runs as ONE self-contained
HTML page (published as a claude.ai Artifact). This file is the single source of
truth for how the modules fit together. If you own a module, implement exactly
the API below; if you need something that is not here, add it in a way that keeps
every existing signature working, and describe it in your final report.

**VR (WebXR):** the immersive VR mode (Enter VR on the title and in the pause menu, the rig, controllers, haptics,
world-space HUD, rendering while presenting, the standalone `dist/play.html` build) is specified in **XR.md**, which
adds to this file. Everything here keeps working unchanged on desktop and phones; the XR additions to the module APIs
are listed under "XR additions" below and described in XR.md.

## Ground rules (all modules)

- Plain JavaScript ES modules (no TypeScript, no JSX). `import * as THREE from 'three'`.
  three.js is **0.170.0**. Addons are allowed: `import { Sky } from 'three/addons/objects/Sky.js'`
  (esbuild bundles addons; `three` itself stays on the CDN).
- **No network assets.** The Artifact CSP blocks every fetch/XHR/image from other hosts.
  Every texture is procedural (Canvas2D -> `THREE.CanvasTexture`, or `THREE.DataTexture`),
  every sound is synthesized with WebAudio, every model is built from geometry in code.
  Only Google Fonts CSS (`fonts.googleapis.com`) may be linked, from the HTML template.
- No `alert/confirm/prompt`, no `window.open`, no `<a download>`, no `window.print()`.
- `localStorage` only inside try/catch; the game must work when it throws.
- Colors: the renderer uses `SRGBColorSpace` output + `ACESFilmicToneMapping`. Canvas textures
  that hold color must set `texture.colorSpace = THREE.SRGBColorSpace`.
- Shared constants/helpers live in `src/config.js` (read it). Do not duplicate them.
- Performance budget for the whole scene at `quality: 'high'` on a mid laptop GPU @1080p:
  60 fps, < 300 draw calls, < 1.2 M triangles, textures < 150 MB. Use `InstancedMesh`
  for anything repeated (trees, reeds, lily pads, rocks). Every `create*` receives
  `ctx.quality` in `'high' | 'medium' | 'low'` and should scale its cost down.
- Every module that allocates per-frame must reuse scratch vectors (no `new THREE.Vector3()` in hot loops).
- Custom shaders must support three's fog (`#include <fog_pars_fragment>` etc., `fog: true` uniforms)
  so distant objects blend into `scene.fog`.
- Render layers (`LAYERS` in config.js): anything that can be seen through the water (terrain/lake bed,
  fish, lures, the float, sunken timber, dock pilings, rocks, reed stems) must call
  `object.layers.enable(LAYERS.UNDERWATER)`; Water renders that layer in a cheap depth pre-pass to compute
  the true water thickness in front of each pixel (absorption + transparency). `LAYERS.NO_REFLECT` marks
  objects the planar reflection should skip. `LAYERS.REFLECTION` holds cheap stand-ins (e.g. a coarse
  terrain / treeline proxy) that ONLY the planar reflection renders (it draws layers 0 | REFLECTION minus
  NO_REFLECT); the full-detail originals carry NO_REFLECT. The main camera never enables REFLECTION.
- Do not edit files you do not own. If you believe another module needs a change, put it in your report.

## Coordinates and the lake

- Meters, +Y up, calm water surface at `y = 0` (`WATER_LEVEL`).
- The player stands at the lake end of a wooden dock at `(0, DOCK.deckY, 0)`, eye 1.65 m above the deck.
  Yaw 0 looks toward **-Z** (out over the lake). The dock runs from `z = DOCK.endZ (-1)` back to land
  at `z = DOCK.shoreZ (+24)`; it crosses the waterline at about `z = +16`.
- Lake shape (Environment owns the exact terrain; everyone else queries `env.getTerrainHeight`):
  - Depth at the dock end ~1.6 m; ~3 m at z = -12; ~5 m at z = -30; 8-11 m in the middle (z < -60).
  - Open water for at least 60 m in every direction the player can face (yaw -80 deg .. +80 deg).
  - Far shore ~250-380 m away, irregular, forested, with hills/mountains beyond.
  - A **weedy cove** to the player's left: x -45..-15, z -12..+14, depth 0.4-2 m, lily pads and reeds.
  - A **rocky point / drop-off** to the right: x +18..+45, z -30..-4, boulders, depth falls from 1 m to 7 m.
  - A **sunken timber** patch in front-left around (-10, -22), depth ~3.5 m.
  - Near shore behind and beside the dock: sand/mud margin, reeds, then grass and forest.

## Frame object (built by core each frame, passed to every `update(frame)`)

```js
frame = {
  dt,            // seconds since last frame, clamped to <= 0.05
  time,          // seconds since start (monotonic, pauses when the game pauses)
  hours,         // time of day, 0..24 (float)
  camera,        // THREE.PerspectiveCamera (in the scene graph)
  state,         // one of STATES in config.js
  quality,       // 'high' | 'medium' | 'low'
  input: {       // what the player is doing right now
    aimYaw, aimPitch,   // radians; camera look direction (yaw 0 = -Z)
    charge01,           // 0..1 while CHARGING, else 0
    reeling,            // bool: reel handle turning
    reelSpeed01,        // 0..1 (1 = full retrieve speed)
    rodSide,            // -1..1 rod swept left/right during a fight (side pressure)
    rodLift01,          // 0..1 rod raised during a fight
  },
  lure,          // tackle.getLure() snapshot (see Tackle), always present after init
  hooked,        // fish.getHooked() or null
  tensionN,      // line tension in newtons (0 when slack)
  tension01,     // tensionN / TACKLE.lineBreakN
  dragN,         // current drag setting in newtons
  lineOutM,      // line off the spool
  slipMps,       // speed the drag is giving line (m/s, >= 0)
}
```

## Events (`ctx.events`, from `createEmitter()` in config.js)

Emitters and payloads. Subscribe with `events.on(type, fn)`. Each effect has exactly one producer,
so do not call e.g. `water.splash()` for a lure landing yourself; Water subscribes to the event.

| event | emitted by | payload |
|---|---|---|
| `cast` | core | `{ power01, lureId }` (at release) |
| `lure:landed` | tackle | `{ position: Vector3, lureId, onWater: bool, speed }` |
| `lure:home` | tackle | `{}` lure reeled back to the rod tip |
| `lure:twitch` | tackle | `{ position }` topwater "walk" / pause pops (small splash + sound) |
| `fish:interest` | fish | `{ fishId, speciesId, position }` a fish is following the lure |
| `fish:nibble` | fish | `{ fishId, strength01 }` bobber twitch / rod tip tap |
| `fish:bite` | fish | `{ fishId, biteId, speciesId, weightKg, lengthCm, windowS, position }` hookset window opens. Core takes it in WAITING (and ESCAPED, when the lure drops back in); in any other state it closes it again with `fish.missBite(biteId, 'ignored')` |
| `fish:swirl` | fish | `{ position, size01 }` surface boil/blow-up (topwater strikes, missed strikes) |
| `fish:missed` | fish | `{ fishId, reason }` bite window closed, fish let go |
| `fish:spooked` | fish | `{ position, count }` |
| `fish:jump` | fish | `{ position, size01 }` hooked fish clears the water (on exit AND re-entry) |
| `fish:splash` | fish | `{ position, size01 }` thrash at the surface |
| `strike` | core | `{ success: bool, early: bool }` player set the hook |
| `hooked` | core | `{ fish }` fight started |
| `tackle:snap` | core | `{ tensionN }` line broke |
| `escaped` | core | `{ reason: 'slack' | 'headshake' | 'missed' }` |
| `catch` | core | `{ record }` fish landed (record shape below) |
| `state` | core | `{ from, to }` |
| `ui:click` | ui | `{}` any button press (audio makes a soft tick) |

## Module APIs

### Environment: `src/environment/index.js` -> `createEnvironment(ctx)`
`ctx = { renderer, scene, camera, events, quality }`. Owns sky, sun/moon, lights, fog, exposure,
terrain (land + lake bed), and time of day. Returns:

```js
{
  update(frame),                 // cheap; may animate clouds / sky
  setTimeOfDay(hours),           // called every frame by core; must be cheap when hours barely changed.
                                 // Re-bake the PMREM env map at most every ~5 game minutes and never more
                                 // than once per 2 real seconds.
  sunDirection,                  // THREE.Vector3 (unit, toward the sun), updated in place
  sunColor, sunIntensity,        // THREE.Color (live), number
  skyColor, horizonColor,        // THREE.Color (live); horizonColor == fog color
  envMap,                        // THREE.Texture | null (PMREM of the sky), property may be replaced; read it each frame
  windStrength,                  // 0..1 (live), gentle breeze by default (~0.25)
  windDirection,                 // THREE.Vector2 unit (live)
  getTerrainHeight(x, z),        // meters, lake bed is negative
  getDepth(x, z),                // max(0, -terrainHeight)
  isWater(x, z),                 // depth > 0.05
  getHabitat(x, z),              // { depth, weeds: 0..1, rocks: 0..1, wood: 0..1 }
  depthMap,                      // { texture: THREE.DataTexture (R = depth / 12 m, linear, 0 on land),
                                 //   bounds: { minX, minZ, maxX, maxZ } } for water shading
  sunLight,                      // THREE.DirectionalLight (casts shadows around the dock only)
  hemiLight,
  // extras (read by water, tackle, the showcase; optional for everyone else)
  nightFactor, exposure, sunElevationDeg, hours,   // getters, live
  sunVisibility,                 // 0..1 share of the sun's (by night the moon's) disc above the terrain + treeline
                                 // skyline seen from the dock; ALREADY folded into sunIntensity / sunLight.intensity,
                                 // so a key light behind the far forest leaves the lake in shade and makes no glint
  sunOpenIntensity,              // the key intensity without that skyline occlusion (for tall things above the treeline)
  sunOccluder,                   // skyline occlusion helper
  skylineElevationAt(azimuth),   // skyline elevation (rad above the eye's horizontal) at azimuth atan2(x, -z)
  setSkylineProfile({ bins, elevation, distance? }),  // scenery hands over the treeline it built
  skyRadiance, horizonRadiance,  // THREE.Color, scene-referred (linear, before exposure)
  bakeEnvironment(),             // re-bake the PMREM now (time presets)
}
```
`windStrength` follows the time of day: light airs at night, a midday / afternoon breeze (~0.3), and glassy calm
(~0.07, gusts scaled down with it) at first and last light (~5-7 h and ~19.5-21 h), when the water goes mirror-like
and reflects the far treeline.
Also sets `renderer.toneMappingExposure` from the time of day and owns `scene.fog`.
Night (after ~21:00, before ~5:00) needs stars and a moon so the game still reads at night.

### Scenery: `src/scenery/index.js` -> `createScenery(ctx)`
`ctx = { renderer, scene, camera, events, quality, env }`. Owns everything that sits ON the terrain:
the wooden dock the player stands on (planks, posts, cleats, a tackle box and a bait bucket on the deck),
forest (instanced conifers + birch/maple), shoreline reeds/cattails, lily pads in the cove, boulders on
the point, the sunken timber (visible through shallow water), distant ridge silhouettes, a few birds.
Returns `{ update(frame), dockTopAt(x, z) /* deck y or null */ }`. Uses `env.getTerrainHeight`
for placement. Trees/reeds sway with `env.windStrength`.

### Water: `src/water/index.js` -> `createWater(ctx)`
`ctx = { renderer, scene, camera, events, quality, env }`. Owns the lake surface:
gentle wind waves (sum of Gerstner/sine waves + animated detail normals), fresnel reflection
(planar reflection render target at reduced resolution on high/medium; env map fallback on low),
sun glint, depth-based color and transparency from `env.depthMap` (clear and greenish over the
shallow bed, dark teal-blue in deep water, lake bed and fish visible within a few meters), soft shore
edge, expanding ripple rings, splash particles, V-wakes. Returns:

```js
{
  mesh,
  update(frame),
  getHeight(x, z),                    // surface y now (same waves as the shader, ripples excluded)
  getNormal(x, z, target),            // THREE.Vector3
  addRipple(x, z, strength01 = 0.5, radiusM = 3),
  splash(position, size01 = 0.5),     // droplets + ripple; used for events below
  wake(x, z, dirX, dirZ, speedMps),   // call every frame something moves at the surface
  clarityM,                           // visibility through the water, ~3 m
}
```
Subscribes to `lure:landed`, `lure:twitch`, `fish:swirl`, `fish:jump`, `fish:splash`, `fish:nibble`
(tiny ring at the bobber: use `frame.lure.position`) and makes the splash/ripples itself.
Objects under water (fish, lake bed, bait) render before the water (`renderOrder`), and the water must
not write depth in a way that hides the fishing line or float drawn after it.

### Fish: `src/fish/index.js`
Exports `SPECIES` (array, from `src/fish/species.js`), `rollFish(speciesId, rng)`,
`createFishMesh(species, lengthCm, opts)` (re-exported from `src/fish/mesh.js`), `createFishSystem(ctx)`.

Two owners: **fish-mesh** owns `src/fish/mesh.js` (models, skins, swim animation; appearance parameters are
kept inside mesh.js in a table keyed by `species.id`), **fish-behavior** owns `src/fish/species.js`,
`src/fish/system.js` and `src/fish/index.js` (facts, fight personality, AI). Species ids are fixed:
`bluegill, yellow_perch, rainbow_trout, smallmouth_bass, largemouth_bass, walleye, channel_catfish,
northern_pike, muskellunge`. `createFishMesh` must work for every id (and fall back gracefully for an unknown one).

Species (real ones for a northern US/Canadian lake): Bluegill, Yellow Perch, Rainbow Trout,
Smallmouth Bass, Largemouth Bass, Walleye, Channel Catfish, Northern Pike, Muskellunge (rare).
Each species definition includes at least:
```js
{ id, name, latin, blurb,                       // short field-guide note, real facts
  weightKg: { min, typical, max, record },      // lognormal-ish sampling between min and max
  lw: { a, b },                                 // FishBase length-weight: W(g) = a * L(cm)^b
  strength, stamina, jumpiness, headshake,      // 0..1 fight personality
  depthM: [min, max], habitat: { weeds, rocks, wood, open },  // 0..1 preferences
  lures: { bobber, spinner, crankbait, topwater },            // 0..1 how readily it takes each
  activity(hours) -> 0..1,                      // dawn/dusk peaks etc. (walleye low light, catfish night)
  hookWindowS, rarity,
  tip }                                         // one-line field tip (where / when / what it takes here) for the journal
```
`src/fish/mesh.js` also exports, for core and the fish system (optional to use):
`prepareFishAssets(species, { detail, quality, renderer }) -> job { key, speciesId, done, step(budgetMs), finishNow(), cancel() }`
builds a species' high-detail skin / geometry a few ms at a time (LRU cache of the last two species),
`fishAssetsReady(species, { detail, quality }) -> bool`, `createFishProgramKeeper({ quality, castShadow }) -> { object3d, dispose }`
(a tiny never-drawn stand-in carrying the high-detail fish materials, so their shader programs compile at load and
stay alive), `prewarmFishMeshes(ids, opts)`, `disposeFishMeshCache()`.

`createFishMesh(species, lengthCm)` -> `{ object3d, update(dt, swimSpeedMps, turnRate, exhaustion01), dispose() }`:
procedural, anatomically believable body (species-specific profile: deep-bodied bluegill, torpedo
pike/musky with duck-bill snout, forked vs rounded tail, catfish barbels, spiny + soft dorsal where real),
eyes, fins (translucent), canvas-painted skin with the real markings (bass lateral stripe, perch bars,
pike bean-shaped spots, musky bars, trout pink band and black spots, bluegill ear flap, walleye glassy eye
and white tail tip), countershading, slight iridescence/specular. Swimming = traveling body wave that
grows toward the tail (vertex shader or bones), tail beat frequency tied to speed. Size 1:1 in meters.

`createFishSystem(ctx)` with `ctx = { renderer, scene, camera, events, quality, env, water }` returns:
```js
{
  update(frame),                 // population AI: cruising, schooling (perch/bluegill), holding cover,
                                 // noticing the lure (vision + lateral line), following, nibbling, biting.
                                 // Emits fish:interest / nibble / bite / swirl / missed / spooked.
  getHooked(),                   // HookedFish | null
  hookBite(biteId),              // core calls when the hookset lands inside the window -> HookedFish
  missBite(biteId, reason),      // early/late/no strike -> that fish leaves (maybe spooked)
  releaseHooked(outcome),        // 'escaped' | 'snapped' | 'landed' | 'released'
  spook(position, radiusM),
  debugForceBite(speciesId?),    // next bite happens within ~1 s if the lure is in the water
  population,                    // array, for debugging
}
```
Rules: bites need the lure in the water (`frame.lure.inWater`), obey species lure preferences, time-of-day
activity, habitat and depth (bobber bait hangs `LURES[].depthM` under the float; crankbait depth grows with
retrieve), and for `kind: 'lure'` require the lure to be moving (retrieved) at a plausible speed or just
paused after moving. Bobber rigs get 0-4 nibbles before a real bite; lures get a sudden hit. Typical wait
at dawn with a good spot: 10-40 s. Spooking: casting right on top of fish, lots of splashing.
A fish that is visible (shallow water, near the dock) should visibly swim to the lure.

`HookedFish`:
```js
{
  id, species, weightKg, lengthCm,
  position,          // THREE.Vector3 (mouth / hook point), live
  velocity,          // THREE.Vector3, live
  stamina01,         // 1 fresh -> 0 spent
  headShake01,       // live, 0..1 (rod tip shakes; head shakes on slack line can throw the hook)
  isJumping,         // bool
  object3d,          // the fish mesh in the scene. It may be REPLACED ONCE mid-fight (the population model is
                     // swapped for the high-detail fight model when its assets are ready): read it each frame
  step(dt, { tensionN, pullDir, rodTip, lineOutM }),
      // Integrate ONE fixed substep (core calls at 120 Hz). pullDir = unit vector fish -> rod tip.
      // Physics: mass = weightKg (+ added water mass), own swim force (runs / dives / bulldogging /
      // jumps, species personality, burst force ~ g * weightKg * (0.9 .. 2.2), stamina drains with
      // effort and faster under high tension, recovers slowly while resting), quadratic water drag
      // (top speed ~1-4 m/s by size), tension pulls along pullDir. Stay below the surface except
      // during jumps, above the lake bed, and inside water (never on land). Emit fish:jump / fish:splash.
  toLanding(targetPos, durationS),   // core calls when netting starts; animate to the surface beside the dock
}
```
Released / escaped fish drop their high-detail mesh after ~6 s. A kept fish is restocked after 10-20 game minutes;
rare fish (musky) respawn after 15-30 minutes and never straight onto the lure.

### Tackle: `src/tackle/index.js` -> `createTackle(ctx)`
`ctx = { renderer, scene, camera, events, quality, env, water }`. Owns the rod (first-person view model
attached to the camera: 7' graphite blank with guides, cork split-grip, spinning reel with bail, rotating
spool and handle that turns while reeling), the fishing line (verlet rope with sag, lies on the water,
straightens under tension; hi-vis 12 lb mono, drawn so it is visible at 1 px width but not cartoonish,
e.g. `Line2` from `three/addons/lines/`), the terminal tackle models for each lure in `LURES` (float +
hook + worm, inline spinner with spinning blade, crankbait with lip and trebles, walking topwater), and
casting physics (ballistic flight with air drag, line paying off the spool, lure lands in water/on land).

```js
{
  update(frame),                          // rod pose from frame.state/frame.input, lure + line physics
  setLure(lureId),
  getLure(),                              // snapshot object reused each frame:
      // { id, position: Vector3, velocity: Vector3, state: 'home'|'flying'|'water'|'land'|'fish',
      //   inWater: bool, depthM, speedMps, retrieving: bool, pausedS (seconds since it last moved),
      //   distanceM (horizontal distance from rod tip), lineOutM, bobberPosition: Vector3|null }
  getRodTip(target),                      // world position of the tip-top guide
  cast(power01, direction /* unit Vector3, horizontal aim */),   // start flight; emits lure:landed
  reel(dt, speedMps),                     // shorten line; lure swims toward the rod; emits lure:home
  setFight(active, { fishPosition, tensionN, lineOutM }),  // line runs rod tip -> fish mouth; bobber rides the line
  setRodLoad(tensionN, towardWorld /* Vector3 */),       // rod bends (parabolic curve, more toward the tip)
  nibble(strength01),                     // float twitches / rod tip taps
  biteDown(),                             // float goes under / rod tip loads
  snap(),                                 // line breaks: lure lost, line flutters; core re-ties later
  resetToHome(),                          // lure back hanging below the rod tip
  // extra
  predictLanding(power01, direction?, target?),  // Vector3 | null: where a cast with this power along `direction`
                                          // (horizontal; default the view direction) comes down, with the same launch
                                          // calibration, air drag and wind as the real flight
}
```
While CHARGING, tackle draws a faint hairline ring on the water at `predictLanding(frame.input.charge01)` (fading
in with the charge, only over water). During CAUGHT the line, float and lure are hidden (the fish is in the
angler's hands). The line is lit in scene units (sky + key light, a thin glint, distance fade): main line hi-vis
12 lb mono, a clear leader under the float.
Tackle must call `water.wake(...)` while the lure/float moves on the surface, and use `water.getHeight`
so the float rides the waves. The topwater "walk-the-dog" happens when retrieving in pulses; emit
`lure:twitch` on each pop.

### Audio: `src/audio/index.js` -> `createAudio(ctx)`
`ctx = { events, quality }`. All procedural WebAudio (no samples). Returns
```js
{ start(),            // call from the Start button's click handler (creates/resumes the AudioContext)
  setMuted(bool), muted,
  update(frame),      // ambience + continuous sounds follow frame (reel whir from frame.input.reeling,
                      // drag zing from frame.slipMps, line hum from frame.tension01, wind from env)
  play(name, params) }
```
Ambience by time of day: dawn bird chorus and **common loon** tremolo/wail calls at dawn/dusk, midday
wind in the pines and distant insects, evening frogs and crickets, gentle water lapping on the dock posts.
One-shots driven by events: cast whoosh (power), lure/float plop (size), fish swirl/splash/jump, nibble
tick, strike "whip", reel click on engage, line snap (sharp crack + recoil), catch (small wooden/warm
cue), `ui:click`. Mix carefully: nothing harsh, master compressor, total loudness modest.

### UI: `src/ui/index.js` + `src/index.template.html` -> `createUI(ctx)`
`ctx = { events, handlers, config }` where `handlers` (from core) are
`{ onStart, onLure(id), onDrag(01), onTimePreset(hours), onMute(bool), onUnits(u), onPause(bool),
   onActionDown(), onActionUp(), onQuality(q /* 'auto'|'high'|'medium'|'low' */), onKeep(), onRelease(),
   onJournal(open), onSlow(bool) /* touch Slow chip: slow retrieve, like Shift */ }`.
The template holds `<title>`, the Google Fonts link, all CSS, and the static DOM:
`#stage` (full-viewport container the core appends the canvas to, behind everything) and `#ui`
(overlay root, `pointer-events: none` except on real controls). It contains the literal marker
`<!--BUNDLE-->` where the build inlines the script, and it must NOT contain `<!doctype>`, `<html>`,
`<head>` or `<body>` tags (the Artifact viewer wraps the page).
```js
{
  showTitle({ records }), hideTitle(),
  setState(state),
  update(hud),       // every frame; hud = { state, tension01, tensionN, dragN, drag01, lineOutM,
                     //   castPower01, hours, lureId, units, muted, catches, fishOn, fishDistanceM,
                     //   prompt, promptKind, paused, quality /* incl. 'auto' */, slow, fishStamina01,
                     //   rodLift01, rodSide, rodStiff01 /* rod meter in the gauge header while fighting */,
                     //   slackLine /* a fish on and the line really hanging slack: the dial pulses */ }
  strikeCue({ reelSet }),  // big, brief "STRIKE" flash (upper third, above the float) when a bite opens the
                     //   window; its sub-line says how to set the hook, or "Keep reeling!" for a reel set
  showCatch(record, { isPersonalBest, isNewSpecies }),  // catch card; Keep / Release buttons call handlers
  hideCatch(),
  toast(text, kind /* 'info'|'good'|'bad' */),
  openJournal(records), closeJournal(),
  // extras
  setLoading(p01, label), setPaused(bool), isModalOpen(),
  getCatchRect(),    // the catch card's layout box (DOMRect, viewport CSS px) while it is up, else null
}
```
The catch card is a bottom sheet when the window is <= 720 px wide (and taller than 520 px) or portrait
(aspect <= 0.85), otherwise a side panel on the right (landscape phones included). One CSS rule in the
template decides it; the showcase frames the fish from `getCatchRect()`, so they always agree. The prompt pill
and cast-power bar sit in a bottom band measured between the lure panel and the gauge, never over the middle
of the screen where the float and a hooked fish are.
Controls to surface: cast/reel (hold), drag (-/+ and scroll wheel, shown as lb of drag), lure picker (1-4),
time presets (Dawn 5:45, Morning 9:00, Noon 12:30, Dusk 19:40, Night 22:30), sound on/off, units (lb/in vs kg/cm),
journal (J), graphics quality (Auto / High / Medium / Low in the pause menu). Touch: a large hold-to-cast/reel
button with a small Slow toggle beside it (slow retrieve), drag buttons, lure chips; the canvas handles aim drags.
Lure notes and prompts never name a key that touch screens don't have.
Catch record shape:
```js
{ id, speciesId, speciesName, latin, weightKg, lengthCm, lureId, hours, caughtAt /* ISO */, kept }
```

### Core: `src/main.js` (+ `src/game/*.js`)
Renderer (antialias, `SRGBColorSpace`, `ACESFilmicToneMapping`, PCF soft shadows, pixel ratio <= 1.75 and
adaptive), `PerspectiveCamera(60, aspect, 0.1, 2500)` added to the scene, resize, visibility pause, fixed-substep
fight physics, the state machine in `STATES`, input (mouse aim without pointer lock: aim follows the pointer
with smoothing + A/D/arrow keys; hold left mouse / Space to charge + release to cast; hold to reel; click/space
during a bite to strike; scroll or [ ] for drag; 1-4 lures; J journal; M mute; Esc pause), touch input (drag to
aim, UI buttons for actions), records in `localStorage` (try/catch), the catch showcase (fish mesh held in front
of the camera, slowly turning, while the card is up), creation order and the frame loop:

```
env = createEnvironment(ctx); scenery = createScenery({...ctx, env}); water = createWater({...ctx, env});
fish = createFishSystem({...ctx, env, water}); tackle = createTackle({...ctx, env, water});
audio = createAudio(ctx); ui = createUI({ events, handlers, config })
loop: input -> hours -> env.setTimeOfDay/update -> scenery.update -> tackle.update -> fish.update ->
      fight substeps -> tackle.setFight/setRodLoad -> water.update -> audio.update -> ui.update -> render
```

Fight model (core, `src/game/fight.js`, 120 Hz substeps): `T = k_eff * max(0, |fish - rodTip| - lineOut)` + damping,
with `k_eff` 40-90 N/m from the angle between the rod (butt -> tip) and the line (soft with the rod bent away from
the line, stiff when it points straight at the fish). The drag breaks away at 1.08 x the setting after a ~50 ms
lag, then pays out line so T settles at the drag (`slipMps` > 0, the drag zings); cranking against a slipping drag
adds 12 % rotor friction. Reeling shortens `lineOut` only while the drag holds (`T < dragN`).
- Rod cushion: pointed down the line (rod . line > ~0.86..0.97) or held low (`rodLift01` < ~0.24) the rod is stiff
  (`stiff01` -> 1). Head shakes and jumps on a tight line with a stiff rod wear the hook hold (0.7..1 after the hookset,
  softer mouths wear faster: trout / walleye 1.25, pike / musky / catfish ~0.3); at 0 the hook PULLS OUT
  (escape 'headshake', `pulled: true`). Fish under 0.5 kg are exempt.
- Pump and wind: winding while lowering the rod after a lift gains up to +90 % line; winching a pulling fish with the
  rod pointed at it gains up to 40 % less.
- Side pressure (`input.rodSide` against the fish's lateral run, weight x3 of before) and a high rod tire the fish faster.
- Line twist: every metre the spool gives while the handle turns twists the line; from 8 m to 30 m of it the break
  strength falls by up to 35 % (it relaxes while the angler stops cranking). `T` over that break strength for > 0.12 s
  snaps the line; more than the spool's 150 m spools the angler.
- Slack (`T` under min(1 N, 0.1 m g) AND the line hanging loose by more than 0.25 m + 2 % of the line out) for
  > 2.5 s plus head shakes can throw the hook; slack > 5.5 s and it falls out. A small fish towed in on a steady
  retrieve (brief tugs on a nearly taut line) is not slack.
- When `lineOut < 3.2 m`, the fish is within 4.5 m of the dock and tired (stamina < 0.3, panfish < 0.5), LANDING
  (net) -> CAUGHT. A lure hit while the angler is holding the reel is a "reel set": it sets itself after 0.12 s of
  cranking (or when the angler lets go); the float rig always needs a strike, and a strike within 0.6 s of a nibble
  on the float is too early.

Clock: `DAY.gameMinutesPerSecond` = 0.25 (1 real second = 15 game seconds, an hour of light ~4 real minutes). It
runs only while fishing (READY, CHARGING, CASTING, WAITING, STRIKE, FIGHTING) and stands still while netting, on
the catch card, re-tying after a snap, after an escape, while paused / the journal is open and on the title.
Window blur during STRIKE / FIGHTING / LANDING pauses the game (not while a VR session starts or presents: then the
headset session's own visibility decides, XR.md). Quality: `onQuality('auto')` returns to adaptive
quality (stall-filtered median frame time, steps down and back up); a manual level applies fully and is saved.

Debug hooks for automated tests (must exist):
```js
window.__game = {
  get state(), get frame(),
  debug: {
    skipTitle(), setTime(h), setQuality(q), look(yawDeg, pitchDeg),
    cast(power01 = 0.8, yawDeg = 0),          // full cast via the real code path; resolves when it lands
                                              // (false if it has not landed within 20 s of game time)
    setReeling(bool), setDrag(01), setLure(id),
    forceBite(speciesId),                     // fish.debugForceBite
    strike(),                                 // hookset now
    hookFish(speciesId, weightKg),            // skip to FIGHTING with that fish
    landNow(),                                // skip to CAUGHT with the hooked fish
    stats(),                                  // { fps, drawCalls, triangles, geometries, textures, state, hours,
                                              //   lineOutM, tensionN, lure: {...}, hooked: {...} | null }
    // extras for scenarios: setTimeScale(k), setPixelRatio(p), setAutoQuality(on), setRod(side, lift),
    // slack(m), pause(p), action(down), keep(), release(), events(since), records(), fight, modules(), render()
    xr: { available(), enter(), exit(), status(), ... },   // VR: see XR.md "Debug hooks and testing"
  }
}
```

### XR additions (details in XR.md)
- `src/xr/`: `createXR(...)` (session, rig, input, haptics, XR quality; core wires it) and `createXRHud(...)`
  (world-space panels). Core handlers gain `onEnterVR()` (call inside the click), `onExitVR()`, `onRodHand(hand)`.
- UI: `setXRAvailable(bool)` (the Enter VR buttons), `setXRPresenting(bool)` (the page UI hidden and inert behind the
  headset, with a short note).
- Tackle: `setXRMode(on, { rodGrip, reelGrip, rodHand })`, `cast(power01, direction, { pitchRad })`,
  `predictLanding(power01, direction, target, { pitchRad })`, `getRodBase(target)`, `getReelHandle(target)`, `xrMode`.
- Showcase: `setXR(on, { holdGrip })` (the landed fish held in the reel hand), `xr`.
- Environment: `skylineOccluderAt(azimuth, out)` (the water's far-shore band in VR).
- Quality manager: `enterXR(level)`, `setXRLevel(q)`, `exitXR()`, `inXR`; `createXRAdaptive(...)`.
- `TACKLE.reelTurnsPerS` (config.js): handle turns per second at full retrieve (the reel animation and the VR crank).

## Testing

- `npm run build` bundles `src/main.js` into `dist/index.html` using `src/index.template.html`, and the same page in a
  full `<!doctype html>` skeleton into `dist/play.html` (for hosting on any HTTPS server, e.g. for a VR headset).
- Sandbox a single module: write `src/sandbox/<module>.js` (see `src/sandbox/stubs.js` for contract-shaped
  stubs of the environment and water), then
  `node build.mjs --entry src/sandbox/<module>.js --out dist/sandbox-<module>.html --template none`
  and `node tools/harness.mjs --file dist/sandbox-<module>.html --out out/<module> --size 960x540 --shots 2000,5000`.
- The harness uses SwiftShader (software WebGL): it is slow, so screenshot small (960x540) and keep runs short.
  It prints console errors and CSP violations and exits 1 on any error. Look at the PNGs with the Read tool.
- Scenarios (`tools/scenarios/*.mjs`, helpers in `lib.mjs`) wait in GAME time (`frame.time`) or rendered frames,
  never wall-clock time: a software-rendered frame can take seconds. Wall-clock limits are only a backstop.
- Scenarios: `--scenario path.mjs` exporting `default async ({ page, shot, sleep, log, game }) => {}`.
  The regression set: `boot`, `catch`, `snap`, `tour`, `soak` and `spot` (review-fix spot checks; `SPOT=water,glint`
  runs a subset) at `--size 960x540`, and `mobile` with `--mobile` (390x844) plus `--size 667x375` / `640x360`
  (short landscape phones: side-panel catch card), and `xr` with `--xr` (VR in the emulated Quest 3, XR.md).
  A transient moment (a heavy fight, the STRIKE cue) is frozen
  with `debug.pause(true)` before its screenshot, since one software-rendered frame can outlast it.
