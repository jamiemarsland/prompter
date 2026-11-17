import { clean, db, inboxFor, json, newId, preflight, withVideo, type Ctx, type Env } from "../api/_shared";
import { describeTake } from "../api/_takes";
import { AutoTimeError, alignScript, scriptFromSpeech, transcribe } from "../api/_autotime";

// A minimal MCP server (Streamable HTTP, stateless JSON responses) so AI agents can
// send scripts with a single connector URL: https://<space>/mcp/<inbox key>
// (or https://<space>/mcp with "Authorization: Bearer <key>").

const INSTRUCTIONS = `This connector sends scripts to the user's teleprompter. A script you send appears on their prompter screen within a few seconds.
Write for speaking aloud: short sentences, conversational, no stage-y markdown. About 150 spoken words is one minute.
Formatting the prompter understands: a blank line between paragraphs; "## Heading" for a section; [square brackets] for delivery notes such as [smile] or [pause] (voice mode skips them); "//" for a breath. Avoid tables, links and emoji, and don't use bullet lists in a word-for-word script.
Talking points: if the user wants to speak in their own words rather than read (they ask for "talking points", "bullet points", "notes" or "an outline"), send a list with one "- " line per point and nothing else but optional "## " headings. Keep each point to a short phrase of key words, not a sentence, e.g. "- why Elgato's app frustrated me". The prompter shows one point at a time and moves on when it hears them start the next one.
Voiceovers: if the user wants to record a voiceover for an existing video that already has speech, send the script with video_url, then call time_script so the words keep pace with the picture. time_script with no id writes a timed script from what is said in the video. After sending, tell the user the title and that it's on their prompter. To revise a script after feedback, use update_script with the same id instead of sending a new one.

The user can also record themselves on the prompter. list_takes and get_take describe those recordings so you can edit them: the file name, where it was saved, the moments they marked as flubs, and rough word timings. The video file itself is on the user's computer, not on this server. If you can read their files (for example in Claude Code), find it by name in the folder given, usually under ~/Movies or ~/Downloads; otherwise ask them to share it. Prefer takes marked as keepers.`;

