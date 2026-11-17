// Studio-style clean-up for a recorded voice, done entirely in the browser.
// Rumble cut → RNNoise noise removal → gentle EQ and de-ess → levelling → -16 LUFS → peak limit at -1 dBFS.
// Returns a 48 kHz mono 16-bit WAV. Nothing leaves the computer.

const RATE = 48000;
const TARGET_LUFS = -16, CEILING = Math.pow(10, -1 / 20);
let rnnoiseLoad = null;

const tick = () => new Promise(r => setTimeout(r, 0));

async function render(input, build) {
  const ctx = new OfflineAudioContext(1, input.length, RATE);
  const buf = ctx.createBuffer(1, input.length, RATE); buf.copyToChannel(input, 0);
  const src = ctx.createBufferSource(); src.buffer = buf;
  build(ctx, src).connect(ctx.destination); src.start();
  return (await ctx.startRendering()).getChannelData(0);
}
const chain = (ctx, src, nodes) => nodes.reduce((a, n) => (a.connect(n), n), src);
function biquad(ctx, type, frequency, gain = 0, Q = 0.707) {
  const f = ctx.createBiquadFilter(); Object.assign(f, { type }); f.frequency.value = frequency; f.gain.value = gain; f.Q.value = Q; return f;
}

// Integrated loudness, after ITU BS.1770: K-weighting, 400 ms blocks, absolute and relative gates.
export async function loudness(x) {
  const k = await render(x, (ctx, src) => chain(ctx, src, [biquad(ctx, "highshelf", 1681, 4), biquad(ctx, "highpass", 38, 0, 0.5)]));
  const block = 0.4 * RATE, hop = 0.1 * RATE, ms = [];
  for (let i = 0; i + block <= k.length; i += hop) { let s = 0; for (let j = i; j < i + block; j++) s += k[j] * k[j]; ms.push(s / block); }
  const L = m => -0.691 + 10 * Math.log10(m);
  const abs = ms.filter(m => L(m) > -70); if (!abs.length) return -70;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter(m => L(m) > rel);
  return L(gated.reduce((a, b) => a + b, 0) / gated.length);
}

export async function denoise(x, onProgress) {
  rnnoiseLoad ||= import("./vendor/rnnoise.js").then(m => m.Rnnoise.load());
  const rn = await rnnoiseLoad, st = rn.createDenoiseState(), N = rn.frameSize;
  const out = new Float32Array(x.length), f = new Float32Array(N);
  try {
    for (let i = 0; i < x.length; i += N) {
      f.fill(0); for (let j = 0; j < N && i + j < x.length; j++) f[j] = x[i + j] * 32768;
      st.processFrame(f);
      for (let j = 0; j < N && i + j < x.length; j++) out[i + j] = f[j] / 32768;
      if ((i / N) % 400 === 0) { onProgress?.(0.15 + 0.55 * i / x.length); await tick(); }
    }
  } finally { st.destroy(); }
  // RNNoise hands the voice back two frames (20 ms) late; line it up again so it stays in sync with the video.
  const shifted = new Float32Array(x.length); shifted.set(out.subarray(2 * N));
  // A touch of the original keeps the voice natural; the noise under it is still far quieter.
  for (let i = 0; i < x.length; i++) shifted[i] = shifted[i] * 0.92 + x[i] * 0.08;
  return shifted;
}

// Brick-wall limiter with 5 ms look-ahead and a smooth 80 ms release.
function limit(x) {
  const look = Math.round(0.005 * RATE), rel = 1 - Math.exp(-1 / (0.08 * RATE));
  const need = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); need[i] = a > CEILING ? CEILING / a : 1; }
  // running minimum over the look-ahead window
  const gmin = new Float32Array(x.length), dq = [];
  for (let i = x.length - 1; i >= 0; i--) {
    while (dq.length && need[dq[dq.length - 1]] >= need[i]) dq.pop();
    dq.push(i); while (dq[0] > i + look) dq.shift();
    gmin[i] = need[dq[0]];
  }
  const y = new Float32Array(x.length); let g = 1;
  for (let i = 0; i < x.length; i++) {
    g = gmin[i] < g ? gmin[i] : g + (1 - g) * rel;
    y[i] = Math.max(-CEILING, Math.min(CEILING, x[i] * g));
  }
  return y;
}

function wav(x) {
  const b = new ArrayBuffer(44 + x.length * 2), v = new DataView(b);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + x.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
  return new Blob([b], { type: "audio/wav" });
}

const gain = (x, db) => { const g = Math.pow(10, db / 20), y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * g; return y; };

export async function enhance(blob, { onProgress } = {}) {
  onProgress?.(0.02);
  const dec = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await blob.arrayBuffer());
  const mono = new Float32Array(dec.length);
  for (let c = 0; c < dec.numberOfChannels; c++) { const d = dec.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / dec.numberOfChannels; }
  const before = await loudness(mono);
  onProgress?.(0.1);
  // 1. Cut rumble and handling noise below the voice.
  const hp = await render(mono, (ctx, src) => chain(ctx, src, [biquad(ctx, "highpass", 80, 0, 0.707)]));
  // 2. Remove background noise.
  const clean = await denoise(hp, onProgress);
  onProgress?.(0.72);
  // 3. Bring to a working level, then shape and level the voice.
  const pre = gain(clean, -20 - (await loudness(clean)));
  const shaped = await render(pre, (ctx, src) => {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.knee.value = 8; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.2;
    return chain(ctx, src, [
      biquad(ctx, "peaking", 250, -2, 1),      // less boxy "mud"
      biquad(ctx, "peaking", 3200, 2.5, 0.9),  // presence, so words cut through
      biquad(ctx, "peaking", 6500, -2.5, 2.5), // softer "s" sounds
      biquad(ctx, "highshelf", 10000, 1.5),    // a little air
      comp,                                    // evens out loud and quiet words
    ]);
  });
  onProgress?.(0.85);
  // 4. Podcast loudness, with peaks kept under -1 dBFS.
  const out = limit(gain(shaped, TARGET_LUFS - (await loudness(shaped))));
  const after = await loudness(out);
  onProgress?.(1);
  return { blob: wav(out), before: Math.round(before * 10) / 10, after: Math.round(after * 10) / 10 };
}
