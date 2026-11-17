// Puts recorded voice onto the video it was narrated over, entirely in the browser.
// The picture is copied as it is (no re-encoding, so no quality loss); only the sound is made new:
// the video's own sound (if kept) with each voice part laid in where it was recorded.
// Nothing leaves the computer.

import {
  Input, Output, ALL_FORMATS, BlobSource, BufferTarget, StreamTarget, Mp4OutputFormat, WebMOutputFormat,
  EncodedVideoPacketSource, EncodedPacketSink, AudioBufferSource, AudioBufferSink, canEncodeAudio,
} from "./vendor/mediabunny.js";

const RATE = 48000, CEILING = Math.pow(10, -1 / 20);

// video: Blob. parts: [{ blob, startMs }]. webm: make a WebM rather than an MP4. keepSound: mix in the video's own sound.
// writable: a FileSystemWritableFileStream to write straight to disk (big videos); without it the file is built in memory.
// Returns { blob (null when written to disk), ext, mime, seconds }.
export async function merge({ video, parts, webm = false, keepSound = true, writable = null, onProgress = () => {} }) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(video) });
  let output = null;
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error("There's no picture in this video file.");
    const codec = await vt.getCodec(), config = await vt.getDecoderConfig();
    if (!codec || !config) throw new Error("This kind of video can't be copied in the browser.");
    const seconds = await input.computeDuration();
    const n = Math.ceil(seconds * RATE);
    if (n * 8 > 1.6e9) throw new Error("This video is too long to do in the browser (about 80 minutes is the most).");
    const L = new Float32Array(n), R = new Float32Array(n);

    // The video's own sound, decoded a piece at a time so a large file never has to sit in memory.
    const at = keepSound ? await input.getPrimaryAudioTrack() : null;
    if (at && await at.canDecode()) {
      let own = null, a = null, b = null; // gathered at the video's own rate, then brought to 48 kHz in one go (no seams)
      for await (const { buffer, timestamp } of new AudioBufferSink(at).buffers()) {
        if (!own) { own = buffer.sampleRate; const len = Math.ceil(seconds * own); a = own === RATE ? L : new Float32Array(len); b = own === RATE ? R : new Float32Array(len); }
        place(a, b, buffer, Math.round(timestamp * own), 1);
        onProgress(0.3 * Math.min(1, timestamp / seconds));
      }
      if (own && own !== RATE) {
        const src = new AudioBuffer({ length: a.length, numberOfChannels: 2, sampleRate: own });
        src.copyToChannel(a, 0); src.copyToChannel(b, 1);
        place(L, R, await toRate(src), 0, 1);
      }
    }
    onProgress(0.3);

    // Each voice part goes in where it was recorded.
    for (const p of parts) {
      const dec = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await p.blob.arrayBuffer())
        .catch(() => { throw new Error("Couldn't read the recorded voice."); });
      place(L, R, dec, Math.round(p.startMs / 1000 * RATE), 1);
    }
    limit(L, R);
    onProgress(0.4);

    if (!webm && codec === "vp8") throw new Error("This video's picture can't go into an MP4. Save it as a .webm and try again.");
    const format = webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: writable ? false : "in-memory" });
    const acodec = !webm && await canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: RATE, bitrate: 192e3 }) ? "aac" : "opus";
    output = new Output({ format, target: writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget() });
    const vsrc = new EncodedVideoPacketSource(codec), asrc = new AudioBufferSource({ codec: acodec, bitrate: 192e3 });
    output.addVideoTrack(vsrc, { rotation: vt.rotation });
    output.addAudioTrack(asrc);
    await output.start();

    // Picture and sound go in side by side, so neither waits on the other.
    await Promise.all([
      (async () => {
        let first = true;
        for await (const packet of new EncodedPacketSink(vt).packets()) {
          await vsrc.add(packet, first ? { decoderConfig: config } : undefined); first = false;
          onProgress(0.4 + 0.6 * Math.min(1, packet.timestamp / seconds));
        }
        vsrc.close();
      })(),
      (async () => {
        const step = RATE * 5;
        for (let i = 0; i < n; i += step) {
          const len = Math.min(step, n - i), buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: RATE });
          buf.copyToChannel(L.subarray(i, i + len), 0); buf.copyToChannel(R.subarray(i, i + len), 1);
          await asrc.add(buf);
        }
        asrc.close();
      })(),
    ]);
    await output.finalize();
    onProgress(1);
    const mime = webm ? "video/webm" : "video/mp4";
    return { blob: writable ? null : new Blob([output.target.buffer], { type: mime }), ext: webm ? "webm" : "mp4", mime, seconds };
  } catch (e) {
    if (output && output.state !== "finalized") await output.cancel().catch(() => {});
    throw e;
  } finally { input.dispose?.(); }
}

// Adds an AudioBuffer (mono or more) into the stereo pair at a sample offset.
function place(L, R, buf, at, gain) {
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  const from = Math.max(0, -at), to = Math.min(buf.length, L.length - at);
  for (let i = from; i < to; i++) { L[at + i] += a[i] * gain; R[at + i] += b[i] * gain; }
}
async function toRate(buf) {
  if (buf.sampleRate === RATE) return buf;
  const ctx = new OfflineAudioContext(Math.min(2, buf.numberOfChannels), Math.ceil(buf.duration * RATE), RATE);
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
  return ctx.startRendering();
}
// If voice and video sound together go over full scale, turn the whole thing down just enough. No pumping.
function limit(L, R) {
  let peak = 0;
  for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
  if (peak <= CEILING) return;
  const g = CEILING / peak;
  for (let i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; }
}
