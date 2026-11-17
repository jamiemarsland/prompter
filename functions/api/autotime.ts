import { hashKey, inboxFor, json, preflight, type Ctx } from "./_shared";
import { AutoTimeError, DAILY_SECONDS, alignScript, scriptFromSpeech, secondsUsed, transcribe } from "./_autotime";

// POST /api/autotime — times a script to a video's voiceover.
// multipart/form-data: audio (a small WAV the browser pulled from a local video), text, seconds
// or JSON: { text, url } where url links straight to the video file.
// With no text, it writes a script from what was said. Returns { text, timed, duration, minutes_left }.
export async function POST(request: Request, { env }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  let text = "", url = "", file: Blob | undefined, seconds = 0;
  try {
    if ((request.headers.get("content-type") || "").includes("multipart/form-data")) {
      const f = await request.formData();
      text = String(f.get("text") || ""); url = String(f.get("url") || ""); seconds = Number(f.get("seconds")) || 0;
      const a = f.get("audio"); if (a && typeof a !== "string") file = a;
    } else {
      const o = await request.json().catch(() => ({}));
      text = String(o.text || ""); url = String(o.url || ""); seconds = Number(o.seconds) || 0;
    }
    if (url && !/^https?:\/\/[^\s\]]+$/i.test(url)) throw new AutoTimeError("The video link has to be a plain http(s) link.");
    if (file && file.size > 24 * 1024 * 1024) throw new AutoTimeError("That video is too long to time in one go (about 13 minutes is the most).");
    const heard = await transcribe(env as any, inbox, { file, filename: "audio.wav", url: file ? undefined : url, seconds });
    const out = text.trim() ? alignScript(text, heard) : scriptFromSpeech(heard, url || undefined);
    const left = Math.max(0, DAILY_SECONDS - (await secondsUsed(env, inbox)));
    return json({ ok: true, ...out, minutes_left: Math.floor(left / 60) });
  } catch (e: any) {
    if (e instanceof AutoTimeError) return json({ error: e.message }, e.status);
    return json({ error: "Auto-timing failed: " + (e?.message || e) }, 500);
  }
}

export async function GET(request: Request, { env }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  const left = Math.max(0, DAILY_SECONDS - (await secondsUsed(env, inbox)));
  const out: any = { enabled: !!(env as any).GROQ_API_KEY, minutes_left: Math.floor(left / 60), minutes_per_day: DAILY_SECONDS / 60 };
  // The Space owner can see the key's shape (never the key) to check it was pasted right.
  if (env.PROMPTER_KEY && inbox === (await hashKey(env.PROMPTER_KEY))) {
    const raw = String((env as any).GROQ_API_KEY || ""), k = raw.trim();
    out.key_shape = { looks_like_groq: k.startsWith("gsk_"), length: k.length, had_spaces_around: raw !== k, has_spaces_inside: /\s/.test(k) };
  }
  return json(out);
}

export const OPTIONS = preflight;
