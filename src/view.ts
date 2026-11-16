import { Menu, Platform, TextFileView, WorkspaceLeaf, setIcon, type ViewStateResult } from "obsidian";
import type GanttNotesPlugin from "./main";
import {
  Bar,
  GanttData,
  Lane,
  PALETTE,
  ParsedNote,
  buildNote,
  isoOf,
  mergeNoteChanges,
  parseNote,
  todayDay,
  uid,
  weekday,
  DAY_MS,
} from "./model";
import { BarModal, LaneModal, confirmDialog } from "./modals";
import { locale, t } from "./i18n";

export const VIEW_TYPE = "gantt-notes-view";

const MIN_PPD = 2.5;
const MAX_PPD = 80;
const PRESETS: [keyof ReturnType<typeof presetNames>, number][] = [
  ["day", 36],
  ["week", 14],
  ["month", 5],
];
function presetNames() {
  return { day: t("day"), week: t("week"), month: t("month") };
}

const HEAD_H = 54;
const PAD = 8;
const GAP = 5;
const MIN_LANE_H = 46;
const COLLAPSED_H = 38;

interface LaneEls {
  row: HTMLElement;
  label: HTMLElement;
  track: HTMLElement;
  dot: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
  chev: HTMLElement;
}

interface Snapshot {
  lanes: Lane[];
  bars: Bar[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isLane = (value: unknown): value is Lane =>
  isObject(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.color === "string";
const isBar = (value: unknown): value is Bar =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.lane === "string" &&
  typeof value.name === "string" &&
  typeof value.start === "number" &&
  typeof value.end === "number";
const isSnapshot = (value: unknown): value is Snapshot =>
  isObject(value) &&
  Array.isArray(value.lanes) && value.lanes.every(isLane) &&
  Array.isArray(value.bars) && value.bars.every(isBar);

interface Gesture {
  kind: "move" | "rl" | "rr" | "create";
  pointerId: number;
  pointerType: string;
  sx: number;
  sy: number;
  slx: number;
  lastX: number;
  lastY: number;
  id: string;
  orig: { start: number; end: number; lane: string };
  anchor: number;
  laneId: string;
  active: boolean;
  changed: boolean;
  timer: number | null;
  snap: string;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class GanttView extends TextFileView {
  /**
   * Persistence model. NOTE: Obsidian's TextFileView owns fields such as `dirty`,
   * `data`, `saving` and `lastSavedData` and resets some of them inside save().
   * We therefore never reuse those names; instead the model carries a revision
   * counter, and getViewData() is a pure function of (model, revision).
   */
  private raw = ""; // last text produced from / loaded into the model
  private parsed: ParsedNote | null = null;
  private gd: GanttData = { lanes: [], bars: [], extra: [] };
  private rev = 0; // bumped on every model change
  private serRev = 0; // revision `raw` was serialised at
  private diskBase = ""; // last text known to be on disk (loaded or written)
  private saveChain: Promise<void> = Promise.resolve();
  private writeEpoch = 0; // bumped around each write, guards stale disk reads

  private ppd: number;
  private rStart = 0;
  private rEnd = 0;
  private lastRStart: number | null = null;
  private pendingInitialScroll = true;
  private headKey = "";

  private undoStack: string[] = [];
  private redoStack: string[] = [];

  private rootEl!: HTMLElement;
  private scroller!: HTMLElement;
  private inner!: HTMLElement;
  private headTicks!: HTMLElement;
  private headTop!: HTMLElement;
  private headBot!: HTMLElement;
  private body!: HTMLElement;
  private todayLine!: HTMLElement;
  private emptyEl!: HTMLElement;
  private tipEl!: HTMLElement;
  private presetBtns = new Map<string, HTMLElement>();
  private undoBtn!: HTMLElement;
  private redoBtn!: HTMLElement;

  private laneEls = new Map<string, LaneEls>();
  private barEls = new Map<string, HTMLElement>();

  private g: Gesture | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; ppd: number } | null = null;
  private raf = 0;
  private autoRaf = 0;
  private lastPointerType = "mouse";
  private suppressClickUntil = 0;
  private fmtCache = new Map<string, Intl.DateTimeFormat>();

  constructor(leaf: WorkspaceLeaf, private plugin: GanttNotesPlugin) {
    super(leaf);
    this.ppd = plugin.settings.defaultPpd;
  }

  // ---------------------------------------------------------------- view api

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return this.file?.basename ?? "Gantt";
  }
  getIcon() {
    return "gantt-chart";
  }

  getState() {
    return { ...super.getState(), ppd: this.ppd };
  }
  async setState(state: unknown, result: ViewStateResult) {
    if (typeof state === "object" && state !== null && "ppd" in state && typeof state.ppd === "number") {
      this.ppd = clamp(state.ppd, MIN_PPD, MAX_PPD);
    }
    return super.setState(state, result);
  }

  /** Called by Obsidian (also from inside save()). Idempotent and side-effect free. */
  getViewData(): string {
    if (this.parsed && this.rev !== this.serRev) {
      this.raw = buildNote(this.parsed, this.gd);
      this.serRev = this.rev;
    }
    return this.raw;
  }

  /** Local edits that are not on disk yet. */
  private hasUnsaved(): boolean {
    return !!this.parsed && (this.rev !== this.serRev || this.raw !== this.diskBase);
  }

  setViewData(data: string, clear: boolean): void {
    let merged = false;
    if (!clear && this.parsed) {
      if (this.hasUnsaved()) {
        // The file changed under us (sync) while we hold unsaved edits.
        if (data === this.diskBase) return; // duplicate event for a state we already merged
        const local = this.getViewData();
        const remote = data;
        data = mergeNoteChanges(this.diskBase, local, remote);
        this.diskBase = remote;
        merged = data !== remote;
        if (merged) this.plugin.notifySyncMerge();
      } else if (data === this.raw) {
        this.diskBase = data; // echo of our own write
        return;
      } else {
        this.diskBase = data;
      }
    } else {
      this.diskBase = data;
    }
    this.raw = data;
    this.parsed = parseNote(data);
    this.gd = this.parsed.data;
    this.serRev = this.rev;
    if (!clear) {
      // history snapshots predate the external change; undoing one would silently revert it
      this.undoStack = [];
      this.redoStack = [];
    }
    if (clear) {
      this.undoStack = [];
      this.redoStack = [];
      this.pendingInitialScroll = true;
    }
    if (this.scroller) {
      this.render();
      this.updateUndoButtons();
    }
    if (merged) this.queueSave();
  }

  clear(): void {
    this.raw = "";
    this.diskBase = "";
    this.parsed = null;
    this.gd = { lanes: [], bars: [], extra: [] };
    this.rev = 0;
    this.serRev = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.pendingInitialScroll = true;
    if (this.scroller) {
      for (const [, e] of this.laneEls) e.row.remove();
      this.laneEls.clear();
      this.barEls.clear();
    }
  }

  onPaneMenu(menu: Menu, source: string) {
    super.onPaneMenu(menu, source);
    menu.addItem((i) =>
      i.setTitle(t("openMd")).setIcon("file-text").onClick(() => this.plugin.openAsMarkdown(this.leaf))
    );
  }

  onResize() {
    if (this.pendingInitialScroll && this.scroller?.clientWidth) {
      this.render();
    } else if (this.scroller) {
      this.scheduleRender();
    }
  }

  async onOpen() {
    this.buildDom();
  }

  async onClose() {
    await this.saveChain;
    if (this.hasUnsaved()) {
      this.queueSave();
      await this.saveChain;
    }
    window.cancelAnimationFrame(this.raf);
    window.cancelAnimationFrame(this.autoRaf);
    this.tipEl?.remove();
  }

  applySettings() {
    if (!this.scroller) return;
    this.headKey = "";
    this.render();
  }

  // --------------------------------------------------------------------- dom

  private buildDom() {
    const c = this.contentEl;
    c.empty();
    c.addClass("gantt-notes-host");
    this.rootEl = c.createDiv({ cls: "gantt-notes" });

    // toolbar
    const bar = this.rootEl.createDiv({ cls: "g-toolbar" });
    const left = bar.createDiv({ cls: "g-tools" });
    const mid = bar.createDiv({ cls: "g-tools g-seg" });
    const right = bar.createDiv({ cls: "g-tools" });

    const btn = (parent: HTMLElement, icon: string, label: string, fn: () => void, text?: string) => {
      const b = parent.createEl("button", { cls: "g-btn" + (text ? " has-text" : "") });
      b.setAttr("aria-label", label);
      setIcon(b.createSpan({ cls: "g-ic" }), icon);
      if (text) b.createSpan({ text, cls: "g-btn-text" });
      b.addEventListener("click", fn);
      return b;
    };

    btn(left, "plus", t("addBar"), () => this.addBarInteractive(), t("addBar"));
    btn(left, "rows-3", t("addLane"), () => this.addLaneInteractive());
    this.undoBtn = btn(left, "undo-2", t("undo"), () => this.undo());
    this.redoBtn = btn(left, "redo-2", t("redo"), () => this.redo());

    for (const [key, ppd] of PRESETS) {
      const b = mid.createEl("button", { cls: "g-seg-btn", text: presetNames()[key] });
      b.addEventListener("click", () => this.setPpd(ppd));
      this.presetBtns.set(key, b);
    }

    btn(right, "zoom-out", t("zoomOut"), () => this.setPpd(this.ppd / 1.35));
    btn(right, "zoom-in", t("zoomIn"), () => this.setPpd(this.ppd * 1.35));
    btn(right, "crosshair", t("today"), () => this.scrollToDay(todayDay(), true), t("today"));

    // scroller
    this.scroller = this.rootEl.createDiv({ cls: "g-scroll" });
    this.scroller.tabIndex = 0;
    this.inner = this.scroller.createDiv({ cls: "g-inner" });

    const head = this.inner.createDiv({ cls: "g-head" });
    head.createDiv({ cls: "g-corner" });
    this.headTicks = head.createDiv({ cls: "g-ticks" });
    this.headTop = this.headTicks.createDiv({ cls: "g-tier g-tier-top" });
    this.headBot = this.headTicks.createDiv({ cls: "g-tier g-tier-bot" });

    this.body = this.inner.createDiv({ cls: "g-body" });
    this.todayLine = this.body.createDiv({ cls: "g-today" });

    this.emptyEl = this.rootEl.createDiv({ cls: "g-empty is-hidden" });
    this.emptyEl.createDiv({ cls: "g-empty-title", text: t("emptyTitle") });
    this.emptyEl.createDiv({ cls: "g-empty-hint", text: t("emptyHint") });
    const eb = this.emptyEl.createEl("button", { cls: "mod-cta", text: t("addLane") });
    eb.addEventListener("click", () => this.addLaneInteractive());

    this.tipEl = activeDocument.body.createDiv({ cls: "g-tip is-hidden" });

    this.bindEvents();
    this.updateUndoButtons();
    this.applyStaticVars();
  }

  private bindEvents() {
    const s = this.scroller;
    this.registerDomEvent(s, "pointerdown", (e) => this.onPointerDown(e));
    this.registerDomEvent(s, "pointermove", (e) => this.onPointerMove(e));
    this.registerDomEvent(s, "pointerup", (e) => this.onPointerUp(e));
    this.registerDomEvent(s, "pointercancel", (e) => this.onPointerCancel(e));
    this.registerDomEvent(s, "lostpointercapture", (e) => {
      if (this.g?.active && e.pointerId === this.g.pointerId) this.onPointerCancel(e);
    });
    this.registerDomEvent(s, "click", (e) => this.onClick(e));
    this.registerDomEvent(s, "dblclick", (e) => this.onDblClick(e));
    this.registerDomEvent(s, "contextmenu", (e) => this.onContextMenu(e));
    this.registerDomEvent(s, "wheel", (e) => this.onWheel(e), { passive: false });
    this.registerDomEvent(
      s,
      "touchmove",
      (e) => {
        if (this.g?.active || this.pinch) e.preventDefault();
      },
      { passive: false }
    );
    this.registerDomEvent(s, "keydown", (e) => this.onKey(e));

    // App lifecycle (event driven, nothing polls): never lose edits when the
    // app is backgrounded/killed, and pick up sync results when it returns.
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (activeDocument.visibilityState === "hidden") this.flush();
      else void this.refreshFromDisk();
    });
    this.registerDomEvent(window, "pagehide", () => this.flush());
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) void this.refreshFromDisk();
      })
    );
  }

  private applyStaticVars() {
    const st = this.plugin.settings;
    const r = this.rootEl;
    r.style.setProperty("--g-label-w", st.labelWidth + "px");
    r.style.setProperty("--g-bar-h", st.barHeight + "px");
    r.style.setProperty("--g-head-h", HEAD_H + "px");
    r.toggleClass("no-anim", !st.animations);
    r.toggleClass("no-weekend", !st.weekendShade);
    r.toggleClass("no-today", !st.todayLine);
  }

  // ----------------------------------------------------------------- history

  private snap(): string {
    return JSON.stringify({ lanes: this.gd.lanes, bars: this.gd.bars });
  }
  private restore(s: string) {
    const o = JSON.parse(s) as unknown;
    if (!isSnapshot(o)) throw new Error("Invalid Gantt history snapshot");
    this.gd.lanes = o.lanes;
    this.gd.bars = o.bars;
  }
  private pushUndo(s: string) {
    this.undoStack.push(s);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoButtons();
  }
  private changed() {
    this.rev++;
    this.queueSave();
    this.render();
  }

  /** A gesture finished with a real change: persist it right away. */
  private commitGesture() {
    this.rev++;
    this.queueSave();
  }

  /**
   * Save every completed edit immediately (important on mobile, where the app
   * can be killed at any moment). Writes are strictly sequential.
   */
  private queueSave() {
    this.saveChain = this.saveChain.then(async () => {
      if (!this.file || !this.parsed || !this.hasUnsaved()) return;
      const file = this.file;
      const text = this.getViewData();
      this.writeEpoch++;
      try {
        await this.save();
        // save() can skip silently (it compares against its own bookkeeping), so
        // verify against the real file and fall back to a direct write.
        let onDisk = await this.app.vault.read(file);
        if (onDisk !== text) {
          await this.app.vault.modify(file, text);
          onDisk = await this.app.vault.read(file);
          if (onDisk !== text) throw new Error("Gantt Notes: file content differs after write");
        }
        this.diskBase = text;
      } catch (error) {
        this.plugin.notifySaveError(error);
      } finally {
        this.writeEpoch++;
      }
    });
  }

  /** Write anything pending, e.g. when the app is about to go to the background. */
  flush() {
    if (this.hasUnsaved()) this.queueSave();
  }

  /**
   * Pick up a change that sync tools made while the app was in the background.
   * Event driven only (called when the app/leaf becomes active again).
   */
  async refreshFromDisk() {
    const file = this.file;
    if (!file || !this.parsed) return;
    const epoch = this.writeEpoch;
    let text: string;
    try {
      text = await this.app.vault.read(file);
    } catch {
      return;
    }
    // a write started or finished while we were reading → the read may be stale
    if (epoch % 2 === 1 || epoch !== this.writeEpoch || text === this.diskBase) return;
    this.setViewData(text, false);
  }
  private mutate(fn: () => void) {
    const s = this.snap();
    fn();
    this.pushUndo(s);
    this.changed();
  }
  undo() {
    const s = this.undoStack.pop();
    if (s === undefined) return;
    this.redoStack.push(this.snap());
    this.restore(s);
    this.updateUndoButtons();
    this.changed();
  }
  redo() {
    const s = this.redoStack.pop();
    if (s === undefined) return;
    this.undoStack.push(this.snap());
    this.restore(s);
    this.updateUndoButtons();
    this.changed();
  }
  private updateUndoButtons() {
    this.undoBtn?.toggleClass("is-disabled", !this.undoStack.length);
    this.redoBtn?.toggleClass("is-disabled", !this.redoStack.length);
  }

  // ------------------------------------------------------------------ helpers

  private barById(id: string) {
    return this.gd.bars.find((b) => b.id === id);
  }
  private laneById(id: string) {
    return this.gd.lanes.find((l) => l.id === id);
  }
  private allIds() {
    return new Set([...this.gd.lanes.map((l) => l.id), ...this.gd.bars.map((b) => b.id)]);
  }
  private fmt(day: number, opts: Intl.DateTimeFormatOptions): string {
    const key = JSON.stringify(opts);
    let f = this.fmtCache.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat(locale(), { ...opts, timeZone: "UTC" });
      this.fmtCache.set(key, f);
    }
    return f.format(new Date(day * DAY_MS));
  }
  private rangeText(b: { start: number; end: number }) {
    const o: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
    const n = b.end - b.start + 1;
    return `${this.fmt(b.start, o)} – ${this.fmt(b.end, o)} · ${n} ${t("daysShort")}`;
  }
  private floorToWeek(day: number) {
    const ws = this.plugin.settings.weekStart;
    return day - ((weekday(day) - ws + 7) % 7);
  }
  private dayAtClientX(x: number) {
    const r = this.headTicks.getBoundingClientRect();
    return this.rStart + Math.floor((x - r.left) / this.ppd);
  }

  // -------------------------------------------------------------------- range

  private computeRange() {
    if (this.g?.active) return; // keep geometry stable while dragging
    const td = todayDay();
    let min = td, max = td;
    for (const b of this.gd.bars) {
      if (b.start < min) min = b.start;
      if (b.end > max) max = b.end;
    }
    const vw = Math.max(this.scroller.clientWidth, 600);
    const viewDays = Math.ceil(vw / this.ppd);
    this.rStart = this.floorToWeek(min - 60 - Math.ceil(viewDays / 3));
    this.rEnd = Math.max(max + 120 + Math.ceil(viewDays / 3), this.rStart + viewDays + 120);
  }

  // ------------------------------------------------------------------- render

  private scheduleRender() {
    if (this.raf) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  render() {
    if (!this.scroller) return;
    window.cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.applyStaticVars();

    const st = this.plugin.settings;
    const ppd = this.ppd;
    this.computeRange();
    if (this.lastRStart !== null && this.lastRStart !== this.rStart && !this.pendingInitialScroll) {
      this.scroller.scrollLeft += (this.lastRStart - this.rStart) * ppd;
    }
    this.lastRStart = this.rStart;

    const days = this.rEnd - this.rStart + 1;
    const W = days * ppd;
    const r = this.rootEl;
    r.style.setProperty("--g-ppd", ppd + "px");
    r.style.setProperty("--g-w", W + "px");
    const satOff = (6 - st.weekStart + 7) % 7;
    r.style.setProperty("--g-we-x", satOff * ppd + "px");
    r.toggleClass("show-days", ppd >= 16);
    r.toggleClass("show-weeks", ppd < 16);

    this.buildHead();
    this.layoutLanes();

    // today line
    const tx = (todayDay() - this.rStart) * ppd + ppd / 2;
    this.todayLine.style.left = `calc(var(--g-label-w) + ${tx}px)`;

    this.emptyEl.toggleClass("is-hidden", this.gd.lanes.length > 0);
    for (const [key, ppdP] of PRESETS) {
      const near = PRESETS.reduce((a, b) => (Math.abs(b[1] - ppd) < Math.abs(a[1] - ppd) ? b : a));
      this.presetBtns.get(key)?.toggleClass("is-on", near[0] === key && Math.abs(ppdP - ppd) / ppdP < 0.35);
    }

    if (this.pendingInitialScroll && this.scroller.clientWidth > 0) {
      this.pendingInitialScroll = false;
      this.scrollToDay(todayDay(), false);
    }
  }

  private buildHead() {
    const ppd = this.ppd;
    const ws = this.plugin.settings.weekStart;
    const key = [this.rStart, this.rEnd, ppd, ws, locale()].join("|");
    if (key === this.headKey) return;
    this.headKey = key;

    const topF = createFragment();
    let cursor = this.rStart;
    while (cursor <= this.rEnd) {
      const d = new Date(cursor * DAY_MS);
      const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY_MS;
      const segEnd = Math.min(next - 1, this.rEnd);
      const w = (segEnd - cursor + 1) * ppd;
      const el = createDiv({ cls: "g-cell g-month" });
      el.style.left = (cursor - this.rStart) * ppd + "px";
      el.style.width = w + "px";
      const label =
        w >= 130
          ? this.fmt(cursor, { month: "long", year: "numeric" })
          : w >= 64
          ? this.fmt(cursor, { month: "short", year: "2-digit" })
          : w >= 28
          ? this.fmt(cursor, { month: "short" })
          : "";
      const sp = el.createSpan({ text: label });
      sp.className = "g-cell-text";
      topF.appendChild(el);
      cursor = next;
    }
    this.headTop.replaceChildren(topF);

    const botF = createFragment();
    const td = todayDay();
    if (ppd >= 16) {
      for (let day = this.rStart; day <= this.rEnd; day++) {
        const el = createDiv();
        const wd = weekday(day);
        el.className = "g-cell g-day" + (wd === 0 || wd === 6 ? " is-we" : "") + (day === td ? " is-today" : "");
        el.style.left = (day - this.rStart) * ppd + "px";
        el.style.width = ppd + "px";
        const n = createSpan();
        n.className = "g-cell-text";
        n.textContent = String(new Date(day * DAY_MS).getUTCDate());
        el.appendChild(n);
        if (ppd >= 30) {
          const w = createSpan();
          w.className = "g-cell-sub";
          w.textContent = this.fmt(day, { weekday: "short" });
          el.appendChild(w);
        }
        botF.appendChild(el);
      }
    } else {
      const k = Math.max(1, Math.ceil(34 / (7 * ppd)));
      for (let day = this.rStart; day <= this.rEnd; day += 7 * k) {
        const el = createDiv();
        el.className = "g-cell g-week";
        el.style.left = (day - this.rStart) * ppd + "px";
        el.style.width = 7 * k * ppd + "px";
        const n = createSpan();
        n.className = "g-cell-text";
        n.textContent = String(new Date(day * DAY_MS).getUTCDate());
        el.appendChild(n);
        botF.appendChild(el);
      }
    }
    this.headBot.replaceChildren(botF);
  }

  private createLaneEl(lane: Lane): LaneEls {
    const row = this.body.createDiv({ cls: "g-lane entering" });
    const label = row.createDiv({ cls: "g-label" });
    const chev = label.createDiv({ cls: "g-chev" });
    setIcon(chev, "chevron-down");
    const dot = label.createDiv({ cls: "g-dot" });
    const name = label.createDiv({ cls: "g-lane-name" });
    const count = label.createDiv({ cls: "g-count" });
    const add = label.createDiv({ cls: "g-lane-add" });
    setIcon(add, "plus");
    const track = row.createDiv({ cls: "g-track" });
    track.dataset.lane = lane.id;

    chev.addEventListener("click", (e) => {
      e.stopPropagation();
      this.mutate(() => {
        const l = this.laneById(lane.id);
        if (l) l.collapsed = !l.collapsed || undefined;
      });
    });
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      this.addBarInteractive(lane.id);
    });
    label.addEventListener("click", () => this.editLane(lane.id));
    window.setTimeout(() => row.removeClass("entering"), 450);
    return { row, label, track, dot, name, count, chev };
  }

  private layoutLanes() {
    const st = this.plugin.settings;
    const ppd = this.ppd;
    const barH = st.barHeight;
    const alive = new Set<string>();

    // group bars by lane
    const byLane = new Map<string, Bar[]>();
    for (const l of this.gd.lanes) byLane.set(l.id, []);
    for (const b of this.gd.bars) byLane.get(b.lane)?.push(b);

    let idx = 0;
    for (const lane of this.gd.lanes) {
      alive.add(lane.id);
      let L = this.laneEls.get(lane.id);
      if (!L) {
        L = this.createLaneEl(lane);
        this.laneEls.set(lane.id, L);
      }
      // keep DOM order = data order (todayLine is child 0)
      const want = this.body.children[idx + 1];
      if (want !== L.row) this.body.insertBefore(L.row, want ?? null);
      idx++;

      L.row.toggleClass("is-collapsed", !!lane.collapsed);
      L.dot.style.setProperty("--c", lane.color);
      L.name.setText(lane.name || t("newLane"));
      L.name.toggleClass("is-unnamed", !lane.name);

      const bars = (byLane.get(lane.id) ?? []).slice().sort((a, b) => a.start - b.start || a.end - b.end);
      L.count.setText(bars.length ? String(bars.length) : "");

      // greedy sub-row packing
      const rowsEnd: number[] = [];
      const rowOf = new Map<string, number>();
      for (const b of bars) {
        let r = rowsEnd.findIndex((e) => e < b.start);
        if (r < 0) {
          r = rowsEnd.length;
          rowsEnd.push(b.end);
        } else rowsEnd[r] = b.end;
        rowOf.set(b.id, r);
      }
      const nRows = Math.max(1, rowsEnd.length);
      const h = lane.collapsed ? COLLAPSED_H : Math.max(MIN_LANE_H, PAD * 2 + nRows * barH + (nRows - 1) * GAP);
      L.row.style.height = h + "px";

      for (const b of bars) {
        let el = this.barEls.get(b.id);
        if (!el) {
          el = this.createBarEl(b);
          this.barEls.set(b.id, el);
        }
        if (el.parentElement !== L.track) L.track.appendChild(el);
        this.updateBarEl(el, b, lane, rowOf.get(b.id) ?? 0, barH, ppd);
      }
    }

    // remove stale lanes / bars
    for (const [id, L] of this.laneEls) {
      if (!alive.has(id)) {
        this.laneEls.delete(id);
        this.fadeOut(L.row, true);
      }
    }
    const barIds = new Set(this.gd.bars.map((b) => b.id));
    for (const [id, el] of this.barEls) {
      if (!barIds.has(id)) {
        this.barEls.delete(id);
        // if its lane vanished the row is fading anyway
        this.fadeOut(el, false);
      }
    }
  }

  private fadeOut(el: HTMLElement, collapse: boolean) {
    if (!this.plugin.settings.animations) return el.remove();
    el.addClass("leaving");
    if (collapse) el.addClass("collapsing");
    window.setTimeout(() => el.remove(), 220);
  }

  private createBarEl(b: Bar): HTMLElement {
    const el = createDiv({ cls: "g-bar entering" });
    el.dataset.id = b.id;
    el.createDiv({ cls: "g-bar-fill" });
    el.createSpan({ cls: "g-bar-label" });
    const ic = el.createSpan({ cls: "g-bar-ic" });
    setIcon(ic, "sticky-note");
    el.createEl("i", { cls: "g-h g-h-l" });
    el.createEl("i", { cls: "g-h g-h-r" });
    window.setTimeout(() => el.removeClass("entering"), 450);
    return el;
  }

  private updateBarEl(el: HTMLElement, b: Bar, lane: Lane, row: number, barH: number, ppd: number) {
    const left = (b.start - this.rStart) * ppd;
    const width = (b.end - b.start + 1) * ppd;
    el.style.left = left + "px";
    el.style.width = Math.max(width, 6) + "px";
    el.style.top = PAD + row * (barH + GAP) + "px";
    el.style.height = barH + "px";
    el.style.setProperty("--c", b.color || lane.color);
    el.style.setProperty("--p", (b.progress ?? 0) + "%");
    const name = b.name || t("untitled");
    const label = el.querySelector<HTMLElement>(".g-bar-label")!;
    if (label.textContent !== name) label.textContent = name;
    el.toggleClass("is-unnamed", !b.name);
    el.toggleClass("has-note", !!b.note);
    el.toggleClass("has-progress", !!b.progress);
    el.toggleClass("is-narrow", width < Math.min(name.length, 18) * 7 + 22);
    el.toggleClass("is-short", width < 40);
    if (!Platform.isMobile) {
      el.title = `${name}\n${this.rangeText(b)}${b.note ? "\n\n" + b.note : ""}`;
    }
  }

  // ------------------------------------------------------------------- zoom

  private setPpd(next: number, anchorX?: number) {
    const old = this.ppd;
    next = clamp(next, MIN_PPD, MAX_PPD);
    if (Math.abs(next - old) < 0.001) return;
    const rect = this.scroller.getBoundingClientRect();
    const labelW = this.plugin.settings.labelWidth;
    const ax = anchorX !== undefined ? anchorX - rect.left : labelW + (rect.width - labelW) / 2;
    const dayF = (this.scroller.scrollLeft + ax - labelW) / old;
    this.ppd = next;
    this.render();
    this.scroller.scrollLeft = dayF * next - (ax - labelW);
    this.app.workspace.requestSaveLayout();
  }

  private scrollToDay(day: number, smooth: boolean) {
    const labelW = this.plugin.settings.labelWidth;
    const x = (day - this.rStart) * this.ppd + this.ppd / 2;
    this.scroller.scrollTo({
      left: Math.max(0, x - (this.scroller.clientWidth - labelW) / 2),
      behavior: smooth && this.plugin.settings.animations ? "smooth" : "auto",
    });
  }

  private onWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.setPpd(this.ppd * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX);
    }
  }

  // ---------------------------------------------------------------- keyboard

  private onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
    } else if (e.key === "Escape" && this.g) {
      this.cancelGesture(true);
    }
  }

  // ---------------------------------------------------------------- gestures

  private onPointerDown(e: PointerEvent) {
    this.lastPointerType = e.pointerType;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (e.pointerType === "touch" && this.pointers.size === 2) {
      this.cancelGesture(true);
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), ppd: this.ppd };
      return;
    }
    if (this.g || this.pinch) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const target = e.target as HTMLElement;
    const track = target.closest<HTMLElement>(".g-track");
    if (!track) return;
    const barEl = target.closest<HTMLElement>(".g-bar");
    const handle = target.closest<HTMLElement>(".g-h");

    const g: Gesture = {
      kind: "create",
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      sx: e.clientX,
      sy: e.clientY,
      slx: this.scroller.scrollLeft,
      lastX: e.clientX,
      lastY: e.clientY,
      id: "",
      orig: { start: 0, end: 0, lane: "" },
      anchor: this.dayAtClientX(e.clientX),
      laneId: track.dataset.lane ?? "",
      active: false,
      changed: false,
      timer: null,
      snap: this.snap(),
    };
    if (barEl) {
      const bar = this.barById(barEl.dataset.id ?? "");
      if (!bar) return;
      g.id = bar.id;
      g.orig = { start: bar.start, end: bar.end, lane: bar.lane };
      g.kind = handle ? (handle.hasClass("g-h-l") ? "rl" : "rr") : "move";
    } else if (this.laneById(g.laneId)?.collapsed) {
      return;
    }

    this.g = g;
    if (e.pointerType !== "mouse") {
      g.timer = window.setTimeout(() => {
        g.timer = null;
        if (this.g === g && !g.active) this.activate(g);
      }, 280);
    }
  }

  private activate(g: Gesture) {
    g.active = true;
    try {
      this.scroller.setPointerCapture(g.pointerId);
    } catch {
      /* pointer may already be gone */
    }
    this.rootEl.addClass("is-dragging");
    if (g.kind === "create") {
      const bar: Bar = {
        id: uid(this.allIds()),
        lane: g.laneId,
        name: "",
        start: g.anchor,
        end: g.anchor,
      };
      this.gd.bars.push(bar);
      g.id = bar.id;
      g.changed = true;
      this.render();
    }
    this.barEls.get(g.id)?.addClass("dragging");
    if (g.pointerType === "touch") navigator.vibrate?.(8);
    this.showTip(g);
    this.startAutoScroll(g);
  }

  private onPointerMove(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch.dist > 0) this.setPpd(this.pinch.ppd * (d / this.pinch.dist), (a.x + b.x) / 2);
      return;
    }
    const g = this.g;
    if (!g || g.pointerId !== e.pointerId) return;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    if (!g.active) {
      const dist = Math.hypot(e.clientX - g.sx, e.clientY - g.sy);
      if (g.pointerType === "mouse") {
        if (dist > 3) this.activate(g);
      } else if (dist > 10) {
        this.cancelGesture(false); // user is scrolling
      }
      if (!g.active) return;
    }
    e.preventDefault();
    this.applyGesture(g);
  }

  private applyGesture(g: Gesture) {
    const bar = this.barById(g.id);
    if (!bar) return;
    const ppd = this.ppd;
    const dd = Math.round((g.lastX - g.sx + (this.scroller.scrollLeft - g.slx)) / ppd);
    const lo = this.rStart, hi = this.rEnd;
    const len = g.orig.end - g.orig.start;

    if (g.kind === "move") {
      const s = clamp(g.orig.start + dd, lo, hi - len);
      bar.start = s;
      bar.end = s + len;
      const lane = this.laneAtY(g.lastY);
      if (lane) bar.lane = lane;
    } else if (g.kind === "rl") {
      bar.start = clamp(g.orig.start + dd, lo, g.orig.end);
    } else if (g.kind === "rr") {
      bar.end = clamp(g.orig.end + dd, g.orig.start, hi);
    } else {
      const cur = clamp(this.dayAtClientX(g.lastX), lo, hi);
      bar.start = Math.min(g.anchor, cur);
      bar.end = Math.max(g.anchor, cur);
    }
    g.changed = true;
    this.updateTip(g, bar);
    this.scheduleRender();
  }

  private laneAtY(y: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const l of this.gd.lanes) {
      if (l.collapsed) continue;
      const el = this.laneEls.get(l.id);
      if (!el) continue;
      const r = el.row.getBoundingClientRect();
      if (y >= r.top && y < r.bottom) return l.id;
      const d = Math.min(Math.abs(y - r.top), Math.abs(y - r.bottom));
      if (d < bestD) {
        bestD = d;
        best = l.id;
      }
    }
    return best;
  }

  private startAutoScroll(g: Gesture) {
    const tick = () => {
      if (this.g !== g || !g.active) return;
      const r = this.scroller.getBoundingClientRect();
      const labelW = this.plugin.settings.labelWidth;
      const edge = 56;
      let v = 0;
      if (g.lastX < r.left + labelW + edge) v = -((r.left + labelW + edge - g.lastX) / edge);
      else if (g.lastX > r.right - edge) v = (g.lastX - (r.right - edge)) / edge;
      if (v) {
        this.scroller.scrollLeft += clamp(v, -1.5, 1.5) * 14;
        this.applyGesture(g);
      }
      this.autoRaf = window.requestAnimationFrame(tick);
    };
    this.autoRaf = window.requestAnimationFrame(tick);
  }

  private onPointerUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    const g = this.g;
    if (!g || g.pointerId !== e.pointerId) return;
    if (g.timer) window.clearTimeout(g.timer);
    g.timer = null;

    if (!g.active) {
      // A plain click / tap: the editor is opened from the `click` event that
      // follows. Opening it here would let that click land on the modal backdrop
      // and dismiss it again (this is what happens with taps on touch screens).
      this.g = null;
      return;
    }
    this.endGesture(g, false);
    if (g.kind === "create") {
      const bar = this.barById(g.id);
      if (bar) this.openBarModal(bar, true, g.snap);
    } else if (g.changed) {
      const now = this.snap();
      if (now !== g.snap) {
        this.pushUndo(g.snap);
        this.commitGesture();
      }
    }
    this.render();
  }

  private onPointerCancel(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pinch && this.pointers.size < 2) this.pinch = null;
    if (this.g && this.g.pointerId === e.pointerId) this.cancelGesture(this.g.active);
  }

  private endGesture(g: Gesture, release = true) {
    window.cancelAnimationFrame(this.autoRaf);
    if (g.timer) window.clearTimeout(g.timer);
    if (release) {
      try {
        this.scroller.releasePointerCapture(g.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (g.active) this.suppressClickUntil = performance.now() + 400; // the click that ends a drag is not a tap
    this.rootEl.removeClass("is-dragging");
    this.barEls.get(g.id)?.removeClass("dragging");
    this.tipEl.addClass("is-hidden");
    this.g = null;
  }

  private cancelGesture(revert: boolean) {
    const g = this.g;
    if (!g) return;
    const wasActive = g.active;
    this.endGesture(g);
    if (revert && wasActive) {
      this.restore(g.snap);
      this.render();
    }
  }

  private onClick(e: MouseEvent) {
    if (performance.now() < this.suppressClickUntil) return;
    const barEl = (e.target as HTMLElement).closest<HTMLElement>(".g-bar");
    if (barEl?.dataset.id) this.editBar(barEl.dataset.id);
  }

  private onDblClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest(".g-bar")) return;
    const track = target.closest<HTMLElement>(".g-track");
    if (!track) return;
    const laneId = track.dataset.lane ?? "";
    if (this.laneById(laneId)?.collapsed) return;
    const day = this.dayAtClientX(e.clientX);
    const snap = this.snap();
    const bar: Bar = { id: uid(this.allIds()), lane: laneId, name: "", start: day, end: day + 2 };
    this.gd.bars.push(bar);
    this.render();
    this.openBarModal(bar, true, snap);
  }

  private onContextMenu(e: MouseEvent) {
    if (this.lastPointerType !== "mouse") {
      e.preventDefault();
      return;
    }
    const barEl = (e.target as HTMLElement).closest<HTMLElement>(".g-bar");
    if (!barEl) return;
    e.preventDefault();
    const id = barEl.dataset.id ?? "";
    const m = new Menu();
    m.addItem((i) => i.setTitle(t("edit")).setIcon("pencil").onClick(() => this.editBar(id)));
    m.addItem((i) => i.setTitle(t("duplicate")).setIcon("copy").onClick(() => this.duplicateBar(id)));
    m.addSeparator();
    m.addItem((i) => i.setTitle(t("delete")).setIcon("trash-2").onClick(() => this.deleteBar(id)));
    m.showAtMouseEvent(e);
  }

  // -------------------------------------------------------------------- tip

  private showTip(g: Gesture) {
    this.tipEl.removeClass("is-hidden");
    const bar = this.barById(g.id);
    if (bar) this.updateTip(g, bar);
  }
  private updateTip(g: Gesture, bar: Bar) {
    this.tipEl.setText(this.rangeText(bar));
    const touch = g.pointerType !== "mouse";
    this.tipEl.style.left = g.lastX + "px";
    this.tipEl.style.top = g.lastY + (touch ? -64 : -34) + "px";
  }

  // ---------------------------------------------------------------- actions

  private openBarModal(bar: Bar, isNew: boolean, snapBefore: string) {
    new BarModal(this.app, bar, this.gd.lanes, isNew, {
      save: (nb) => {
        let cur = this.barById(bar.id);
        if (!cur) {
          // the model was replaced (sync) while the dialog was open: keep the user's input
          if (!isNew) return;
          cur = { ...nb };
          this.gd.bars.push(cur);
        }
        const before = isNew ? snapBefore : this.snap();
        Object.assign(cur, nb);
        // drop optional fields that were cleared
        if (!nb.color) delete cur.color;
        if (!nb.progress) delete cur.progress;
        if (!nb.note) delete cur.note;
        this.pushUndo(before);
        this.changed();
      },
      del: () => {
        if (isNew) {
          this.restore(snapBefore);
          this.render();
        } else void this.deleteBar(bar.id);
      },
      dup: () => this.duplicateBar(bar.id),
      cancel: () => {
        if (isNew) {
          this.restore(snapBefore);
          this.render();
        }
      },
    }).open();
  }

  private editBar(id: string) {
    const bar = this.barById(id);
    if (bar) this.openBarModal(bar, false, this.snap());
  }

  private duplicateBar(id: string) {
    const bar = this.barById(id);
    if (!bar) return;
    this.mutate(() => {
      const len = bar.end - bar.start + 1;
      this.gd.bars.push({ ...bar, id: uid(this.allIds()), start: bar.start + len, end: bar.end + len });
    });
  }

  private async deleteBar(id: string) {
    if (this.plugin.settings.confirmDelete && !(await confirmDialog(this.app, t("confirmDeleteBar"), t("delete")))) return;
    this.mutate(() => {
      this.gd.bars = this.gd.bars.filter((b) => b.id !== id);
    });
  }

  private async deleteLane(id: string) {
    const count = this.gd.bars.filter((bar) => bar.lane === id).length;
    if (count && this.plugin.settings.confirmDelete) {
      const confirmed = await confirmDialog(this.app, t("confirmDeleteLane"), t("delete"));
      if (!confirmed) return;
    }
    this.mutate(() => {
      this.gd.lanes = this.gd.lanes.filter((lane) => lane.id !== id);
      this.gd.bars = this.gd.bars.filter((bar) => bar.lane !== id);
    });
  }

  private addBarInteractive(laneId?: string) {
    if (!this.gd.lanes.length) return this.addLaneInteractive();
    const lane = (laneId && this.laneById(laneId)) || this.gd.lanes.find((l) => !l.collapsed) || this.gd.lanes[0];
    // start near the middle of the viewport so the new bar is visible
    const labelW = this.plugin.settings.labelWidth;
    const mid = Math.round(
      this.rStart + (this.scroller.scrollLeft + (this.scroller.clientWidth - labelW) / 2) / this.ppd
    );
    const snap = this.snap();
    if (lane.collapsed) lane.collapsed = undefined;
    const bar: Bar = { id: uid(this.allIds()), lane: lane.id, name: "", start: mid, end: mid + 6 };
    this.gd.bars.push(bar);
    this.render();
    this.openBarModal(bar, true, snap);
  }

  private addLaneInteractive() {
    const snap = this.snap();
    const lane: Lane = {
      id: uid(this.allIds()),
      name: "",
      color: PALETTE[this.gd.lanes.length % PALETTE.length],
    };
    this.gd.lanes.push(lane);
    this.render();
    this.openLaneModal(lane, true, snap);
  }

  private editLane(id: string) {
    const lane = this.laneById(id);
    if (lane) this.openLaneModal(lane, false, this.snap());
  }

  private openLaneModal(lane: Lane, isNew: boolean, snapBefore: string) {
    new LaneModal(this.app, lane, isNew, {
      save: (nl) => {
        const cur = this.laneById(lane.id);
        if (!cur) return;
        const before = isNew ? snapBefore : this.snap();
        cur.name = nl.name;
        cur.color = nl.color;
        this.pushUndo(before);
        this.changed();
      },
      del: () => void this.deleteLane(lane.id),
      move: (dir) => {
        const i = this.gd.lanes.findIndex((l) => l.id === lane.id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= this.gd.lanes.length) return;
        this.mutate(() => {
          const [l] = this.gd.lanes.splice(i, 1);
          this.gd.lanes.splice(j, 0, l);
        });
      },
      cancel: () => {
        if (isNew) {
          this.restore(snapBefore);
          this.render();
        }
      },
    }).open();
  }
}

export { isoOf };
