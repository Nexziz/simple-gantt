/* Stand-ins for the DOM helpers Obsidian adds globally, so the board runs in a plain browser (preview + tests). */
type Info = { cls?: string; text?: string; attr?: Record<string, string> };

function make<K extends keyof HTMLElementTagNameMap>(tag: K, o: Info | string = {}): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	const info = typeof o === "string" ? { cls: o } : o;
	if (info.cls) el.className = info.cls;
	if (info.text) el.textContent = info.text;
	for (const [k, v] of Object.entries(info.attr ?? {})) el.setAttribute(k, v);
	return el;
}

const g = globalThis as Record<string, unknown>;
g.createEl ??= make;
g.createDiv ??= (o?: Info) => make("div", o);
g.createSpan ??= (o?: Info) => make("span", o);

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
proto.empty ??= function (this: HTMLElement) { this.replaceChildren(); };
proto.addClass ??= function (this: HTMLElement, ...c: string[]) { this.classList.add(...c); };
proto.createEl ??= function (this: HTMLElement, tag: keyof HTMLElementTagNameMap, o?: Info) {
	const el = make(tag, o);
	this.appendChild(el);
	return el;
};
proto.createDiv ??= function (this: HTMLElement, o?: Info) { return (this as unknown as { createEl: typeof make }).createEl("div", o); };
proto.setCssProps ??= function (this: HTMLElement, props: Record<string, string>) {
	for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
};
