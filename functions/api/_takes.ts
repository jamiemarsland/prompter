// Shared by the takes API and the MCP server. Files starting with "_" are never routed.

export interface TakeDetail {
  flubs?: { ms: number; near?: string }[];
  words?: [number, string][]; // [ms from start, word] as the prompter followed the script
}

const MAX_DETAIL = 400_000;

export function cleanTake(o: any) {
  const str = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
  const num = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
  const flubs = (Array.isArray(o?.flubs) ? o.flubs : []).slice(0, 200).map((f: any) => ({ ms: num(f?.ms), near: str(f?.near, 120) || undefined }));
  const words = (Array.isArray(o?.words) ? o.words : []).slice(0, 20000)
    .filter((w: any) => Array.isArray(w)).map((w: any) => [num(w[0]), str(w[1], 40)] as [number, string]);
  let detail = JSON.stringify({ flubs, words });
  if (detail.length > MAX_DETAIL) detail = JSON.stringify({ flubs, words: [] });
  return {
    script_id: str(o?.script_id, 40) || null,
    title: str(o?.title, 120) || "Take",
    n: num(o?.n) || 1,
    filename: str(o?.filename, 255),
    folder: str(o?.folder, 255) || null,
    duration_ms: num(o?.duration_ms),
    size: num(o?.size) || null,
    kept: o?.kept ? 1 : 0,
    detail,
  };
}

export const clock = (ms: number) => {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

// Plain-text description of one take, written for an editing agent.
export function describeTake(t: any, full: boolean) {
  const d: TakeDetail = (() => { try { return JSON.parse(t.detail || "{}"); } catch { return {}; } })();
  const flubs = d.flubs || [];
  const where = t.folder
    ? `in the folder the user picked for takes (named "${t.folder}")`
    : "in the user's Downloads folder";
  const lines = [
    `${t.id} · ${t.title} · take ${t.n}${Number(t.kept) ? " · ★ keeper" : ""} · ${clock(Number(t.duration_ms))} · ${new Date(Number(t.created_at)).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `File: "${t.filename}" ${where}${t.size ? `, ${(Number(t.size) / 1e6).toFixed(1)} MB` : ""}.`,
    t.script_id ? `Script id: ${t.script_id}` : "",
    flubs.length ? `Flubs marked: ${flubs.length}` : "No flubs marked.",
  ].filter(Boolean);
  if (!full) return lines.join("\n");
  if (flubs.length) {
    lines.push("", "Flubs (the speaker pressed a key just after tripping up, so the mistake is in the few seconds before each time):");
    for (const f of flubs) lines.push(`- ${clock(f.ms)}${f.near ? ` near "${f.near}"` : ""}`);
  }
  if (d.words?.length) {
    lines.push("", "Rough word timings (when the prompter saw each script word reach the reading line; voice recognition lags by about half a second). Use them to find sections, not for frame-accurate cuts:");
    let line = "";
    for (const [ms, w] of d.words) {
      const cell = `[${clock(ms)}] ${w} `;
      if (line.length + cell.length > 110) { lines.push(line.trimEnd()); line = ""; }
      line += cell;
    }
    if (line) lines.push(line.trimEnd());
  }
  return lines.join("\n");
}
