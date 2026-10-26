import type { ColorName } from "./types";

/** Every colour the renderer paints with. The chart never reads CSS directly, so exports are self-contained. */
export interface Theme {
	dark: boolean;
	font: string;
	surface: string;
	/** Subtle wash for alternate months and the label column. */
	surfaceAlt: string;
	ink: string;
	inkSecondary: string;
	inkMuted: string;
	grid: string;
	axis: string;
	accent: string;
	deadline: string;
	palette: Record<ColorName, string>;
}

/** Categorical palette, validated for colour-vision deficiency in this order (light / dark steps). */
export const PALETTE_LIGHT: Record<ColorName, string> = {
	blue: "#2a78d6",
	orange: "#eb6834",
	aqua: "#1baf7a",
	yellow: "#eda100",
	magenta: "#e87ba4",
	green: "#008300",
	violet: "#6250d6",
	red: "#e34948",
};

export const PALETTE_DARK: Record<ColorName, string> = {
	blue: "#3987e5",
	orange: "#d95926",
	aqua: "#199e70",
	yellow: "#c98500",
	magenta: "#d55181",
	green: "#008300",
	violet: "#9085e9",
	red: "#e66767",
};

export const SYSTEM_FONT = `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

/** The theme used for exports and printing: always light, always the same. */
export const PRINT_THEME: Theme = {
	dark: false,
	font: SYSTEM_FONT,
	surface: "#ffffff",
	surfaceAlt: "#f7f7f5",
	ink: "#0b0b0b",
	inkSecondary: "#52514e",
	inkMuted: "#898781",
	grid: "#e8e7e1",
	axis: "#c3c2b7",
	accent: "#2a78d6",
	deadline: "#d03b3b",
	palette: PALETTE_LIGHT,
};

export const DARK_THEME: Theme = {
	dark: true,
	font: SYSTEM_FONT,
	surface: "#1e1e1e",
	surfaceAlt: "#252524",
	ink: "#f0efec",
	inkSecondary: "#c3c2b7",
	inkMuted: "#898781",
	grid: "#2c2c2a",
	axis: "#45453f",
	accent: "#3987e5",
	deadline: "#e66767",
	palette: PALETTE_DARK,
};

/** Ink to use for a label sitting on a filled bar of the given colour. */
export function inkOnFill(color: ColorName): string {
	return color === "yellow" ? "#0b0b0b" : "#ffffff";
}

/** Resolve a theme from the CSS variables of the surrounding app (Obsidian, or the preview harness). */
export function themeFromCss(el: HTMLElement): Theme {
	const doc = el.ownerDocument;
	const dark = doc.body.classList.contains("theme-dark");
	const base = dark ? DARK_THEME : PRINT_THEME;
	const css = getComputedStyle(el);
	const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
	return {
		...base,
		font: v("--font-interface", base.font),
		surface: v("--background-primary", base.surface),
		surfaceAlt: v("--background-secondary", base.surfaceAlt),
		ink: v("--text-normal", base.ink),
		inkSecondary: v("--text-muted", base.inkSecondary),
		inkMuted: v("--text-faint", base.inkMuted),
		grid: v("--background-modifier-border", base.grid),
		axis: v("--background-modifier-border-hover", base.axis),
		accent: v("--interactive-accent", base.accent),
	};
}
