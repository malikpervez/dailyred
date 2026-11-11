// The ?fps speed readout. RetroArch's own counter (fps_show) isn't drawn in
// every browser (not on iPhone), so this measures the emulator from outside:
// its main loop runs one game frame per requestAnimationFrame callback, so
// callbacks per second is the game's speed (60 = full speed), and the time
// spent inside them is how much of each 16.7 ms frame the emulator needs.
// Nothing else on the page uses requestAnimationFrame.
export function startFpsMeter(container) {
  const label = document.createElement('div');
  label.className = 'fps-meter';
  label.textContent = '-- fps';
  container.append(label);

  let frames = 0;
  let busy = 0;
  let worst = 0;
  const native = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => native((time) => {
    const start = performance.now();
    try {
      callback(time);
    } finally {
      const spent = performance.now() - start;
      frames += 1;
      busy += spent;
      worst = Math.max(worst, spent);
    }
  });

  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const fps = (frames * 1000) / (now - last);
    const avg = frames ? busy / frames : 0;
    label.textContent = `${Math.round(fps)} fps · ${avg.toFixed(1)} ms (max ${Math.round(worst)})`;
    frames = 0;
    busy = 0;
    worst = 0;
    last = now;
  }, 1000);
}
