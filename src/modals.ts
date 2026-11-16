import { App, Modal, Setting } from "obsidian";
import { Bar, Lane, PALETTE, isoOf, parseISO } from "./model";
import { t } from "./i18n";

function swatches(
  parent: HTMLElement,
  current: string | undefined,
  onPick: (c: string | undefined) => void,
  allowInherit: boolean
) {
  const wrap = parent.createDiv({ cls: "g-swatches" });
  const items: { el: HTMLElement; value: string | undefined }[] = [];
  const mark = (v: string | undefined) => items.forEach((i) => i.el.toggleClass("is-on", i.value === v));
  const add = (value: string | undefined, label?: string) => {
    const el = wrap.createDiv({ cls: "g-swatch" + (value === undefined ? " is-inherit" : "") });
    if (value) el.style.setProperty("--c", value);
    if (label) el.setAttr("aria-label", label);
    el.onclick = () => {
      mark(value);
      onPick(value);
    };
    items.push({ el, value });
  };
  if (allowInherit) add(undefined, t("inherit"));
  PALETTE.forEach((c) => add(c));
  mark(current);
  return wrap;
}

export interface BarModalCallbacks {
  save: (b: Bar) => void;
  del: () => void;
  dup: () => void;
  cancel: () => void;
}

export class BarModal extends Modal {
  private draft: Bar;
  private done = false;

  constructor(app: App, bar: Bar, private lanes: Lane[], private isNew: boolean, private cb: BarModalCallbacks) {
    super(app);
    this.draft = { ...bar };
    this.modalEl.addClass("g-modal");
  }

  onOpen() {
    const { contentEl } = this;
    const d = this.draft;
    contentEl.empty();
    this.setTitle(this.isNew ? t("newBar") : t("edit"));

    let nameInput!: HTMLInputElement;
    new Setting(contentEl).setName(t("barName")).addText((c) => {
      nameInput = c.inputEl;
      c.setValue(d.name).onChange((v) => (d.name = v));
      c.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          this.submit();
        }
      });
    });

    new Setting(contentEl).setName(t("lane")).addDropdown((c) => {
      for (const l of this.lanes) c.addOption(l.id, l.name || t("newLane"));
      c.setValue(d.lane).onChange((v) => (d.lane = v));
    });

    const info = contentEl.createDiv({ cls: "g-dur" });
    const refreshInfo = () => info.setText(`${t("duration")}: ${d.end - d.start + 1} ${t("daysShort")}`);

    let startEl!: HTMLInputElement, endEl!: HTMLInputElement;
    const dates = contentEl.createDiv({ cls: "g-dates" });
    const mk = (label: string, value: number) => {
      const box = dates.createDiv({ cls: "g-date-box" });
      box.createEl("label", { text: label });
      const inp = box.createEl("input", { type: "date" });
      inp.value = isoOf(value);
      return inp;
    };
    startEl = mk(t("start"), d.start);
    endEl = mk(t("end"), d.end);
    startEl.onchange = () => {
      const v = parseISO(startEl.value);
      if (v === null) return (startEl.value = isoOf(d.start));
      const len = d.end - d.start;
      d.start = v;
      if (d.end < d.start) d.end = d.start + Math.max(0, len);
      endEl.value = isoOf(d.end);
      refreshInfo();
    };
    endEl.onchange = () => {
      const v = parseISO(endEl.value);
      if (v === null) return (endEl.value = isoOf(d.end));
      d.end = v;
      if (d.end < d.start) {
        d.start = d.end;
        startEl.value = isoOf(d.start);
      }
      refreshInfo();
    };
    refreshInfo();

    const colorRow = new Setting(contentEl).setName(t("color"));
    swatches(colorRow.controlEl, d.color, (c) => (d.color = c), true);

    new Setting(contentEl).setName(t("progress")).addSlider((c) =>
      c.setLimits(0, 100, 5).setValue(d.progress ?? 0).onChange((v) => (d.progress = v || undefined))
    );

    const noteSetting = new Setting(contentEl).setName(t("note"));
    noteSetting.settingEl.addClass("g-note-setting");
    noteSetting.addTextArea((c) => {
      c.setPlaceholder(t("notePlaceholder")).setValue(d.note ?? "").onChange((v) => (d.note = v || undefined));
      c.inputEl.rows = 5;
      c.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.submit();
        }
      });
    });

    const foot = new Setting(contentEl);
    foot.settingEl.addClass("g-foot");
    if (!this.isNew) {
      foot.addButton((b) =>
        b.setIcon("copy").setTooltip(t("duplicate")).onClick(() => {
          this.done = true;
          this.close();
          this.cb.dup();
        })
      );
      foot.addButton((b) =>
        b.setIcon("trash-2").setTooltip(t("delete")).setClass("mod-warning").onClick(() => {
          this.done = true;
          this.close();
          this.cb.del();
        })
      );
    }
    foot.addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.close()));
    foot.addButton((b) => b.setButtonText(t("save")).setCta().onClick(() => this.submit()));

    // focus the title for new bars, without popping the mobile keyboard for edits
    if (this.isNew) window.setTimeout(() => nameInput.focus(), 30);
  }

  private submit() {
    this.done = true;
    const d = this.draft;
    if (d.end < d.start) [d.start, d.end] = [d.end, d.start];
    d.name = d.name.trim();
    this.close();
    this.cb.save(d);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.cb.cancel();
  }
}

