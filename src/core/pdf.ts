/**
 * A minimal PDF writer: one page per JPEG image, each filling a page of the given size in points
 * (A4 landscape is 841.89 × 595.28). Enough for print-ready timelines without a PDF library.
 */
export interface PdfPage {
	jpeg: Uint8Array;
	/** Pixel size of the JPEG. */
	width: number;
	height: number;
}

export function jpegPdf(pages: PdfPage[], pageW: number, pageH: number, title = ""): Uint8Array<ArrayBuffer> {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const offsets: number[] = [];
	let length = 0;
	const push = (b: Uint8Array) => {
		chunks.push(b);
		length += b.length;
	};
	const str = (s: string) => push(enc.encode(s));
	const obj = (n: number, body: () => void) => {
		offsets[n] = length;
		str(`${n} 0 obj\n`);
		body();
		str("\nendobj\n");
	};

	// 1 catalog, 2 page tree, 3 info, then per page: page, contents, image.
	const pageObj = (i: number) => 4 + i * 3;
	str("%PDF-1.4\n%âãÏÓ\n");
	obj(1, () => str("<< /Type /Catalog /Pages 2 0 R >>"));
	obj(2, () => str(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`));
	obj(3, () => str(`<< /Title ${pdfText(title)} /Producer (Simple Gantt) >>`));
	pages.forEach((p, i) => {
		const n = pageObj(i);
		const w = pageW.toFixed(2), h = pageH.toFixed(2);
		obj(n, () => str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`));
		const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
		obj(n + 1, () => str(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
		obj(n + 2, () => {
			str(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
			push(p.jpeg);
			str("\nendstream");
		});
	});
	const count = 4 + pages.length * 3;
	const xref = length;
	str(`xref\n0 ${count}\n0000000000 65535 f \n`);
	for (let n = 1; n < count; n++) str(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
	str(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

	const out = new Uint8Array(length);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

/** A PDF text string: UTF-16BE in hex, so any title works. */
function pdfText(s: string): string {
	let hex = "FEFF";
	for (const ch of s) {
		const code = ch.codePointAt(0)!;
		if (code > 0xffff) {
			const v = code - 0x10000;
			hex += (0xd800 + (v >> 10)).toString(16).padStart(4, "0") + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
		} else hex += code.toString(16).padStart(4, "0");
	}
	return `<${hex.toUpperCase()}>`;
}
