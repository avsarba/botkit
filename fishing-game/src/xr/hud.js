// World-space UI for the VR mode (XR.md "World-space UI"): DOM overlays are not visible in a headset,
// so while presenting the HUD lives on canvas-textured, unlit planes:
//   - wrist gauge on the reel hand (tension dial, drag marker, red zone, line out, drag, lure, clock, fish on)
//   - head-lazy prompt strip (hud.prompt, VR wording) + the STRIKE cue + toasts
//   - catch card beside the reel hand (which holds the fish), Keep / Release
//   - VR menu (pause) and the journal
//   - controller rays with hover highlight, a haptic tick and select(hand) hit-testing
// Same tokens and fonts as the DOM UI (read from the template's :root), redrawn only on change (<= 15 Hz).
//
// createXRHud({ renderer, scene, camera, events, handlers, species, config }) -> {
//   setActive(on, { rodGrip, reelGrip, rodRay, reelRay, rig }), update(hud, frame, xin), strikeCue(opts),
//   showCatch(record, flags), hideCatch(), openMenu(state), closeMenu(), isMenuOpen(), openJournal(records),
//   closeJournal(), toast(text, kind), select(hand) -> bool, get pointerOverPanel(), dispose() }
// `handlers` is the DOM UI's handler object plus onExitVR() and onRodHand(hand).
import * as THREE from 'three';
import { STATES, LURES } from '../config.js';
import { FIELD_GUIDE } from '../ui/fieldguide.js';
import { normUnits } from '../ui/index.js';
import { readTokens, loadFonts } from './panels/tokens.js';
import { createWristGauge } from './panels/wrist.js';
import { createPromptStrip } from './panels/prompt.js';
import { createCatchCard } from './panels/card.js';
import { createMenu } from './panels/menu.js';
import { createJournal } from './panels/journal.js';
import { createRays } from './panels/rays.js';