export interface LaneModalCallbacks {
  save: (l: Lane) => void;
  del: () => void;
  move: (dir: -1 | 1) => void;
  cancel: () => void;
}

export class LaneModal extends Modal {
  private draft: Lane;
  private done = false;

  constructor(app: App, lane: Lane, private isNew: boolean, private cb: LaneModalCallbacks) {
    super(app);
    this.draft = { ...lane };
    this.modalEl.addClass("g-modal");
  }

  onOpen() {
    const { contentEl } = this;
    const d = this.draft;
    this.setTitle(this.isNew ? t("newLane") : t("editLane"));

    let nameInput!: HTMLInputElement;
    new Setting(contentEl).setName(t("laneName")).addText((c) => {
      nameInput = c.inputEl;
      c.setValue(d.name).onChange((v) => (d.name = v));
      c.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          this.submit();
        }
      });
    });

    const colorRow = new Setting(contentEl).setName(t("color"));
    swatches(colorRow.controlEl, d.color, (c) => (d.color = c ?? d.color), false);

    const foot = new Setting(contentEl);
    foot.settingEl.addClass("g-foot");
    if (!this.isNew) {
      foot.addButton((b) =>
        b.setIcon("arrow-up").setTooltip(t("moveUp")).onClick(() => {
          this.done = true;
          this.close();
          this.cb.move(-1);
        })
      );
      foot.addButton((b) =>
        b.setIcon("arrow-down").setTooltip(t("moveDown")).onClick(() => {
          this.done = true;
          this.close();
          this.cb.move(1);
        })
      );
      foot.addButton((b) =>
        b.setIcon("trash-2").setTooltip(t("delete")).setClass("mod-warning").onClick(() => {
          this.done = true;
          this.close();
          this.cb.del();
        })
      );
    }
    foot.addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.close()));
    foot.addButton((b) => b.setButtonText(t("save")).setCta().onClick(() => this.submit()));

    if (this.isNew) window.setTimeout(() => nameInput.focus(), 30);
  }

  private submit() {
    this.done = true;
    this.draft.name = this.draft.name.trim();
    this.close();
    this.cb.save(this.draft);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.cb.cancel();
  }
}

export function confirmDialog(app: App, message: string, okText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const m = new (class extends Modal {
      onOpen() {
        this.modalEl.addClass("g-modal", "g-confirm");
        this.contentEl.createEl("p", { text: message });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.close()))
          .addButton((b) =>
            b.setButtonText(okText).setClass("mod-warning").onClick(() => {
              result = true;
              this.close();
            })
          );
      }
      onClose() {
        this.contentEl.empty();
        resolve(result);
      }
    })(app);
    m.open();
  });
}
