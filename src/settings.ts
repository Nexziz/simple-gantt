import { App, PluginSettingTab, Setting } from "obsidian";
import type SimpleGanttPlugin from "./main";

export interface SimpleGanttSettings {
	/** Folder where new projects are created. */
	folder: string;
	/** Folder for exported images; empty means next to the project note. */
	exportFolder: string;
	/** Path of the project opened last, restored when the view opens. */
	lastProject: string | null;
}

export const DEFAULT_SETTINGS: SimpleGanttSettings = {
	folder: "Gantt",
	exportFolder: "",
	lastProject: null,
};

export class SimpleGanttSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: SimpleGanttPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Project folder")
			.setDesc("Where new timelines are created. Each timeline is a normal note you can move anywhere.")
			.addText((t) =>
				t.setPlaceholder("Gantt").setValue(this.plugin.settings.folder).onChange(async (v) => {
					this.plugin.settings.folder = v.trim().replace(/^\/+|\/+$/g, "");
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Export folder")
			.setDesc("Where PNG and SVG exports are saved. Leave empty to save next to the timeline note.")
			.addText((t) =>
				t.setPlaceholder("Next to the note").setValue(this.plugin.settings.exportFolder).onChange(async (v) => {
					this.plugin.settings.exportFolder = v.trim().replace(/^\/+|\/+$/g, "");
					await this.plugin.saveSettings();
				}),
			);
	}
}