const DEG = Math.PI / 180;
const PRESS_MS = 140;
const CARD_SIDE_M = 0.24; // catch card centre beside the reel hand
const CARD_MIN_M = 0.62; // ... and this far from the eyes at least
const CARD_MAX_M = 0.9;
const PROMPT_KINDS = new Set(['info', 'ready', 'good', 'warn', 'danger']);
const LURE_BY_ID = Object.freeze(Object.fromEntries(LURES.map((l) => [l.id, l])));
const normKind = (k) => (k === 'bad' ? 'danger' : k === 'warning' ? 'warn' : PROMPT_KINDS.has(k) ? k : 'info');
const otherHand = (h) => (h === 'left' ? 'right' : 'left');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Prompts written for mouse / touch (core's hud.prompt) name controls a headset does not have.
// Known phrases are reworded for the controllers; anything still naming a desktop control falls back to
// the VR prompt for the state.
const DESKTOP_WORDS = /\b(click|clicks|mouse|shift|scroll|wheel|tap|taps|esc|keyboard|key|keys)\b|\bhold reel\b|\bdrag (?:up|down|left|right|on|sideways)\b|\[\s*\]|\[|\(\s*[AD]\s*\)|\bbuttons? set\b|\b[−-] \/ \+/i;
function vrRewrites(reelT) {
  return [
    [/\bhold Shift and reel\b/gi, 'light pressure on the reel trigger'],
    [/\bShift \+ hold for a slow walk\b/gi, 'light reel trigger for a slow walk'],
    [/\bShift for a slow(?:er)? retrieve\b/gi, 'light pressure for a slow retrieve'],
    [/\bclick when it goes under\b/gi, 'sweep the rod up when it goes under'],
    [/\b(?:mouse|drag) up (?:to lift it|lifts the rod|to lift the rod|to keep the rod high)\b/gi, 'raise the rod'],
    [/\b(?:mouse|drag) (left|right)(?: \([AD]\))? for side pressure\b/gi, 'sweep the rod $1 for side pressure'],
    [/\bScroll or \[ \] sets the drag\b/gi, 'The rod thumbstick sets the drag'],
    [/\bThe [−-] \/ \+ buttons set the drag\b/gi, 'The rod thumbstick sets the drag'],
    [/\bStop reeling, loosen the drag\b/gi, 'Stop reeling, thumbstick down loosens the drag'],
    [/\bLoosen the drag: wheel down or \[/gi, 'Thumbstick down loosens the drag'],
    [/\bHold to crank\b/gi, `${reelT} to crank`],
    [/\bhold to reel in\b/gi, `${reelT} to reel in`],
    [/\bHold to reel\b/gi, `${reelT} to reel`],
  ];
}

export function createXRHud(ctx = {}) {
  const { renderer = null, scene = null, camera = null, events = null } = ctx;
  const handlers = ctx.handlers || {};
  const config = ctx.config || {};
  const speciesList = Array.isArray(ctx.species) ? ctx.species : Array.isArray(config.species) ? config.species : null;
  // real-time clock for fades and timers (the game clock stops while paused; the panels must not).
  // ctx.now may inject one (tests freeze a transient moment such as the STRIKE flash).
  const clock = typeof ctx.now === 'function' ? ctx.now : () => performance.now();

  function call(name, ...args) {
    const fn = handlers[name];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn(...args);
    } catch (err) {
      console.error(`[xr-hud] handler ${name} threw`, err);
      return undefined;
    }
  }
  function speciesInfo(id, record) {
    const s = speciesList ? speciesList.find((x) => x && x.id === id) : null;
    const f = FIELD_GUIDE[id];
    return {
      name: (record && record.speciesName) || (s && s.name) || (f && f.name) || String(id || 'Unknown fish').replace(/_/g, ' '),
      latin: (record && record.latin) || (s && s.latin) || (f && f.latin) || '',
      blurb: (record && record.blurb) || (s && s.blurb) || (f && f.blurb) || '',
    };
  }

  // ---------- state ----------
  const cur = {
    active: false,
    rodHand: config.rodHand === 'left' ? 'left' : 'right',
    units: normUnits(config.units),
    muted: !!config.muted,
    lureId: LURES[0].id,
    hours: 6,
    state: STATES.READY,
    records: Array.isArray(config.records) ? config.records : [],
    menuOpen: false,
    journalOpen: false,
    catchOpen: false,
    lastPaused: null,
    pointerOver: false,
    fontsReady: false,
  };
  let refs = {};
  let lastHud = null;
  let lastNow = 0;
  let built = null;
  let rewrites = vrRewrites('Left trigger');
  let rewritesHand = 'right';

  // scratch (no per-frame allocation)
  const invRoot = new THREE.Matrix4();
  const headM = new THREE.Matrix4();
  const headPos = new THREE.Vector3();
  const headQuat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const cardPos = new THREE.Vector3();
  const cardTarget = new THREE.Vector3();
  let headYaw = 0;
  let headPitch = 0;
  let cardSnap = true;
  const hoverKey = { rod: '', reel: '' };

  // ---------- fonts ----------
  let fontsListening = false;
  const onFontsDone = () => invalidateAll();
  function ensureFonts() {
    if (!fontsListening && typeof document !== 'undefined' && document.fonts && document.fonts.addEventListener) {
      document.fonts.addEventListener('loadingdone', onFontsDone);
      fontsListening = true;
    }
    loadFonts().then(() => {
      cur.fontsReady = true;
      invalidateAll();
    });
  }
  function invalidateAll() {
    if (built) for (const p of built.panels) p.invalidate();
  }

  // ---------- menu actions (the DOM handlers, plus the VR ones) ----------
  const actions = {
    resume() {
      closeMenu();
      call('onPause', false);
    },
    lure(id) {
      cur.lureId = id;
      syncMenu();
      call('onLure', id);
    },
    time(h) {
      cur.hours = h;
      syncMenu();
      call('onTimePreset', h);
    },
    mute(m) {
      if (m === cur.muted) return;
      cur.muted = m;
      syncMenu();
      call('onMute', m);
    },
    units(u) {
      if (u === cur.units) return;
      applyUnits(u);
      call('onUnits', u);
    },
    rodHand(hand) {
      if (hand === cur.rodHand) return;
      setRodHandLocal(hand);
      call('onRodHand', hand);
    },
    journal() {
      call('onJournal', true);
      if (!cur.journalOpen) openJournal(cur.records); // core may answer with openJournal(records) itself
    },
    exit() {
      call('onExitVR');
    },
  };

  function build() {
    if (built) return built;
    const tk = readTokens();
    const wrist = createWristGauge(tk);
    const strip = createPromptStrip(tk);
    const card = createCatchCard(tk, { speciesInfo, onKeep: keep, onRelease: release });
    const menu = createMenu(tk, actions);
    const journal = createJournal(tk, { speciesInfo, species: speciesList, onClose: userCloseJournal });
    const rays = createRays(tk);
    const root = new THREE.Group();
    root.name = 'xr-hud';
    root.add(strip.anchor, strip.strikeGroup, card.panel.object, menu.panel.object, journal.panel.object);
    built = {
      tk,
      root,
      wrist,
      strip,
      card,
      menu,
      journal,
      rays,
      interactive: [menu.panel, journal.panel, card.panel],
      panels: [wrist.panel, ...strip.panels, card.panel, menu.panel, journal.panel],
    };
    return built;
  }

  // ---------- activation ----------
  function setActive(on, r = {}) {
    if (!on) {
      if (!built) {
        cur.active = false;
        return;
      }
      cur.active = false;
      built.root.removeFromParent();
      built.wrist.mount.removeFromParent();
      built.rays.detach();
      // leaving VR: the panels close quietly (the DOM UI takes over in the current state)
      cur.menuOpen = cur.journalOpen = cur.catchOpen = false;
      for (const p of built.panels) {
        p.setWanted(false);
        p.hover.clear();
      }
      built.strip.reset();
      built.strip.clearToasts();
      cur.pointerOver = false;
      hoverKey.rod = hoverKey.reel = '';
      refs = {};
      return;
    }
    const b = build();
    refs = { ...r };
    const parent = refs.rig || (camera && camera.parent) || scene;
    if (parent && b.root.parent !== parent) parent.add(b.root);
    b.wrist.mount.removeFromParent();
    if (refs.reelGrip && refs.reelGrip.add) refs.reelGrip.add(b.wrist.mount);
    b.wrist.setHand(otherHand(cur.rodHand));
    b.rays.attach(refs.rodRay, refs.reelRay);
    if (typeof r.rodHand === 'string') setRodHandLocal(r.rodHand);
    if (!cur.active) {
      b.strip.reset();
      cur.lastPaused = null;
    }
    cur.active = true;
    lastNow = 0;
    ensureFonts();
  }

  function setRodHandLocal(hand) {
    hand = hand === 'left' ? 'left' : 'right';
    if (hand === cur.rodHand) return;
    cur.rodHand = hand;
    if (built) {
      built.wrist.setHand(otherHand(hand));
      built.card.set(cur.units, hand);
    }
    syncMenu();
  }
  function applyUnits(u) {
    u = normUnits(u);
    if (u === cur.units) return;
    cur.units = u;
    if (built) {
      built.card.set(u, cur.rodHand);
      built.journal.set(cur.records, u);
    }
    syncMenu();
  }
  function syncMenu() {
    if (!built) return;
    built.menu.set({ lureId: cur.lureId, hours: Math.floor(cur.hours * 60) / 60, muted: cur.muted, units: cur.units, rodHand: cur.rodHand });
  }

  // ---------- head pose (root-local: the rig's tracking space) ----------
  function readHead() {
    const root = built.root;
    if (!camera) return;
    root.updateWorldMatrix(true, false);
    invRoot.copy(root.matrixWorld).invert();
    headM.multiplyMatrices(invRoot, camera.matrixWorld);
    headM.decompose(headPos, headQuat, scl);
    fwd.set(0, 0, -1).applyQuaternion(headQuat);
    up.set(0, 1, 0).applyQuaternion(headQuat);
    // looking straight down / up the view direction has no heading: the top of the head gives it
    const x = fwd.x - up.x * fwd.y;
    const z = fwd.z - up.z * fwd.y;
    if (x * x + z * z > 1e-6) headYaw = Math.atan2(-x, -z);
    headPitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
  }
  // how far below eye level a menu / page opens: where the player is looking, within a comfortable band
  const dropFor = (minDeg, maxDeg) => Math.max(minDeg * DEG, Math.min(maxDeg * DEG, -headPitch));
  // Put a panel `dist` ahead of the head along its heading, `drop` below eye level, facing the eyes.
  function placeFront(obj, dist, drop) {
    const fx = -Math.sin(headYaw);
    const fz = -Math.cos(headYaw);
    obj.position.set(headPos.x + fx * dist * Math.cos(drop), headPos.y - dist * Math.sin(drop), headPos.z + fz * dist * Math.cos(drop));
    faceHead(obj);
  }
  function faceHead(obj) {
    const dx = headPos.x - obj.position.x;
    const dy = headPos.y - obj.position.y;
    const dz = headPos.z - obj.position.z;
    obj.rotation.set(-Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0, 'YXZ');
  }

  // ---------- prompts (VR wording) ----------
  const pr = { text: '', kind: 'info' }; // scratch result
  const say = (text, kind) => {
    pr.text = text;
    pr.kind = kind;
    return pr;
  };
  function vrPrompt(state, h) {
    const reelT = cur.rodHand === 'left' ? 'Right trigger' : 'Left trigger';
    const L = LURE_BY_ID[h.lureId || cur.lureId];
    switch (state) {
      case STATES.READY:
        return say('Hold the trigger, swing the rod forward and let go to cast', 'ready');
      case STATES.CHARGING:
        return say('Swing forward and let go of the trigger', 'ready');
      case STATES.WAITING:
        if (!L || L.kind === 'bait') return say('Watch the float · sweep the rod up when it goes under', 'info');
        if (L.id === 'topwater') return say(`${reelT} in short bursts to walk it · pause now and then`, 'info');
        return say(`${reelT} to reel · light pressure for a slow retrieve`, 'info');
      case STATES.STRIKE:
        return say('Sweep the rod up to set the hook', 'danger');
      case STATES.FIGHTING: {
        const lvl = built ? built.wrist.level : 0;
        if (lvl === 2) return say('Too much tension! Stop reeling · thumbstick down loosens the drag', 'danger');
        if (lvl === 1) return say('Heavy load. Thumbstick down loosens the drag', 'warn');
        if (Number.isFinite(h.fishStamina01) && h.fishStamina01 < 0.25) return say('Fish is tiring. Keep it coming', 'good');
        return say(`Fish on! Keep the rod up · ${reelT.toLowerCase()} to reel`, 'good');
      }
      case STATES.LANDING:
        return say('Netting the fish', 'good');
      case STATES.SNAPPED:
        return say('Line snapped. Re-tying', 'danger');
      case STATES.ESCAPED:
        return say('The fish got off', 'warn');
      default:
        return say('', 'info');
    }
  }
  // core's prompt reworded for the controllers (cached: core sends the same string every frame)
  const rw = { raw: null, hand: '', out: null };
  function promptFor(state, h) {
    if (h && h.prompt != null) {
      // (like the DOM: null lets the HUD derive the prompt, '' shows none)
      const raw = String(h.prompt);
      if (rw.raw === raw && rw.hand === cur.rodHand) {
        if (rw.out === null) return vrPrompt(state, h);
        return say(rw.out, normKind(h.promptKind));
      }
      rw.raw = raw;
      rw.hand = cur.rodHand;
      let text = raw;
      if (DESKTOP_WORDS.test(text)) {
        if (rewritesHand !== cur.rodHand) {
          rewritesHand = cur.rodHand;
          rewrites = vrRewrites(`${cap(otherHand(cur.rodHand))} trigger`);
        }
        for (const [re, to] of rewrites) {
          text = text.replace(re, (m, ...g) => {
            const out = typeof to === 'string' ? to.replace('$1', g[0] ?? '') : to;
            return m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase() ? cap(out) : out.charAt(0).toLowerCase() + out.slice(1);
          });
        }
        if (DESKTOP_WORDS.test(text)) {
          rw.out = null;
          return vrPrompt(state, h);
        }
      }
      rw.out = text;
      return say(text, normKind(h.promptKind));
    }
    return vrPrompt(state, h);
  }

  // ---------- per frame ----------
  function update(hud, frame, xin) {
    if (!cur.active || !built) return;
    const now = clock();
    const dt = lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0;
    lastNow = now;
    if (hud && typeof hud === 'object') lastHud = hud;
    const h = lastHud || {};
    const b = built;

    // settings and state from the frame's hud
    const state = h.state || (frame && frame.state) || cur.state;
    if (state !== cur.state) {
      if (cur.state === STATES.STRIKE && b.strip.striking) b.strip.cutStrike(now);
      cur.state = state;
    }
    if (h.units != null) applyUnits(h.units);
    if (typeof h.muted === 'boolean' && h.muted !== cur.muted) cur.muted = h.muted;
    if (h.lureId) cur.lureId = h.lureId;
    if (Number.isFinite(h.hours)) cur.hours = h.hours;
    if (Array.isArray(h.catches) && h.catches !== cur.records) {
      cur.records = h.catches;
      if (cur.journalOpen) b.journal.set(cur.records, cur.units);
    }
    if (xin && (xin.rodHand === 'left' || xin.rodHand === 'right')) setRodHandLocal(xin.rodHand);
    // follow the game's pause (edges only, so a core that pauses some other way is never fought)
    if (typeof h.paused === 'boolean') {
      if (cur.lastPaused !== null && h.paused !== cur.lastPaused) {
        if (h.paused && !cur.menuOpen) openMenu();
        else if (!h.paused && (cur.menuOpen || cur.journalOpen)) {
          closeJournal();
          closeMenu();
        }
      }
      cur.lastPaused = h.paused;
    }
    if (cur.menuOpen) syncMenu();

    readHead();
    const modal = cur.menuOpen || cur.journalOpen;
    const playing = state !== STATES.CAUGHT && state !== STATES.TITLE;

    // prompt strip + strike + toasts
    b.strip.place(headPos, headYaw, dt);
    const p = promptFor(state, h);
    const kind = p.kind;
    const text = b.strip.striking ? '' : p.text; // the strike cue carries the message
    const quietOk = (kind === 'info' || kind === 'good') && (state === STATES.WAITING || state === STATES.FIGHTING);
    b.strip.setPrompt(text, kind, { eligibleQuiet: quietOk, now, blink: kind === 'danger' && now % 500 >= 250 });
    b.strip.update(now, dt, !modal && playing, state !== STATES.TITLE); // toasts also confirm menu picks

    // wrist gauge
    b.wrist.set(wristFields(h, state), now);
    b.wrist.panel.setWanted(playing && !!b.wrist.mount.parent);

    // catch card beside the reel hand (the fish is in it), facing the player
    if (cur.catchOpen) placeCard(dt);

    // rays: only while something to point at is up
    const rayWanted = cur.menuOpen || cur.journalOpen || cur.catchOpen;
    const hits = b.rays.update(b.interactive, rayWanted);
    updateHover(hits);
    cur.pointerOver = !!(hits.rod || hits.reel);

    // pressed-state expiry, then redraws (<= 15 Hz each, only when something changed)
    for (const pn of b.interactive) {
      if (pn.pressId && now >= pn.pressUntil) {
        pn.pressId = null;
        pn.invalidate();
      }
    }
    if (cur.fontsReady) for (const pn of b.panels) if (pn.want || pn.dirty) pn.flush(now);
  }
  // the subset of hud the wrist reads (a reused object: no per-frame garbage)
  const wristHud = {};
  function wristFields(h, state) {
    wristHud.state = state;
    wristHud.units = cur.units;
    wristHud.tensionN = h.tensionN;
    wristHud.tension01 = h.tension01;
    wristHud.dragN = h.dragN;
    wristHud.drag01 = h.drag01;
    wristHud.lineOutM = h.lineOutM;
    wristHud.fishOn = h.fishOn;
    wristHud.fishDistanceM = h.fishDistanceM;
    wristHud.lureId = h.lureId || cur.lureId;
    wristHud.hours = Number.isFinite(h.hours) ? h.hours : cur.hours;
    wristHud.slackLine = h.slackLine;
    return wristHud;
  }

  function placeCard(dt) {
    const obj = built.card.panel.object;
    const grip = refs.reelGrip;
    let hand = null;
    if (grip && grip.visible !== false) {
      grip.updateWorldMatrix(true, false);
      hand = tmp.setFromMatrixPosition(grip.matrixWorld).applyMatrix4(invRoot);
    }
    if (hand) {
      // beside the hand, toward the player's midline, and a little beyond it (so the hanging fish never
      // pokes through the card, and the card never sits closer than ~0.6 m to the eyes)
      const side = otherHand(cur.rodHand) === 'left' ? 1 : -1;
      const rx = Math.cos(headYaw);
      const rz = -Math.sin(headYaw);
      cardTarget.set(hand.x + rx * side * CARD_SIDE_M, hand.y - 0.02, hand.z + rz * side * CARD_SIDE_M);
      tmp.subVectors(cardTarget, headPos);
      const d = tmp.length() || 1;
      const want = Math.min(CARD_MAX_M, Math.max(CARD_MIN_M, d + 0.12));
      cardTarget.copy(headPos).addScaledVector(tmp, want / d);
      cardTarget.y = Math.min(cardTarget.y, headPos.y - 0.06); // not above eye level
    } else {
      // no tracked hand: in front of the player, a little to the reel-hand side
      const fx = -Math.sin(headYaw);
      const fz = -Math.cos(headYaw);
      const side = otherHand(cur.rodHand) === 'left' ? -1 : 1;
      cardTarget.set(headPos.x + fx * 0.6 + Math.cos(headYaw) * side * 0.12, headPos.y - 0.28, headPos.z + fz * 0.6 - Math.sin(headYaw) * side * 0.12);
    }
    if (cardSnap) {
      cardPos.copy(cardTarget);
      cardSnap = false;
    } else cardPos.lerp(cardTarget, 1 - Math.exp(-7 * Math.min(dt, 0.1)));
    obj.position.copy(cardPos);
    faceHead(obj);
  }

  function updateHover(hits) {
    const b = built;
    for (const p of b.interactive) {
      let changed = false;
      const next = hoverNext;
      next.clear();
      for (const role of ['rod', 'reel']) {
        const hh = hits[role];
        if (hh && hh.panel === p && hh.button) next.add(hh.button.id);
      }
      if (next.size !== p.hover.size) changed = true;
      else for (const id of next) if (!p.hover.has(id)) changed = true;
      if (changed) {
        p.hover.clear();
        for (const id of next) p.hover.add(id);
        p.invalidate();
      }
    }
    for (const role of ['rod', 'reel']) {
      const hh = hits[role];
      const k = hh && hh.button ? `${hh.panel.name}:${hh.button.id}` : '';
      if (k && k !== hoverKey[role]) haptic(role, 0.1, 10);
      hoverKey[role] = k;
    }
  }
  const hoverNext = new Set();

  // ---------- haptics (UI hover / press: 0.1 x 10 ms), always guarded ----------
  function haptic(role, intensity, ms) {
    const hand = role === 'rod' ? cur.rodHand : role === 'reel' ? otherHand(cur.rodHand) : role;
    try {
      if (ctx.haptics && typeof ctx.haptics.pulse === 'function') {
        ctx.haptics.pulse(hand, intensity, ms, 'ui');
        return;
      }
      const session = renderer && renderer.xr && typeof renderer.xr.getSession === 'function' ? renderer.xr.getSession() : null;
      if (!session || !session.inputSources) return;
      for (const src of session.inputSources) {
        if (!src || src.handedness !== hand || !src.gamepad) continue;
        const gp = src.gamepad;
        const a = gp.hapticActuators && gp.hapticActuators[0];
        let p = null;
        if (a && typeof a.pulse === 'function') p = a.pulse(intensity, ms);
        else if (gp.vibrationActuator && typeof gp.vibrationActuator.playEffect === 'function') {
          p = gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity });
        }
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch {
      /* haptics are a nicety */
    }
  }

  // ---------- select: a trigger press from core ----------
  function roleOf(hand) {
    if (hand === 'rod' || hand === 'reel') return hand;
    if (hand === 'left' || hand === 'right') return hand === cur.rodHand ? 'rod' : 'reel';
    return null;
  }
  function select(hand) {
    if (!cur.active || !built) return false;
    const hits = built.rays.hits;
    const role = roleOf(hand);
    const hit = role ? hits[role] : hits.rod || hits.reel;
    if (!hit) return false;
    if (hit.button) press(hit.panel, hit.button, role || (hits.rod === hit ? 'rod' : 'reel'));
    return true; // a press on a panel never reaches the game, even between buttons
  }
  function press(panel, button, role) {
    const now = clock();
    panel.pressId = button.id;
    panel.pressUntil = now + PRESS_MS;
    panel.invalidate();
    haptic(role, 0.1, 10);
    if (events && typeof events.emit === 'function') events.emit('ui:click', {});
    try {
      if (typeof button.press === 'function') button.press();
    } catch (err) {
      console.error('[xr-hud] button threw', err);
    }
  }

  // ---------- catch card ----------
  function showCatch(record, flags = {}) {
    if (!record || typeof record !== 'object' || !cur.active) return;
    const b = build();
    const wasOpen = cur.catchOpen;
    cur.catchOpen = true;
    b.card.show(record, flags, cur.units, cur.rodHand, clock());
    if (!wasOpen) cardSnap = true;
    b.card.panel.setWanted(true);
    ensureFonts();
  }
  function hideCatch() {
    if (!cur.catchOpen) return;
    cur.catchOpen = false;
    if (built) {
      built.card.panel.setWanted(false);
      built.card.panel.hover.clear();
    }
  }
  function keep() {
    if (!cur.catchOpen) return;
    call('onKeep');
    hideCatch();
  }
  function release() {
    if (!cur.catchOpen) return;
    call('onRelease');
    hideCatch();
  }

  // ---------- menu ----------
  function openMenu(s) {
    if (!cur.active) return;
    const b = build();
    if (s && typeof s === 'object') {
      if (s.units != null) applyUnits(s.units);
      if (typeof s.muted === 'boolean') cur.muted = s.muted;
      if (s.lureId) cur.lureId = s.lureId;
      if (Number.isFinite(s.hours)) cur.hours = s.hours;
      if (s.rodHand === 'left' || s.rodHand === 'right') setRodHandLocal(s.rodHand);
      if (Array.isArray(s.records)) cur.records = s.records;
    }
    syncMenu();
    const wasOpen = cur.menuOpen;
    cur.menuOpen = true;
    if (!wasOpen || !b.menu.panel.want) {
      readHead();
      placeFront(b.menu.panel.object, 1.0, dropFor(6, 26));
    }
    if (!cur.journalOpen) b.menu.panel.setWanted(true);
    b.menu.panel.invalidate();
    ensureFonts();
  }
  function closeMenu() {
    if (!cur.menuOpen) return;
    cur.menuOpen = false;
    if (built) {
      built.menu.panel.setWanted(false);
      built.menu.panel.hover.clear();
    }
    if (cur.journalOpen) closeJournal();
  }

  // ---------- journal ----------
  function openJournal(records) {
    if (!cur.active) return;
    const b = build();
    if (Array.isArray(records)) cur.records = records;
    b.journal.set(cur.records, cur.units);
    const wasOpen = cur.journalOpen;
    cur.journalOpen = true;
    if (!wasOpen) {
      readHead();
      placeFront(b.journal.panel.object, 1.15, dropFor(4, 22));
    }
    b.menu.panel.setWanted(false); // the page replaces the menu while it is up
    b.journal.panel.setWanted(true);
    b.journal.panel.invalidate();
    ensureFonts();
  }
  function closeJournal() {
    if (!cur.journalOpen) return;
    cur.journalOpen = false;
    if (built) {
      built.journal.panel.setWanted(false);
      built.journal.panel.hover.clear();
      if (cur.menuOpen) built.menu.panel.setWanted(true); // back to the menu it was opened from
    }
  }
  function userCloseJournal() {
    if (!cur.journalOpen) return;
    closeJournal();
    call('onJournal', false);
  }

  // ---------- strike cue + toasts ----------
  function strikeCue(opts = {}) {
    if (!cur.active || !built) return;
    const key = cur.rodHand === 'left' ? 'X' : 'A';
    const sub = opts && opts.reelSet ? 'Keep reeling!' : `Sweep the rod up · or press ${key}`;
    readHead();
    built.strip.strikeCue(sub, headPos, headYaw, clock());
  }
  function toast(text, kind = 'info', ms) {
    if (!cur.active || !built || !text) return;
    built.strip.toast(text, kind, ms, clock());
  }

  function dispose() {
    setActive(false);
    if (fontsListening && document.fonts && document.fonts.removeEventListener) document.fonts.removeEventListener('loadingdone', onFontsDone);
    fontsListening = false;
    if (built) {
      built.wrist.dispose();
      built.strip.dispose();
      built.card.dispose();
      built.menu.dispose();
      built.journal.dispose();
      built.rays.dispose();
      built.root.removeFromParent();
      built = null;
    }
  }

  return {
    setActive,
    update,
    strikeCue,
    showCatch,
    hideCatch,
    openMenu,
    closeMenu,
    isMenuOpen: () => cur.menuOpen,
    openJournal,
    closeJournal,
    toast,
    select,
    get pointerOverPanel() {
      return !!(cur.active && cur.pointerOver);
    },
    dispose,
    // extras (not in XR.md; safe to ignore)
    isJournalOpen: () => cur.journalOpen,
    isCatchOpen: () => cur.catchOpen,
    isModalOpen: () => cur.menuOpen || cur.journalOpen || cur.catchOpen,
    setRodHand: (hand) => setRodHandLocal(hand),
    // which hand's ray is over a panel ('rod' | 'reel' | null)
    get pointerHand() {
      if (!built || !cur.active) return null;
      return built.rays.hits.rod ? 'rod' : built.rays.hits.reel ? 'reel' : null;
    },
    status() {
      const hits = built ? built.rays.hits : { rod: null, reel: null };
      const hv = (x) => (x ? { panel: x.panel.name, button: x.button ? x.button.id : null } : null);
      return {
        active: cur.active,
        fontsReady: cur.fontsReady,
        rodHand: cur.rodHand,
        menuOpen: cur.menuOpen,
        journalOpen: cur.journalOpen,
        catchOpen: cur.catchOpen,
        pointerOverPanel: !!(cur.active && cur.pointerOver),
        hover: { rod: hv(hits.rod), reel: hv(hits.reel) },
        prompt: built ? built.strip.promptText : '',
        promptAlpha: built ? Math.round(built.strip.promptAlpha * 100) / 100 : 0,
        striking: built ? built.strip.striking : false,
        headYawDeg: Math.round((headYaw / DEG) * 10) / 10,
        stripYawDeg: built ? Math.round((built.strip.anchor.rotation.y / DEG) * 10) / 10 : 0,
      };
    },
    // for sandboxes / tests: panel objects by name
    get debugPanels() {
      if (!built) return null;
      return {
        root: built.root,
        wrist: built.wrist.panel,
        prompt: built.strip.panels[0],
        strike: built.strip.panels[1],
        card: built.card.panel,
        menu: built.menu.panel,
        journal: built.journal.panel,
      };
    },
  };
}