const TOOLS = [
  {
    name: "send_script",
    title: "Send script to teleprompter",
    description: "Put a new script on the user's teleprompter. It appears on their screen within seconds.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title shown in the script library, e.g. 'Episode 12 intro'." },
        text: { type: "string", description: "The full script, written to be read aloud. For talking points, one \"- \" line per point instead. For a voiceover over a video, start each paragraph with where it belongs in the video, as [m:ss] or [m:ss-m:ss] (for example [0:36-1:08]); the prompter keeps the words in time with the picture while the user records. A bare [m:ss] inside a paragraph is a pace mark for the words after it." },
        video_url: { type: "string", description: "Optional. A public link straight to a video file (for example one ending in .mp4) that this script is a voiceover for. The prompter loads it above the script so the user can record against the picture. It must open without signing in; a YouTube or Vimeo page will not work." },
      },
      required: ["title", "text"],
    },
  },
  {
    name: "update_script",
    title: "Revise a script",
    description: "Replace the text (and optionally the title) of a script already on the teleprompter.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The script id returned by send_script or list_scripts." },
        title: { type: "string" },
        text: { type: "string", description: "The full revised script." },
        video_url: { type: "string", description: "Optional. A public link straight to a video file (for example one ending in .mp4) that this script is a voiceover for. The prompter loads it above the script so the user can record against the picture. It must open without signing in; a YouTube or Vimeo page will not work." },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "list_scripts",
    title: "List scripts",
    description: "List the most recent scripts on the teleprompter (id, title, when sent).",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many, default 10." } } },
  },
  {
    name: "list_takes",
    title: "List recorded takes",
    description: "List the user's recent recordings from the prompter: id, script, take number, length, file name, keeper star and flub count.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many, default 10." },
        script_id: { type: "string", description: "Only takes of this script." },
        keepers_only: { type: "boolean", description: "Only takes the user starred as keepers." },
      },
    },
  },
  {
    name: "get_take",
    title: "Get a take for editing",
    description: "Everything needed to edit one recording: where the video file is, the flub markers (timestamps where the user tripped up) and rough word-by-word timings against the script. Omit id for the latest take.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Take id from list_takes. Leave out for the most recent take." } } },
  },
  {
    name: "time_script",
    title: "Time a script to its video",
    description: "Listens to a video's voiceover and writes where each paragraph of the script falls in it, so the prompter keeps the words in time with the picture while the user records a new voiceover. Uses the script's own video link unless you give video_url, which must link straight to a video file that opens without signing in. Leave out id to make a new script from what's said in the video. Each user gets a daily allowance of about 30 minutes of audio.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Script to time. Leave out to write a new script from the video's speech." }, video_url: { type: "string", description: "Public link straight to the video file. Optional when the script already has one." } } },
  },
  {
    name: "get_script",
    title: "Read a script",
    description: "Get the full text of one script.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

async function callTool(name: string, args: any, env: Env, origin: string, inbox: string) {
  const d = await db(env);
  if (name === "send_script") {
    let body = String(args?.text ?? "");
    if (args?.video_url) { const v = withVideo(body, args.video_url); if (v == null) return text("video_url has to be a plain http(s) link straight to a video file.", true); body = v; }
    const s = clean({ title: args?.title, text: body, source: "ai" });
    if (!String(args?.text ?? "").trim()) return text("The script text was empty.", true);
    const id = newId();
    const now = Date.now();
    await d.prepare("INSERT INTO scripts (id, inbox, title, source, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, inbox, s.title, s.source, s.text, now, now).run();
    const words = s.text.split(/\s+/).length;
    return text(`Sent "${s.title}" to the teleprompter (id ${id}, ${words} words, about ${Math.max(1, Math.round(words / 150))} min). It's live at ${origin}/app/#${id}`);
  }
  if (name === "update_script") {
    const row = await d.prepare("SELECT title FROM scripts WHERE id = ? AND inbox = ?").bind(String(args?.id || ""), inbox).first();
    if (!row) return text("No script with that id.", true);
    let body = String(args?.text ?? "");
    if (args?.video_url) { const v = withVideo(body, args.video_url); if (v == null) return text("video_url has to be a plain http(s) link straight to a video file.", true); body = v; }
    const s = clean({ title: args?.title || row.title, text: body });
    if (!String(args?.text ?? "").trim()) return text("The script text was empty.", true);
    await d.prepare("UPDATE scripts SET title = ?, body = ?, updated_at = ? WHERE id = ? AND inbox = ?").bind(s.title, s.text, Date.now(), args.id, inbox).run();
    return text(`Updated "${s.title}". If it's open on the prompter, the new version appears within a few seconds and keeps the user's place. If they're reading or recording, it loads when they pause.`);
  }
  if (name === "list_scripts") {
    const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));
    const { results } = await d.prepare(`SELECT id, title, source, created_at FROM scripts WHERE inbox = ? ORDER BY created_at DESC LIMIT ${limit}`).bind(inbox).all();
    if (!results.length) return text("No scripts yet.");
    return text(results.map((r: any) => `${r.id} · ${r.title} · ${new Date(Number(r.created_at)).toISOString().slice(0, 16).replace("T", " ")} UTC`).join("\n"));
  }
  if (name === "get_script") {
    const row = await d.prepare("SELECT * FROM scripts WHERE id = ? AND inbox = ?").bind(String(args?.id || ""), inbox).first();
    return row ? text(`# ${row.title}\n\n${row.body}`) : text("No script with that id.", true);
  }
  if (name === "list_takes") {
    const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));
    const where = ["inbox = ?"], binds: unknown[] = [inbox];
    if (args?.script_id) { where.push("script_id = ?"); binds.push(String(args.script_id)); }
    if (args?.keepers_only) where.push("kept = 1");
    const { results } = await d.prepare(`SELECT * FROM takes WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`).bind(...binds).all();
    if (!results.length) return text("No takes recorded yet. The user records them on the prompter with the camera button.");
    return text(results.map((r: any) => describeTake(r, false)).join("\n\n"));
  }
  if (name === "get_take") {
    const row = args?.id
      ? await d.prepare("SELECT * FROM takes WHERE id = ? AND inbox = ?").bind(String(args.id), inbox).first()
      : await d.prepare("SELECT * FROM takes WHERE inbox = ? ORDER BY created_at DESC LIMIT 1").bind(inbox).first();
    if (!row) return text(args?.id ? "No take with that id." : "No takes recorded yet.", true);
    let out = describeTake(row, true);
    if (row.script_id) {
      const s = await d.prepare("SELECT body FROM scripts WHERE id = ? AND inbox = ?").bind(row.script_id, inbox).first();
      if (s) out += `\n\nScript as written:\n${s.body}`;
    }
    return text(out);
  }
  if (name === "time_script") {
    const row = args?.id ? await d.prepare("SELECT * FROM scripts WHERE id = ? AND inbox = ?").bind(String(args.id), inbox).first() : null;
    if (args?.id && !row) return text("No script with that id.", true);
    const linked = row && String(row.body).match(/^\[video:\s*(https?:\/\/[^\s\]]+)\s*\]$/im)?.[1];
    const url = String(args?.video_url || linked || "");
    if (!/^https?:\/\/[^\s\]]+$/i.test(url)) return text("Give video_url: a public link straight to the video file (one ending in .mp4, for example).", true);
    try {
      const heard = await transcribe(env as any, inbox, { url });
      if (row) {
        const out = alignScript(String(row.body), heard);
        const body = withVideo(out.text, url) ?? out.text;
        await d.prepare("UPDATE scripts SET body = ?, updated_at = ? WHERE id = ? AND inbox = ?").bind(body, Date.now(), row.id, inbox).run();
        return text(`Timed "${row.title}" to the video: ${out.timed} paragraphs across ${Math.round(out.duration)} seconds. It's on the prompter with the video loaded, and the words now keep pace with the picture.`);
      }
      const out = scriptFromSpeech(heard, url);
      const s = clean({ title: args?.title || decodeURIComponent(url.split("/").pop() || "Voiceover").replace(/\.[a-z0-9]+$/i, ""), text: out.text, source: "ai" });
      const id = newId(), now = Date.now();
      await d.prepare("INSERT INTO scripts (id, inbox, title, source, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, inbox, s.title, s.source, s.text, now, now).run();
      return text(`Wrote "${s.title}" (id ${id}) from the video's voiceover, timed in ${out.timed} paragraphs. It's live at ${origin}/app/#${id}. You can rewrite the words with update_script, but keep each paragraph's [m:ss-m:ss] time at its start.`);
    } catch (e: any) {
      return text(e instanceof AutoTimeError ? e.message : "Auto-timing failed: " + (e?.message || e), true);
    }
  }
  return text(`Unknown tool ${name}.`, true);
}

