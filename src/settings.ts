import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type BarGanttPlugin from "./main";
import { t } from "./i18n";

export interface GanttSettings {
  weekStart: 0 | 1;
  defaultPpd: number;
  labelWidth: number;
  barHeight: number;
  weekendShade: boolean;
  todayLine: boolean;
  animations: boolean;
  confirmDelete: boolean;
  autoOpen: boolean;
  newNoteFolder: string;
}

export const defaultSettings = (): GanttSettings => ({
  weekStart: 1,
  defaultPpd: 28,
  labelWidth: Platform.isMobile ? 104 : 176,
  barHeight: 30,
  weekendShade: true,
  todayLine: true,
  animations: true,
  confirmDelete: true,
  autoOpen: true,
  newNoteFolder: "",
});

export class GanttSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BarGanttPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
    };

    new Setting(containerEl).setName(t("sAutoOpen")).setDesc(t("sAutoOpenDesc")).addToggle((c) =>
      c.setValue(s.autoOpen).onChange(async (v) => {
        s.autoOpen = v;
        await save();
      })
    );

    new Setting(containerEl).setName(t("sFolder")).setDesc(t("sFolderDesc")).addText((c) =>
      c.setPlaceholder("Gantt").setValue(s.newNoteFolder).onChange(async (v) => {
        s.newNoteFolder = v.trim();
        await save();
      })
    );

    new Setting(containerEl).setName(t("sWeekStart")).addDropdown((c) =>
      c
        .addOption("1", t("sMonday"))
        .addOption("0", t("sSunday"))
        .setValue(String(s.weekStart))
        .onChange(async (v) => {
          s.weekStart = v === "0" ? 0 : 1;
          await save();
        })
    );

    new Setting(containerEl).setName(t("sZoom")).setDesc(t("sZoomDesc")).addSlider((c) =>
      c.setLimits(6, 60, 1).setValue(s.defaultPpd).setDynamicTooltip().onChange(async (v) => {
        s.defaultPpd = v;
        await save();
      })
    );

    new Setting(containerEl).setName(t("sLabelW")).addSlider((c) =>
      c.setLimits(80, 320, 4).setValue(s.labelWidth).setDynamicTooltip().onChange(async (v) => {
        s.labelWidth = v;
        await save();
      })
    );

    new Setting(containerEl).setName(t("sBarH")).setDesc(t("sBarHDesc")).addDropdown((c) =>
      c
        .addOption("24", t("sCompact"))
        .addOption("30", t("sNormal"))
        .setValue(String(s.barHeight))
        .onChange(async (v) => {
          s.barHeight = +v;
          await save();
        })
    );

    new Setting(containerEl).setName(t("sWeekend")).addToggle((c) =>
      c.setValue(s.weekendShade).onChange(async (v) => {
        s.weekendShade = v;
        await save();
      })
    );

    new Setting(containerEl).setName(t("sTodayLine")).addToggle((c) =>
      c.setValue(s.todayLine).onChange(async (v) => {
        s.todayLine = v;
        await save();
      })
    );

    new Setting(containerEl).setName(t("sAnim")).setDesc(t("sAnimDesc")).addToggle((c) =>
      c.setValue(s.animations).onChange(async (v) => {
        s.animations = v;
        await save();
      })
    );

    new Setting(containerEl).setName(t("sConfirm")).addToggle((c) =>
      c.setValue(s.confirmDelete).onChange(async (v) => {
        s.confirmDelete = v;
        await save();
      })
    );

    new Setting(containerEl).setName(t("sSyncTitle")).setHeading();
    containerEl.createEl("p", { text: t("sSyncInfo"), cls: "setting-item-description" });
  }
}
