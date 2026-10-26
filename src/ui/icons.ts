/** A tiny icon set (Lucide-style strokes) so the board looks identical everywhere it runs. Shapes are constant SVG snippets. */
const PATHS: Record<string, string> = {
	plus: '<path d="M12 5v14M5 12h14"/>',
	x: '<path d="M18 6 6 18M6 6l12 12"/>',
	chevronDown: '<path d="m6 9 6 6 6-6"/>',
	today: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><circle cx="12" cy="16" r="2" fill="currentColor"/>',
	download: '<path d="M12 15V3M7 10l5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
	settings: '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
	trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
	copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
	note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
	external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
	undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
	up: '<path d="m18 15-6-6-6 6"/>',
	down: '<path d="m6 9 6 6 6-6"/>',
	gantt: '<path d="M8 6h10M6 12h9M11 18h7"/><path d="M3 3v18h18" opacity=".5"/>',
	sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
	book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M9 7h7M9 11h5"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3.5-10.5 6"/>',
	push: '<path d="M5 12h14M13 6l6 6-6 6"/><path d="M5 6v12" opacity=".5"/>',
	bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
	chevronLeft: '<path d="m15 18-6-6 6-6"/>',
	chevronRight: '<path d="m9 18 6-6-6-6"/>',
	party: '<path d="M5.8 11.3 2 22l10.7-3.8"/><path d="M4 3h.01M22 8h.01M15 2h.01M22 20h.01"/><path d="m22 2-2.2.8a2.9 2.9 0 0 0-1.9 3.2c.1.9-.6 1.8-1.6 1.8h-.4c-.9 0-1.7.7-1.9 1.6L13 11"/><path d="M11 13c1.9 1.9 2.8 4.1 2 4.9-.8.8-3 0-4.9-2-1.9-1.9-2.8-4.1-2-4.9.8-.8 3 0 4.9 2Z"/>',
	help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
	fold: '<path d="m8 3 4 4 4-4"/><path d="m8 21 4-4 4 4"/><path d="M4 12h16"/>',
	unfold: '<path d="m8 7 4-4 4 4"/><path d="m8 17 4 4 4-4"/><path d="M4 12h16"/>',
	buffer: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="m7 17 6-10M12 17l6-10"/>',
	unlink: '<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 3.5 8.5M8 12h2M3 3l18 18"/>',
	select: '<path d="M4 8V5a1 1 0 0 1 1-1h3M12 4h2M4 12v2M4 18v1a1 1 0 0 0 1 1h1M18 4h1a1 1 0 0 1 1 1v1"/><path d="m12 12 8.5 3.2-3.8 1.5-1.5 3.8z" fill="currentColor"/>',
	enter: '<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
	// Item types
	task: '<rect x="3" y="8" width="18" height="8" rx="2.5" fill="currentColor" stroke="none"/>',
	milestone: '<path d="M12 3.5 20.5 12 12 20.5 3.5 12z" fill="currentColor" stroke="none"/>',
	deadline: '<path d="M5 21V3"/><path d="M5.5 3.5 18 8l-12.5 4.5z" fill="currentColor"/>',
	event: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
	location: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
};

const SVG_NS = "http://www.w3.org/2000/svg";
const TAG_RE = /<(\w+)((?:\s+[\w-]+="[^"]*")*)\s*\/?>/g;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

/** Build an icon as real SVG elements (no HTML parsing), from the constant shapes above. */
export function icon(name: string, size = 16): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	const attrs: Record<string, string> = {
		class: "sg-icon", width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none",
		stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
	};
	for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
	for (const [, tag, attrText] of (PATHS[name] ?? "").matchAll(TAG_RE)) {
		const el = document.createElementNS(SVG_NS, tag);
		for (const [, k, v] of attrText.matchAll(ATTR_RE)) el.setAttribute(k, v);
		svg.appendChild(el);
	}
	return svg;
}

/** Ribbon / view icon, in Obsidian's 100×100 icon coordinate space. */
export const RIBBON_ICON_SVG = `<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"><path d="M30 25h40M18 50h38M44 75h38"/></g><g fill="currentColor"><circle cx="18" cy="25" r="5"/><path d="M82 42l8 8-8 8-8-8z"/></g>`;