async function handle(msg: Rpc, env: Env, origin: string, inbox: string) {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "prompter", title: "Prompter teleprompter", version: "1.3.0" },
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(msg.params?.name, msg.params?.arguments || {}, env, origin, inbox);
    default:
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

export async function POST(request: Request, { env, params }: Ctx) {
  const inbox = await inboxFor(request, env, params.splat);
  if (inbox instanceof Response) return inbox;
  let body: Rpc | Rpc[];
  try { body = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const origin = new URL(request.url).origin;
  const one = async (m: Rpc) => {
    if (m.id === undefined || m.id === null) return null; // notification
    try { return { jsonrpc: "2.0", id: m.id, result: await handle(m, env, origin, inbox) }; }
    catch (e: any) { return { jsonrpc: "2.0", id: m.id, error: { code: e.code || -32603, message: e.message } }; }
  };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(one))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await one(body);
  return out ? json(out) : new Response(null, { status: 202 });
}

// No server-initiated stream; tell clients so they don't hold a GET open.
export async function GET(request: Request, { env, params }: Ctx) {
  if (request.headers.get("accept")?.includes("text/event-stream")) return new Response(null, { status: 405, headers: { allow: "POST" } });
  const inbox = await inboxFor(request, env, params.splat);
  return new Response(!(inbox instanceof Response)
    ? "Prompter MCP server. Add this URL as a connector in your AI app."
    : "Prompter MCP server. This URL needs your key.", { headers: { "content-type": "text/plain" } });
}

export async function DELETE() { return new Response(null, { status: 405 }); }

export const OPTIONS = preflight;
