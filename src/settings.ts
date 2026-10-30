import { App, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type SimpleGanttPlugin from "./main";
import { SUPPORT_URL } from "./support";

export interface SimpleGanttSettings {
	/** Folder where new projects are created. */
	folder: string;
	/** Folder for exported images; empty means next to the project note. */
	exportFolder: string;
	/** Path of the project opened last, restored when the view opens. */
	lastProject: string | null;
	/** Timeline notes this plugin knows about, most recent first. Kept so the plugin never has to scan the vault. */
	projects: string[];
	/** Show the button in the left ribbon. */
	showRibbon: boolean;
}

export const DEFAULT_SETTINGS: SimpleGanttSettings = {
	folder: "Gantt",
	exportFolder: "",
	lastProject: null,
	projects: [],
	showRibbon: true,
};

const PANEL_DESC =
	"A small panel with your next deadline, what's on now and what's coming up. Once it's open, drag its icon onto any tab group in the sidebars, for example next to Files at the top or into the bottom half.";

export class SimpleGanttSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: SimpleGanttPlugin) {
		super(app, plugin);
	}

	/** Declarative settings (Obsidian 1.13+): rendered by Obsidian and included in settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Project folder",
				desc: "Where new timelines are created. Each timeline is a normal note you can move anywhere.",
				control: { type: "folder", key: "folder", placeholder: "Gantt", includeRoot: true },
			},
			{
				name: "Export folder",
				desc: "Where PNG and SVG exports are saved. Leave empty to save next to the timeline note.",
				control: { type: "folder", key: "exportFolder", placeholder: "Next to the note", includeRoot: true },
			},
			{
				type: "group",
				heading: "Ribbon and sidebar",
				items: [
					{
						name: "Ribbon button",
						desc: "Show the timeline button in the left ribbon.",
						control: { type: "toggle", key: "showRibbon" },
					},
					{
						name: "Overview panel",
						desc: PANEL_DESC,
						aliases: ["sidebar", "icon", "panel", "move"],
						render: (setting) => this.panelButtons(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Support",
				items: [
					{
						name: "Enjoying this plugin?",
						desc: "It's free and open source. If it helps your planning, you can say thanks with a coffee.",
						aliases: ["donate", "coffee", "support"],
						render: (setting) => this.coffeeButton(setting),
					},
				],
			},
		];
	}

	private panelButtons(setting: Setting) {
		setting
			.addButton((b) => b.setButtonText("Left sidebar").onClick(() => void this.plugin.showOverview("left")))
			.addButton((b) => b.setButtonText("Right sidebar").onClick(() => void this.plugin.showOverview("right")));
	}

	private coffeeButton(setting: Setting) {
		setting.addButton((b) => b.setButtonText("☕ Buy me a coffee").onClick(() => window.open(SUPPORT_URL)));
	}

	getControlValue(key: string): unknown {
		if (key === "showRibbon") return this.plugin.settings.showRibbon;
		return key === "folder" || key === "exportFolder" ? this.plugin.settings[key] : undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "showRibbon") {
			this.plugin.settings.showRibbon = value === true;
			this.plugin.setRibbon(value === true);
			await this.plugin.saveSettings();
			return;
		}
		if (key !== "folder" && key !== "exportFolder") return;
		this.plugin.settings[key] = (typeof value === "string" ? value : "").trim().replace(/^\/+|\/+$/g, "");
		await this.plugin.saveSettings();
	}

	/** Fallback for Obsidian versions before 1.13, which don't use the definitions above. */
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

		new Setting(containerEl).setName("Ribbon and sidebar").setHeading();
		new Setting(containerEl)
			.setName("Ribbon button")
			.setDesc("Show the timeline button in the left ribbon.")
			.addToggle((t) => t.setValue(this.plugin.settings.showRibbon).onChange(async (v) => {
				this.plugin.settings.showRibbon = v;
				this.plugin.setRibbon(v);
				await this.plugin.saveSettings();
			}));
		this.panelButtons(new Setting(containerEl).setName("Overview panel").setDesc(PANEL_DESC));

		new Setting(containerEl).setName("Support").setHeading();
		this.coffeeButton(
			new Setting(containerEl)
				.setName("Enjoying this plugin?")
				.setDesc("It's free and open source. If it helps your planning, you can say thanks with a coffee."),
		);
	}
}
