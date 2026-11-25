import type { App, Events } from "obsidian";
import { Hours, readHours } from "./core/hours";
import { toPlain } from "./core/serialize";
import type { Project } from "./core/types";

/** What Pocket Watch offers other plugins (its `api`), as far as Simple Gantt uses it. */
interface PocketWatchApi {
	version?: number;
	timelineHours?(path: string, raw?: unknown): unknown;
}

/** Pocket Watch triggers this on the workspace, at most every few seconds, when your time changes. */
export const POCKET_WATCH_EVENT = "pocket-watch:time-changed";

/**
 * Your time on a timeline's tasks and phases, from Pocket Watch, when it's installed, switched on and one of its
 * projects follows this timeline. The timeline as it is on the board is passed along, so its tasks match.
 */
export function pocketWatchHours(app: App, path: string | null | undefined, project: Project | null): Hours | null {
	if (!path) return null;
	const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { api?: PocketWatchApi } | undefined> } }).plugins;
	const api = plugins?.plugins?.["pocket-watch"]?.api;
	if (typeof api?.timelineHours !== "function") return null;
	try {
		return readHours(api.timelineHours(path, project ? toPlain(project) : undefined));
	} catch {
		return null;
	}
}

/** Call back when Pocket Watch's time changes. */
export function onPocketWatchChange(app: App, callback: () => void) {
	return (app.workspace as Events).on(POCKET_WATCH_EVENT, callback);
}
