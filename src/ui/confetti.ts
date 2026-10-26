/** A short, light confetti burst drawn on a temporary canvas. Skipped when reduced motion is requested. */
export function confetti(host: HTMLElement, x: number, y: number, colors: string[], big = false) {
	const win = host.ownerDocument.defaultView;
	if (win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
	const canvas = createEl("canvas", { cls: "sg-confetti" });
	const rect = host.getBoundingClientRect();
	const dpr = win?.devicePixelRatio ?? 1;
	canvas.width = rect.width * dpr;
	canvas.height = rect.height * dpr;
	host.appendChild(canvas);
	const ctx = canvas.getContext("2d")!;
	ctx.scale(dpr, dpr);

	const count = big ? 140 : 70;
	const parts = Array.from({ length: count }, () => {
		const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
		const speed = (big ? 7 : 5.5) * (0.5 + Math.random());
		return {
			x, y,
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed - 2,
			size: 4 + Math.random() * 5,
			rot: Math.random() * Math.PI,
			vr: (Math.random() - 0.5) * 0.3,
			color: colors[Math.floor(Math.random() * colors.length)],
			shape: Math.random() < 0.3 ? "circle" : "rect",
		};
	});
	const t0 = performance.now();
	const life = big ? 1900 : 1400;
	const frame = (now: number) => {
		const t = now - t0;
		ctx.clearRect(0, 0, rect.width, rect.height);
		ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - life * 0.6) / (life * 0.4));
		for (const p of parts) {
			p.vy += 0.22;
			p.vx *= 0.985;
			p.x += p.vx;
			p.y += p.vy;
			p.rot += p.vr;
			ctx.save();
			ctx.translate(p.x, p.y);
			ctx.rotate(p.rot);
			ctx.fillStyle = p.color;
			if (p.shape === "circle") {
				ctx.beginPath();
				ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2);
				ctx.fill();
			} else ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
			ctx.restore();
		}
		if (t < life) window.requestAnimationFrame(frame);
		else canvas.remove();
	};
	window.requestAnimationFrame(frame);
}
