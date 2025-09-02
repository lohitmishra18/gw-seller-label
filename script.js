(() => {
  const INCH = 72;
  const PAGE_4x6 = [4 * INCH, 6 * INCH]; // 288 x 432

  const $ = (s) => document.querySelector(s);
  const statusEl = $("#status");
  const dl = $("#download");

  function setStatus(t) { statusEl.textContent = t || ""; }
  function getPlatform() {
    const el = document.querySelector('input[name="platform"]:checked');
    return el ? el.value : "amazon";
  }

  // --------- PDF.js render ----------
  async function renderPageToCanvas(pdf, pageIndex, targetPixelsWide) {
    const page = await pdf.getPage(pageIndex + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = targetPixelsWide / vp1.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  // --------- Amazon page filter (UNCHANGED) ----------
  async function amazonSelectKeepIndices(pdf) {
    const total = pdf.numPages;
    const keep = [];
    let dropped = 0;

    for (let i = 0; i < total; i++) {
      setStatus(`Checking page ${i + 1}/${total} (Amazon)…`);
      try {
        const page = await pdf.getPage(i + 1);
        const tc = await page.getTextContent();
        const text = tc.items.map(x => x.str).join(" ");

        const isInvoice = /\bTax\s*Invoice\b/i.test(text) ||
                          /Bill of Supply|Cash Memo/i.test(text);
        if (isInvoice) dropped++; else keep.push(i);
      } catch {
        // if text fails, keep page rather than lose label
        keep.push(i);
      }
    }

    // Fallbacks—never return empty
    if (keep.length === 0 && total >= 2) return [...Array(total).keys()].filter(i => i % 2 === 0);
    if (keep.length === 0) return [...Array(total).keys()];
    return keep;
  }

  // --------- Flipkart hard crop ----------
  function cropFlipkart(canvas) {
    // Delete left 20%, right 20%, top 5%, and everything below 58%
    const W = canvas.width, H = canvas.height;

    const leftPct = 0.24, rightPct = 0.24, topPct = 0.01, bottomKeepPct = 0.45;

    const sx = Math.floor(W * leftPct);
    const ex = Math.floor(W * (1 - rightPct));
    const sy = Math.floor(H * topPct);
    const ey = Math.floor(H * bottomKeepPct);

    const sWidth  = Math.max(1, ex - sx);
    const sHeight = Math.max(1, ey - sy);

    const c = document.createElement("canvas");
    c.width = sWidth;
    c.height = sHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(canvas, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);
    return c.toDataURL("image/png");
  }

  // --------- 4x6 builder ----------
  async function build4x6(pdfArrayBuffer, platform) {
    const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
    const out = await PDFLib.PDFDocument.create();

    // Decide pages to process
    let indices = [...Array(pdf.numPages).keys()];
    if (platform === "amazon") {
      indices = await amazonSelectKeepIndices(pdf); // unchanged logic
    }

    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      setStatus(`Rendering label ${k + 1} of ${indices.length} (${platform})…`);

      const canvas = await renderPageToCanvas(pdf, i, 1200);

      // Platform-specific rendering
      let dataUrl;
      if (platform === "flipkart") {
        dataUrl = cropFlipkart(canvas);           // ONLY Flipkart is cropped
      } else {
        dataUrl = canvas.toDataURL("image/png");  // Amazon/Meesho not cropped
      }

      // Compose onto 4×6
      const pngBytes = await (await fetch(dataUrl)).arrayBuffer();
      const img = await out.embedPng(pngBytes);

      const [W, H] = PAGE_4x6;
      const page = out.addPage([W, H]);
      const s = Math.min(W / img.width, H / img.height);
      const dw = img.width * s, dh = img.height * s;
      const x = (W - dw) / 2, y = (H - dh) / 2;

      page.drawImage(img, { x, y, width: dw, height: dh });
    }

    setStatus("Packaging PDF…");
    return out.save();
  }

  // --------- UI ----------
  $("#process").addEventListener("click", async () => {
    const file = $("#file").files[0];
    if (!file) { alert("Please choose a PDF file."); return; }

    dl.classList.add("hidden");
    dl.removeAttribute("href");
    setStatus("Reading file…");

    try {
      const bytes = await file.arrayBuffer();
      const platform = getPlatform();

      const outBytes = await build4x6(bytes, platform);
      const blob = new Blob([outBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      dl.href = url;
      dl.download = `labels-4x6-${platform}.pdf`;
      dl.classList.remove("hidden");
      setStatus("Done. Click Download.");
    } catch (e) {
      console.error(e);
      setStatus("Error: " + (e?.message || e));
      alert("Failed: " + (e?.message || e));
    }
  });
})();
