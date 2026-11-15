/**
 * Data model + note (de)serialisation.
 *
 * A Gantt note is a normal Markdown file:
 *
 *   ---
 *   gantt-plugin: timeline
 *   ---
 *   ```gantt
 *   {"t":"lane","id":"a1b2c3","name":"Work","color":"#7c6cf0"}
 *   {"t":"bar","id":"d4e5f6","lane":"a1b2c3","name":"Design","start":"2026-11-02","end":"2026-11-09"}
 *   ```
 *
 * One JSON object per line, deterministic order → tiny diffs, clean
 * three-way merges and no churn for sync tools such as Remotely Save.
 * Anything we do not understand is preserved verbatim (`extra`).
 */

export const FM_KEY = "gantt-plugin";
export const FENCE = "gantt";

export interface Lane {
  id: string;
  name: string;
  color: string;
  collapsed?: boolean;
}

export interface Bar {
  id: string;
  lane: string;
  name: string;
  /** inclusive start day (days since 1970-01-01 UTC) */
  start: number;
  /** inclusive end day */
  end: number;
  color?: string;
  progress?: number; // 0..100
  note?: string;
}

export interface GanttData {
  lanes: Lane[];
  bars: Bar[];
  /** unknown / unparsable lines, kept so nothing is ever lost */
  extra: string[];
}

export interface ParsedNote {
  before: string;
  after: string;
  hasBlock: boolean;
  data: GanttData;
}

// ---------- dates ----------

export const DAY_MS = 86400000;
const pad = (n: number, l = 2) => String(n).padStart(l, "0");

export function toDay(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}
export const todayDay = () => toDay(new Date());

export function isoOf(day: number): string {
  const d = new Date(day * DAY_MS);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function parseISO(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const chk = new Date(t);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

/** 0 = Sunday … 6 = Saturday */
export const weekday = (day: number) => (((day + 4) % 7) + 7) % 7;

// ---------- ids / palette ----------

export const PALETTE = [
  "#7c6cf0", "#3fa7d6", "#2fbf9b", "#7bc043",
  "#e0a030", "#e8704a", "#d9548f", "#8b8f9c",
];

export function uid(existing?: Set<string>): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    if (!existing || !existing.has(id)) return id;
  }
}

export const emptyData = (): GanttData => ({ lanes: [], bars: [], extra: [] });

// ---------- parsing ----------

const BLOCK_RE = /^```gantt[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;

export function parseNote(text: string): ParsedNote {
  const m = BLOCK_RE.exec(text);
  if (!m) {
    return { before: text, after: "", hasBlock: false, data: emptyData() };
  }
  return {
    before: text.slice(0, m.index),
    after: text.slice(m.index + m[0].length),
    hasBlock: true,
    data: parseBlock(m[1]),
  };
}

export function parseBlock(body: string): GanttData {
  const data = emptyData();
  const laneIds = new Set<string>();
  const barIds = new Set<string>();

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      data.extra.push(raw);
      continue;
    }
    if (o && o.t === "lane" && typeof o.id === "string" && !laneIds.has(o.id)) {
      laneIds.add(o.id);
      data.lanes.push({
        id: o.id,
        name: String(o.name ?? ""),
        color: typeof o.color === "string" ? o.color : PALETTE[data.lanes.length % PALETTE.length],
        ...(o.collapsed ? { collapsed: true } : {}),
      });
    } else if (o && o.t === "bar" && typeof o.id === "string" && !barIds.has(o.id)) {
      let s = parseISO(o.start), e = parseISO(o.end ?? o.start);
      if (s === null || e === null) {
        data.extra.push(raw);
        continue;
      }
      if (e < s) [s, e] = [e, s];
      barIds.add(o.id);
      const bar: Bar = {
        id: o.id,
        lane: String(o.lane ?? ""),
        name: String(o.name ?? ""),
        start: s,
        end: e,
      };
      if (typeof o.color === "string" && o.color) bar.color = o.color;
      if (typeof o.progress === "number" && o.progress > 0) bar.progress = Math.min(100, Math.round(o.progress));
      if (typeof o.note === "string" && o.note) bar.note = o.note;
      data.bars.push(bar);
    } else {
      data.extra.push(raw);
    }
  }

  // repair: bars that point to a missing lane go to the first lane
  if (data.bars.length && !data.lanes.length) {
    data.lanes.push({ id: uid(laneIds), name: "", color: PALETTE[0] });
  }
  const known = new Set(data.lanes.map((l) => l.id));
  for (const b of data.bars) {
    if (!known.has(b.lane)) b.lane = data.lanes[0].id;
  }
  return data;
}

// ---------- serialising ----------

export function serializeBlock(data: GanttData): string {
  const order = new Map(data.lanes.map((l, i) => [l.id, i]));
  const lines: string[] = [];
  for (const l of data.lanes) {
    lines.push(
      JSON.stringify({
        t: "lane",
        id: l.id,
        name: l.name,
        color: l.color,
        ...(l.collapsed ? { collapsed: true } : {}),
      })
    );
  }
  const bars = [...data.bars].sort(
    (a, b) =>
      (order.get(a.lane) ?? 0) - (order.get(b.lane) ?? 0) ||
      a.start - b.start ||
      a.end - b.end ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  for (const b of bars) {
    lines.push(
      JSON.stringify({
        t: "bar",
        id: b.id,
        lane: b.lane,
        name: b.name,
        start: isoOf(b.start),
        end: isoOf(b.end),
        ...(b.color ? { color: b.color } : {}),
        ...(b.progress ? { progress: b.progress } : {}),
        ...(b.note ? { note: b.note } : {}),
      })
    );
  }
  for (const x of data.extra) lines.push(x);
  return "```" + FENCE + "\n" + lines.join("\n") + (lines.length ? "\n" : "") + "```";
}

/** Rebuild the full note text, leaving everything outside the block untouched. */
export function buildNote(parsed: ParsedNote, data: GanttData): string {
  const block = serializeBlock(data);
  if (parsed.hasBlock) return parsed.before + block + parsed.after;
  const base = parsed.before;
  const sep = base === "" ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return base + sep + block + "\n";
}

export function newNoteText(data: GanttData): string {
  return `---\n${FM_KEY}: timeline\n---\n\n${serializeBlock(data)}\n`;
}

export function hasGanttFrontmatter(text: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return !!m && new RegExp(`^${FM_KEY}\\s*:`, "m").test(m[1]);
}
