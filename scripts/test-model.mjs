// Round-trip tests for the note format. Run: npm test
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = join(tmpdir(), "gantt-notes-model.test.mjs");
await build({ entryPoints: ["src/model.ts"], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
const m = await import("file:///" + out.replace(/\\/g, "/"));

// 1. empty note -> block appended, outside text untouched
{
  const p = m.parseNote("# Title\n\nhello\n");
  assert.equal(p.hasBlock, false);
  const out = m.buildNote(p, { lanes: [{ id: "l1", name: "A", color: "#fff" }], bars: [], extra: [] });
  assert.ok(out.startsWith("# Title\n\nhello\n\n```gantt\n"));
}

// 2. round trip is byte-stable (no sync churn)
{
  const lane = { id: "l1", name: "Работа", color: "#7c6cf0" };
  const data = {
    lanes: [lane],
    bars: [
      { id: "b2", lane: "l1", name: "B", start: m.parseISO("2026-11-10"), end: m.parseISO("2026-11-12"), note: "line1\nline2 [[X]]", progress: 40 },
      { id: "b1", lane: "l1", name: "A", start: m.parseISO("2026-11-01"), end: m.parseISO("2026-11-05"), color: "#e8704a" },
    ],
    extra: [],
  };
  const text = m.newNoteText(data);
  const p = m.parseNote(text);
  const again = m.buildNote(p, p.data);
  assert.equal(again, text);
  assert.equal(p.data.bars.length, 2);
  assert.equal(p.data.bars[1].note, "line1\nline2 [[X]]");
  assert.ok(text.indexOf('"id":"b1"') < text.indexOf('"id":"b2"'), "sorted by start");
}

// 3. unknown / broken lines survive
{
  const text = '---\ngantt-plugin: timeline\n---\n```gantt\n{"t":"lane","id":"l1","name":"A","color":"#fff"}\nnot json\n{"t":"future","x":1}\n```\ntail\n';
  const p = m.parseNote(text);
  assert.deepEqual(p.data.extra, ["not json", '{"t":"future","x":1}']);
  const out = m.buildNote(p, p.data);
  assert.ok(out.includes("not json") && out.includes('"future"') && out.endsWith("```\ntail\n"));
}

// 4. orphan bars are repaired, bad dates preserved as extra
{
  const body = '{"t":"lane","id":"l1","name":"A","color":"#fff"}\n{"t":"bar","id":"b","lane":"zzz","name":"x","start":"2026-02-30","end":"2026-03-01"}\n{"t":"bar","id":"c","lane":"zzz","name":"y","start":"2026-03-01","end":"2026-02-27"}';
  const d = m.parseBlock(body);
  assert.equal(d.extra.length, 1);
  assert.equal(d.bars[0].lane, "l1");
  assert.ok(d.bars[0].start <= d.bars[0].end);
}

// 5. dates
{
  assert.equal(m.isoOf(m.parseISO("2026-11-16")), "2026-11-16");
  assert.equal(m.weekday(m.parseISO("2026-11-16")), 1); // Monday
  assert.equal(m.parseISO("2026-13-01"), null);
}

// 6. frontmatter sniffing
assert.ok(m.hasGanttFrontmatter("---\ngantt-plugin: timeline\n---\n"));
assert.ok(!m.hasGanttFrontmatter("---\ntitle: x\n---\n"));

// 7. independent edits from two devices merge without losing either side
{
  const base = m.newNoteText({
    lanes: [{ id: "l1", name: "Lane", color: "#111" }],
    bars: [{ id: "b1", lane: "l1", name: "Task", start: m.parseISO("2026-11-01"), end: m.parseISO("2026-11-02") }],
    extra: [],
  });
  const lp = m.parseNote(base);
  lp.data.lanes[0].name = "Local lane";
  lp.data.bars[0].progress = 50;
  const local = m.buildNote(lp, lp.data);
  const rp = m.parseNote(base.replace("---\n\n", "---\n\nRemote text\n\n"));
  rp.data.lanes[0].color = "#999";
  rp.data.bars[0].name = "Remote task";
  const remote = m.buildNote(rp, rp.data);
  const merged = m.mergeNoteChanges(base, local, remote);
  const result = m.parseNote(merged);
  assert.equal(result.data.lanes[0].name, "Local lane");
  assert.equal(result.data.lanes[0].color, "#999");
  assert.equal(result.data.bars[0].name, "Remote task");
  assert.equal(result.data.bars[0].progress, 50);
  assert.ok(merged.includes("Remote text"));
}

console.log("model tests passed");
