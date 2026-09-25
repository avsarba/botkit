// WebXR session lifecycle (XR.md "Availability and hosting", "Session").
//  - detect(): `navigator.xr?.isSessionSupported('immersive-vr')`; anything but a clean `true` (no navigator.xr, false,
//    a rejection, a SecurityError from an iframe without `xr-spatial-tracking`) is "not available". Never throws.
//  - enter(): called from a click (the Enter VR button). requestSession is the FIRST thing it does, synchronously, so
//    the click's user activation is still there. `local-floor` is required; if the browser refuses it, a second request
//    without it falls back to a `local` reference space (the rig then adds a 1.6 m standing height).
//  - The session ends from exit(), the headset's system UI or a lost device: three.js' own 'sessionend' (dispatched
//    after it restored the canvas size / pixel ratio) runs onEnd, once, and every listener this module added is removed,
//    so entering and leaving can repeat without leaks.
export const XR_REQUIRED_FEATURES = ['local-floor'];
export const XR_OPTIONAL_FEATURES = ['bounded-floor', 'hand-tracking', 'layers'];
export const LOCAL_STANDING_HEIGHT_M = 1.6;

function xrSystem() {
  try {
    const xr = typeof navigator !== 'undefined' ? navigator.xr : null;
    return xr && typeof xr.isSessionSupported === 'function' && typeof xr.requestSession === 'function' ? xr : null;
  } catch {
    return null;
  }
}

// Resolves true only when immersive VR is really on offer. Never rejects, never throws.
export function detectXR() {
  const xr = xrSystem();
  if (!xr) return Promise.resolve(false);
  try {
    return Promise.resolve(xr.isSessionSupported('immersive-vr')).then(
      (v) => v === true,
      () => false
    );
  } catch {
    return Promise.resolve(false);
  }
}

export function createXRSession({ renderer, onStart, onEnd, onVisibility, onReset, onAvailability }) {
  let session = null; // the live session (from requestSession until its end)
  let started = false; // onStart ran for `session`
  let starting = false;
  let referenceSpaceType = null;
  let available = false;
  let detectP = null;
  let deviceListener = null;
  let refSpace = null;
  const call = (fn, ...a) => {
    if (typeof fn !== 'function') return undefined;
    try {
      return fn(...a);
    } catch (err) {
      console.error('[xr] session callback failed', err);
      return undefined;
    }
  };

  function detect() {
    if (detectP) return detectP;
    detectP = detectXR().then((ok) => {
      available = ok;
      return ok;
    });
    // a headset plugged in / taken away later: detect again and tell the UI
    const xr = xrSystem();
    if (xr && !deviceListener && typeof xr.addEventListener === 'function') {
      deviceListener = () => {
        detectXR().then((ok) => {
          if (ok === available) return;
          available = ok;
          detectP = Promise.resolve(ok);
          call(onAvailability, ok);
        });
      };
      try {
        xr.addEventListener('devicechange', deviceListener);
      } catch {
        deviceListener = null;
      }
    }
    return detectP;
  }

  function onSessionVisibility() {
    if (session) call(onVisibility, session.visibilityState);
  }
  function onRefReset() {
    call(onReset);
  }

  // three.js restores the drawing buffer size / pixel ratio, then dispatches 'sessionend'.
  function onThreeSessionEnd() {
    const s = session;
    if (!s) return;
    try {
      s.removeEventListener('visibilitychange', onSessionVisibility);
    } catch {
      /* ignore */
    }
    if (refSpace) {
      try {
        refSpace.removeEventListener('reset', onRefReset);
      } catch {
        /* ignore */
      }
    }
    refSpace = null;
    session = null;
    const was = started;
    started = false;
    if (was) call(onEnd);
  }
  renderer.xr.addEventListener('sessionend', onThreeSessionEnd);

  function request(xr, init) {
    try {
      return Promise.resolve(xr.requestSession('immersive-vr', init));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // opts: { framebufferScale, foveation } from the XR quality profile. Resolves true once presenting.
  function enter(opts = {}) {
    if (session || starting) return Promise.resolve(!!(session && started));
    const xr = xrSystem();
    if (!xr) return Promise.resolve(false);
    starting = true;
    // (synchronously, inside the click)
    const first = request(xr, { requiredFeatures: XR_REQUIRED_FEATURES, optionalFeatures: XR_OPTIONAL_FEATURES });
    return first
      .then(
        (s) => ({ s, type: 'local-floor' }),
        (err) => {
          // not allowed at all (permissions policy / no activation): don't try again
          if (err && (err.name === 'SecurityError' || err.name === 'InvalidStateError')) throw err;
          return request(xr, { optionalFeatures: XR_OPTIONAL_FEATURES }).then((s) => ({ s, type: 'local' }));
        }
      )
      .then(async ({ s, type }) => {
        session = s;
        referenceSpaceType = type;
        renderer.xr.setReferenceSpaceType(type);
        if (Number.isFinite(opts.framebufferScale)) renderer.xr.setFramebufferScaleFactor(opts.framebufferScale);
        if (Number.isFinite(opts.foveation)) renderer.xr.setFoveation(opts.foveation);
        try {
          await renderer.xr.setSession(s);
        } catch (err) {
          // e.g. the reference space was refused after all: end what was started and give up
          try {
            await s.end();
          } catch {
            /* already ended */
          }
          throw err;
        }
        if (session !== s) return false; // ended while it was starting
        s.addEventListener('visibilitychange', onSessionVisibility);
        refSpace = renderer.xr.getReferenceSpace();
        if (refSpace && typeof refSpace.addEventListener === 'function') refSpace.addEventListener('reset', onRefReset);
        started = true;
        starting = false;
        call(onStart, { referenceSpaceType: type, session: s });
        return true;
      })
      .catch((err) => {
        console.warn('[xr] could not start VR:', err && (err.message || err.name || err));
        return false;
      })
      .finally(() => {
        starting = false;
      });
  }

  function exit() {
    const s = session;
    if (!s) return Promise.resolve(false);
    try {
      return Promise.resolve(s.end()).then(
        () => true,
        () => false
      );
    } catch {
      return Promise.resolve(false);
    }
  }

  function dispose() {
    renderer.xr.removeEventListener('sessionend', onThreeSessionEnd);
    const xr = xrSystem();
    if (xr && deviceListener) {
      try {
        xr.removeEventListener('devicechange', deviceListener);
      } catch {
        /* ignore */
      }
    }
    deviceListener = null;
  }

  return {
    detect,
    enter,
    exit,
    dispose,
    get available() {
      return available;
    },
    get presenting() {
      return !!(session && started);
    },
    get starting() {
      return starting;
    },
    get session() {
      return session;
    },
    get referenceSpaceType() {
      return session ? referenceSpaceType : null;
    },
    // nominal display rate (Hz) of the running session, for adaptive quality
    get frameRate() {
      const fr = session && session.frameRate;
      return Number.isFinite(fr) && fr > 20 ? fr : 72;
    },
  };
}
