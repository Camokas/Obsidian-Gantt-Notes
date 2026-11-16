import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { GanttSettings, GanttSettingTab, defaultSettings } from "./settings";
import { GanttView, VIEW_TYPE } from "./view";
import { FM_KEY, GanttData, PALETTE, buildNote, hasGanttFrontmatter, newNoteText, parseNote, todayDay, uid } from "./model";
import { t } from "./i18n";
import { findUpdate, installUpdate, type PluginUpdate } from "./updater";

export default class GanttNotesPlugin extends Plugin {
  settings!: GanttSettings;
  /** leaves the user explicitly flipped to Markdown → leave them alone for that file */
  private mdOverride = new WeakMap<WorkspaceLeaf, string>();

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new GanttView(leaf, this));
    this.addSettingTab(new GanttSettingTab(this.app, this));

    this.addRibbonIcon("gantt-chart", t("newNote"), () => this.createGanttNote());

    this.addCommand({ id: "new-gantt-note", name: t("newNote"), callback: () => this.createGanttNote() });
    this.addCommand({
      id: "toggle-gantt-view",
      name: t("toggleView"),
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const vt = leaf?.view.getViewType();
        if (!leaf || (vt !== VIEW_TYPE && !(vt === "markdown" && this.leafFileIsGantt(leaf)))) return false;
        if (!checking) vt === VIEW_TYPE ? this.openAsMarkdown(leaf) : this.openAsGantt(leaf);
        return true;
      },
    });
    this.addCommand({
      id: "convert-to-gantt",
      name: t("convertNote"),
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md" || this.isGantt(f)) return false;
        if (!checking) void this.convert(f);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile) return;
        menu.addItem((i) =>
          i
            .setTitle(t("newNote"))
            .setIcon("gantt-chart")
            .onClick(() => this.createGanttNote((file as any).path))
        );
      })
    );
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => leaf && this.maybeSwitch(leaf)));
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.app.workspace.iterateAllLeaves((leaf) => {
          const path = leaf.view instanceof GanttView ? leaf.view.file?.path : this.leafPath(leaf);
          if (path === file.path) {
            this.maybeSwitch(leaf);
            if (leaf.view instanceof GanttView) void leaf.view.reloadFromDisk();
          }
        });
      })
    );
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((l) => this.maybeSwitch(l));
      this.connectRemotelySave();
    });
  }

  onunload() {
    // nothing runs in the background; views are detached by Obsidian
  }

  // ------------------------------------------------------------- settings

  async loadSettings() {
    this.settings = Object.assign(defaultSettings(), await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => (l.view as GanttView).applySettings());
  }

  notifySyncMerge() {
    new Notice(t("syncMerged"));
  }

  notifySaveError(error: unknown) {
    console.error("Gantt Notes: could not save", error);
    new Notice(t("saveFailed"));
  }

  private connectRemotelySave() {
    const remote = (this.app as any).plugins?.plugins?.["remotely-save"];
    const ref = remote?.syncEvent?.on?.("SYNC_DONE", () => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof GanttView) void leaf.view.reloadFromDisk();
      }
    });
    if (ref) this.registerEvent(ref);
  }

  async checkForUpdate(): Promise<PluginUpdate | null> {
    return findUpdate(this.manifest.version);
  }

  async installUpdate(update: PluginUpdate): Promise<void> {
    await installUpdate(this.app.vault.adapter, this.app.vault.configDir, this.manifest, update);
  }

  // ------------------------------------------------------ view switching

  isGantt(file: TFile): boolean {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return !!fm && fm[FM_KEY] !== undefined;
  }

  private leafPath(leaf: WorkspaceLeaf): string | null {
    const st = leaf.getViewState();
    if (st.type !== "markdown") return null;
    const p = st.state?.file;
    return typeof p === "string" ? p : null;
  }

  private leafFileIsGantt(leaf: WorkspaceLeaf): boolean {
    const p = this.leafPath(leaf) ?? (leaf.view as MarkdownView).file?.path;
    const f = p ? this.app.vault.getAbstractFileByPath(p) : null;
    return f instanceof TFile && this.isGantt(f);
  }

  private maybeSwitch(leaf: WorkspaceLeaf) {
    if (!this.settings.autoOpen) return;
    const path = this.leafPath(leaf);
    if (!path) return;
    if (this.mdOverride.get(leaf) === path) return;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile) || !this.isGantt(f)) return;
    this.openAsGantt(leaf);
  }

  openAsGantt(leaf: WorkspaceLeaf) {
    const st = leaf.getViewState();
    const path = st.state?.file ?? (leaf.view as MarkdownView).file?.path;
    if (!path) return;
    this.mdOverride.delete(leaf);
    void leaf.setViewState({ type: VIEW_TYPE, state: { file: path }, active: true, popstate: true } as any);
  }

  openAsMarkdown(leaf: WorkspaceLeaf) {
    const file = (leaf.view as GanttView).file;
    if (!file) return;
    this.mdOverride.set(leaf, file.path);
    void leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "source" }, active: true, popstate: true } as any);
  }

  // ------------------------------------------------------- note creation

  private sampleData(): GanttData {
    const lane = { id: uid(), name: t("sampleLane"), color: PALETTE[0] };
    const td = todayDay();
    const names = t("sampleBars");
    const spans: [number, number][] = [[-1, 5], [5, 14], [14, 19]];
    return {
      lanes: [lane],
      bars: names.map((n, i) => ({
        id: uid(),
        lane: lane.id,
        name: n,
        start: td + spans[i][0],
        end: td + spans[i][1],
      })),
      extra: [],
    };
  }

  async createGanttNote(folderPath?: string) {
    const vault = this.app.vault;
    let folder = folderPath ?? this.settings.newNoteFolder ?? "";
    if (!folderPath && !folder) folder = this.app.workspace.getActiveFile()?.parent?.path ?? "";
    if (folder === "/") folder = "";
    if (folder && !vault.getAbstractFileByPath(normalizePath(folder))) {
      await vault.createFolder(normalizePath(folder)).catch(() => undefined);
    }
    let name = "Gantt";
    let path = normalizePath(`${folder}/${name}.md`);
    for (let i = 2; vault.getAbstractFileByPath(path); i++) {
      name = `Gantt ${i}`;
      path = normalizePath(`${folder}/${name}.md`);
    }
    const file = await vault.create(path, newNoteText(this.sampleData()));
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true } as any);
    new Notice(t("noteCreated"));
  }

  async convert(file: TFile) {
    await this.app.vault.process(file, (text) => {
      const p = parseNote(text);
      if (p.hasBlock) return text;
      const empty = this.sampleData();
      empty.bars = [];
      return buildNote(p, empty);
    });
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (fm[FM_KEY] === undefined) fm[FM_KEY] = "timeline";
    });
    new Notice(t("converted"));
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (leaf && this.leafPath(leaf) === file.path) this.openAsGantt(leaf);
  }
}

export { hasGanttFrontmatter };
