import { inboxFor, json, preflight, type Ctx } from "./_shared";

// GET /api/findvideo?url=… — someone pasted a page link instead of a video file.
// Fetches the page and returns the video file it shows: the one in the section a #fragment
// points at, else og:video, else the first <video>/<source> on the page.
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|ogv)(\?|#|$)/i;

export async function GET(request: Request, { env }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  const raw = new URL(request.url).searchParams.get("url") || "";
  let page: URL;
  try { page = new URL(raw); } catch { return json({ error: "That doesn't look like a link." }, 400); }
  if (!/^https?:$/.test(page.protocol)) return json({ error: "That doesn't look like a link." }, 400);
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|loom\.com)$/i.test(page.hostname))
    return json({ error: "YouTube, Vimeo and Loom pages don't share the video file itself. Download the video and choose it as a file instead." }, 422);
  let r: Response;
  try {
    r = await fetch(page.toString(), { headers: { "user-agent": "Mozilla/5.0 (Prompter video finder)", accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
  } catch { return json({ error: "Couldn't open that page." }, 502); }
  const type = r.headers.get("content-type") || "";
  if (/^video\//i.test(type)) return json({ video: r.url || page.toString() });
  if (!r.ok) return json({ error: `That page didn't open (${r.status}). It has to open without signing in.` }, 422);
  if (!/html/i.test(type)) return json({ error: "That link isn't a video or a web page with one on it." }, 422);
  const html = (await r.text()).slice(0, 3_000_000);
  const base = r.url || page.toString();
  const abs = (u: string) => { try { return new URL(u.replace(/&amp;/g, "&"), base).toString(); } catch { return null; } };
  const firstVideo = (h: string) => {
    for (const m of h.matchAll(/<(?:video|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      const u = abs(m[1]); if (u && (VIDEO_EXT.test(u) || /<source\b[^>]*type\s*=\s*["']video\//i.test(m[0]))) return u;
    }
    return null;
  };
  let found: string | null = null;
  const frag = decodeURIComponent(page.hash.slice(1));
  if (frag) {
    const at = html.search(new RegExp(`\\bid\\s*=\\s*["']${frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`));
    if (at >= 0) found = firstVideo(html.slice(at, at + 20000));
  }
  if (!found) {
    const og = html.match(/<meta[^>]+property\s*=\s*["']og:video(?::(?:secure_)?url)?["'][^>]*content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:video(?::(?:secure_)?url)?["']/i);
    if (og) { const u = abs(og[1]); if (u && VIDEO_EXT.test(u)) found = u; }
  }
  found ||= firstVideo(html);
  if (!found) return json({ error: "Couldn't find a video file on that page. Try a link that goes straight to the video (one ending in .mp4)." }, 404);
  return json({ video: found });
}

export const OPTIONS = preflight;
