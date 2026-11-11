// The ?fps speed readout. RetroArch's own counter (fps_show) isn't drawn in
// every browser (not on iPhone), so this measures the emulator from outside.
//
// RetroArch's main loop can be paced by requestAnimationFrame, setTimeout or
// postMessage depending on its settings, so instead of hooking one of those
// this watches the game canvas's WebGL context: each main-loop iteration is
// its own browser task and draws the screen, so a task that draws = one frame
// on screen. Shows frames drawn per second (60 = full speed; frameskip=1 tops
// out at 30 by design) and, for those frames, how long the emulator's task ran
// (ms out of the 16.7 ms a frame has at 60 fps), then how many times a second
// requestAnimationFrame and setTimeout callbacks ran.
export function startFpsMeter(container) {
  const label = document.createElement('div');
  label.className = 'fps-meter';
  label.textContent = '-- fps';
  container.append(label);

  let frames = 0;
  let busy = 0;
  let worst = 0;
  let inFrame = false;
  let frameStart = 0;

  // Called on every WebGL draw: the first one in a task starts a frame, and a
  // timer queued behind it ends it once the rest of the task has run.
  function onDraw() {
    if (inFrame) return;
    inFrame = true;
    frameStart = lastTaskStart;
    queueMicrotask(endFrame);
  }
  function endFrame() {
    // Microtasks run at the end of the current task, after the emulator's
    // frame function has returned.
    const spent = performance.now() - frameStart;
    inFrame = false;
    frames += 1;
    busy += spent;
    worst = Math.max(worst, spent);
  }

  // Best estimate of when the current task began: the emulator's frame
  // function draws near its end, so time it from the task's first JS. Every
  // task the emulator runs goes through one of these.
  // Also counts how often each kind of callback runs, which shows what the
  // browser is pacing the emulator with (and whether it's being throttled).
  let lastTaskStart = performance.now();
  const calls = { raf: 0, timer: 0 };
  const stamp = (fn, kind) => function stamped(...args) {
    lastTaskStart = performance.now();
    calls[kind] += 1;
    return fn.apply(this, args);
  };
  const nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => nativeRaf(stamp(cb, 'raf'));
  const nativeTimeout = window.setTimeout.bind(window);
  window.setTimeout = (cb, ...rest) => nativeTimeout(typeof cb === 'function' ? stamp(cb, 'timer') : cb, ...rest);
  window.addEventListener('message', () => { lastTaskStart = performance.now(); }, true);

  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  const wrapped = new WeakSet();
  HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
    const ctx = nativeGetContext.call(this, type, ...rest);
    if (ctx && /webgl/.test(type) && !wrapped.has(ctx)) {
      wrapped.add(ctx);
      for (const name of ['drawArrays', 'drawElements']) {
        const draw = ctx[name];
        ctx[name] = function (...args) {
          onDraw();
          return draw.apply(this, args);
        };
      }
    }
    return ctx;
  };

  let last = performance.now();
  nativeTimeout(function tick() { // (nativeTimeout: not counted as a timer call)
    const now = performance.now();
    const fps = (frames * 1000) / (now - last);
    const avg = frames ? busy / frames : 0;
    const per = (n) => Math.round((n * 1000) / (now - last));
    label.textContent = `${Math.round(fps)} fps · ${avg.toFixed(1)} ms (max ${Math.round(worst)})`
      + ` · raf ${per(calls.raf)} · timer ${per(calls.timer)}`;
    calls.raf = 0;
    calls.timer = 0;
    frames = 0;
    busy = 0;
    worst = 0;
    last = now;
    nativeTimeout(tick, 1000);
  }, 1000);
}
