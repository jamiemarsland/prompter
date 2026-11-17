// Auto-timing: hear a video's voiceover and write where each paragraph of the script falls in it.
// Speech-to-text is Groq's Whisper (whisper-large-v3-turbo) with word timestamps, paid for by the
// Space owner's GROQ_API_KEY, so each inbox gets a daily allowance of audio.

import type { Env } from "./_shared";

export const DAILY_SECONDS = 30 * 60;
const MIN_BILLED = 10; // Groq bills at least 10 seconds a request

export type Word = { word: string; start: number; end: number };
export type Heard = { words: Word[]; segments: { text: string; start: number; end: number }[]; duration: number };

// ---------- daily allowance ----------

const today = () => new Date().toISOString().slice(0, 10);
let tableReady = false;
async function usageTable(env: Env) {
  if (tableReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS autotime_usage (inbox VARCHAR(64) NOT NULL, day VARCHAR(10) NOT NULL, seconds INT NOT NULL, PRIMARY KEY (inbox, day))").run();
  tableReady = true;
}
export async function secondsUsed(env: Env, inbox: string): Promise<number> {
  await usageTable(env);
  const row = await env.DB.prepare("SELECT seconds FROM autotime_usage WHERE inbox = ? AND day = ?").bind(inbox, today()).first();
  return row ? Number(row.seconds) : 0;
}
async function addSeconds(env: Env, inbox: string, s: number) {
  const day = today(), used = await secondsUsed(env, inbox);
  const add = Math.ceil(Math.max(MIN_BILLED, s));
  if (used) await env.DB.prepare("UPDATE autotime_usage SET seconds = seconds + ? WHERE inbox = ? AND day = ?").bind(add, inbox, day).run();
  else {
    try { await env.DB.prepare("INSERT INTO autotime_usage (inbox, day, seconds) VALUES (?, ?, ?)").bind(inbox, day, add).run(); }
    catch { await env.DB.prepare("UPDATE autotime_usage SET seconds = seconds + ? WHERE inbox = ? AND day = ?").bind(add, inbox, day).run(); }
  }
}

export class AutoTimeError extends Error { status: number; constructor(msg: string, status = 400) { super(msg); this.status = status; } }

// ---------- speech-to-text ----------

export async function transcribe(env: Env & { GROQ_API_KEY?: string }, inbox: string, src: { file?: Blob; filename?: string; url?: string; seconds?: number }): Promise<Heard> {
  const groqKey = (env.GROQ_API_KEY || "").trim();
  if (!groqKey) throw new AutoTimeError("Auto-timing isn't switched on for this Prompter yet.", 503);
  const used = await secondsUsed(env, inbox);
  const left = DAILY_SECONDS - used;
  if (left <= 0 || (src.seconds && src.seconds > left))
    throw new AutoTimeError(`That's more than today's auto-timing allowance (${Math.floor(Math.max(0, left) / 60)} of ${DAILY_SECONDS / 60} minutes left). It resets at midnight UTC.`, 429);
  const form = new FormData();
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  form.append("language", "en");
  if (src.file) form.append("file", src.file, src.filename || "audio.wav");
  else if (src.url) form.append("url", src.url);
  else throw new AutoTimeError("Send the video's audio or a link to the video.");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${groqKey}` }, body: form });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    if (r.status === 429) throw new AutoTimeError("The speech service is busy. Try again in a minute.", 429);
    if (r.status === 401 || r.status === 403) throw new AutoTimeError("Auto-timing isn't working right now: the speech service didn't accept this Prompter's key.", 503);
    throw new AutoTimeError(src.url && r.status === 400 ? "Couldn't hear that video. The link has to open without signing in." : `The speech service said no (${r.status}): ${detail}`, 502);
  }
  const o: any = await r.json();
  const segments = (o.segments || []).map((s: any) => ({ text: String(s.text || "").trim(), start: +s.start || 0, end: +s.end || 0 }));
  let words: Word[] = (o.words || []).map((w: any) => ({ word: String(w.word ?? w.text ?? ""), start: +w.start || 0, end: +w.end || 0 }));
  if (!words.length) words = (o.segments || []).flatMap((s: any) => (s.words || []).map((w: any) => ({ word: String(w.word ?? ""), start: +w.start || 0, end: +w.end || 0 })));
  const duration = +o.duration || segments.at(-1)?.end || words.at(-1)?.end || 0;
  await addSeconds(env, inbox, duration);
  return { words, segments, duration };
}

// ---------- matching the script to what was said ----------

const norm = (w: string) => w.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
const same = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const SEC_CUE = /^\[\d+:\d\d(?:\.\d+)?(?:\s*[-–]\s*\d+:\d\d(?:\.\d+)?)?\]\s*/;
const PACE = /^\[\d+:\d\d(?:\.\d+)?\]$/;
const VIDEO_LINE = /^\[video:\s*https?:\/\/[^\s\]]+\s*\]$/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

// Index pairs (script word, heard word) in order, by longest common subsequence; a windowed walk for very long scripts.
function match(a: string[], b: string[]): Map<number, number> {
  const n = a.length, m = b.length, out = new Map<number, number>();
  if (n * m <= 6_000_000) {
    const L = new Uint16Array((n + 1) * (m + 1)), W = m + 1;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * W + j] = same(a[i], b[j]) ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (same(a[i], b[j])) { out.set(i, j); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++;
    }
  } else {
    let j = 0;
    for (let i = 0; i < n; i++) {
      const win = a[i].length >= 5 ? 40 : 6;
      for (let k = j; k < Math.min(m, j + win); k++) if (same(a[i], b[k])) { out.set(i, k); j = k + 1; break; }
    }
  }
  return out;
}

export type Timed = { text: string; timed: number; paragraphs: number; matched: number; duration: number };

// Rewrites the script with [start-end] on each paragraph and pace marks inside long ones.
export function alignScript(body: string, heard: Heard): Timed {
  const paras = body.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paras.filter(p => !VIDEO_LINE.test(p)).every(p => p.split("\n").every(l => !l.trim() || BULLET.test(l))))
    throw new AutoTimeError("Talking points aren't read word for word, so they can't be timed. Auto-time works on a full script.");
  // Paragraphs to time: everything except the video line and headings.
  type P = { i: number; tokens: string[]; words: number[]; start?: number; end?: number };
  const ps: P[] = [], scriptWords: string[] = [], owner: { p: number; t: number }[] = [];
  paras.forEach((p, i) => {
    if (VIDEO_LINE.test(p) || /^#/.test(p)) return;
    const tokens = p.replace(SEC_CUE, "").split(/\s+/).filter(t => t && !PACE.test(t));
    const P: P = { i, tokens, words: [] };
    tokens.forEach((t, k) => {
      const n = /^\[.*\]$/.test(t) || t === "//" ? "" : norm(t);
      if (n) { P.words.push(scriptWords.length); scriptWords.push(n); owner.push({ p: ps.length, t: k }); }
    });
    ps.push(P);
  });
  const heardWords = heard.words.map(w => norm(w.word));
  const m = match(scriptWords, heardWords);
  if (m.size < Math.max(2, scriptWords.length * 0.2))
    throw new AutoTimeError("Couldn't find the script in this video's voiceover. Is it the right video, and does it have someone speaking?");
  // A paragraph that only matched a stray short word or two wasn't really said: let the gap-filling time it instead.
  const hits = new Map<number, number>();
  for (const [si] of m) hits.set(owner[si].p, (hits.get(owner[si].p) || 0) + 1);
  for (const [si] of [...m]) {
    const p = owner[si].p, h = hits.get(p) || 0, n = ps[p].words.length;
    if (n > 3 && h < Math.max(2, n * 0.3)) m.delete(si);
  }
  const tokenStart = new Map<string, number>();
  for (const [si, hi] of m) {
    const { p, t } = owner[si], w = heard.words[hi];
    const P = ps[p];
    P.start = Math.min(P.start ?? Infinity, w.start); P.end = Math.max(P.end ?? -Infinity, w.end);
    tokenStart.set(`${p}:${t}`, w.start);
  }
  // Paragraphs nothing matched in: share out the gap between their timed neighbours by word count.
  for (let k = 0; k < ps.length; k++) {
    if (ps[k].start != null) continue;
    let a = k - 1; while (a >= 0 && ps[a].start == null) a--;
    let b = k + 1; while (b < ps.length && ps[b].start == null) b++;
    const t0 = a >= 0 ? ps[a].end! : 0, t1 = b < ps.length ? ps[b].start! : heard.duration || t0;
    const run = ps.slice(a + 1, b), total = run.reduce((s, q) => s + Math.max(1, q.words.length), 0);
    let at = t0;
    for (const q of run) { const d = (t1 - t0) * Math.max(1, q.words.length) / total; q.start = at; q.end = at + d; at += d; }
  }
  const out = paras.slice();
  ps.forEach((P, k) => {
    const s = P.start!, e = Math.max(P.end!, s + 0.3);
    let last = s;
    const parts = P.tokens.map((tok, t) => {
      const st = tokenStart.get(`${k}:${t}`), prev = P.tokens[t - 1] || "";
      if (t && e - s > 5 && st != null && /[.,:;?!]$/.test(prev) && st - last >= 2 && e - st >= 1.5) { last = st; return `[${fmt(st)}] ${tok}`; }
      return tok;
    });
    out[P.i] = `[${fmt(s)}-${fmt(e)}] ${parts.join(" ")}`;
  });
  return { text: out.join("\n\n"), timed: ps.length, paragraphs: ps.length, matched: m.size, duration: heard.duration };
}

// No script yet: write one from what was said, a paragraph per sentence the speech service heard.
export function scriptFromSpeech(heard: Heard, videoUrl?: string): Timed {
  const segs = heard.segments.filter(s => s.text);
  if (!segs.length) throw new AutoTimeError("Couldn't hear anyone speaking in this video.");
  const text = segs.map(s => `[${fmt(s.start)}-${fmt(s.end)}] ${s.text}`).join("\n\n") + (videoUrl ? `\n\n[video: ${videoUrl}]` : "");
  return { text, timed: segs.length, paragraphs: segs.length, matched: heard.words.length, duration: heard.duration };
}
