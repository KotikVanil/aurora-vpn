// Tiny WebAudio synth for UI feedback. No audio files.

let ctx = null;
export const sound = { enabled: true };

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function tone(freq, start, dur, { type = "sine", gain = 0.08, slide = 0 } = {}) {
  const a = ac();
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime + start);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, a.currentTime + start + dur);
  g.gain.setValueAtTime(0, a.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start);
  o.stop(a.currentTime + start + dur + 0.05);
}

export function play(name) {
  if (!sound.enabled) return;
  try {
    switch (name) {
      case "connect":
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.08, 0.5, { gain: 0.06 }));
        tone(1567.98, 0.32, 0.8, { type: "triangle", gain: 0.03 });
        break;
      case "disconnect":
        [783.99, 587.33, 392].forEach((f, i) => tone(f, i * 0.07, 0.35, { gain: 0.05 }));
        break;
      case "click":
        tone(880, 0, 0.06, { type: "triangle", gain: 0.03 });
        break;
      case "charge":
        tone(220, 0, 1.2, { type: "sawtooth", gain: 0.015, slide: 4 });
        break;
      case "error":
        tone(196, 0, 0.25, { type: "square", gain: 0.03 });
        tone(155.56, 0.18, 0.35, { type: "square", gain: 0.03 });
        break;
      case "ping":
        tone(1318.5, 0, 0.12, { gain: 0.025 });
        break;
      case "warp":
        tone(110, 0, 1.6, { type: "sawtooth", gain: 0.03, slide: 12 });
        break;
    }
  } catch {
    /* audio is optional */
  }
}
