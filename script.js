(() => {
  const INCH = 72;
  const PAGE_4x6 = [4 * INCH, 6 * INCH];         // 288 x 432 points
  const A4 = [595.28, 841.89];                    // A4 portrait in points
  const MARGIN = 18;                               // 0.25" margin on A4
  const GAP = 12;                                  // spacing between cells on A4

  const $ = (s) => document.querySelector(s);
  const statusEl = $("#status");
  const dl = $("#download");

  function setStatus(t) { statusEl.textContent = t || ""; }
  function mode() {
    const m = document.querySelector('input[name="mode"]:checked');
    return m ? m.value : "4x6";
  }

  // Render a single PDF page to a PNG data URL using PDF.js
  async function renderPageToPNG(pdf, pageIndex, targetPixelsWide) {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1.0 });

    // choose scale so width ~= targetPixelsWide
    const scale = targetPixelsWide / viewport.width;
    const scaledViewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: false });

    canvas.width = Math.floor(scaledViewport.width);
    canvas.height = Math.floor(scaledViewport.height);

    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;

    const dataUrl = canvas.toDataURL("image/png");
    return { dataUrl, pxW: canvas.width, pxH: canvas.height };
  }

  // Compose 4x6: one label per page
  async function build4x6(pdfArrayBuffer) {
    const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
    const out = await PDFLib.PDFDocument.create();
    const pageCount = pdf.numPages;

    for (let i = 0; i < pageCount; i++) {
      setStatus(`Rendering page ${i + 1} of ${pageCount}…`);
      // render width around 1000–1400 px for crispness
      const { dataUrl } = await renderPageToPNG(pdf, i, 1200);

      const pngBytes = await (await fetch(dataUrl)).arrayBuffer();
      const img = await out.embedPng(pngBytes);

      const [W, H] = PAGE_4x6;
      const page = out.addPage([W, H]);

      const { width: iw, height: ih } = img;
      const s = Math.min(W / iw, H / ih);
      const drawW = iw * s;
      const drawH = ih * s;
      const x = (W - drawW) / 2;
      const y = (H - drawH) / 2;

      page.drawImage(img, { x, y, width: drawW, height: drawH });
    }

    setStatus("Packaging PDF…");
    return out.save();
  }

  // Compose A4 grid 2x2
  async function buildA4(pdfArrayBuffer) {
    const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
    const out = await PDFLib.PDFDocument.create();
    const n = pdf.numPages;

    const cols = 2, rows = 2, slotsPerPage = 4;
    const cellW = (A4[0] - MARGIN * 2 - GAP * (cols - 1)) / cols;
    const cellH = (A4[1] - MARGIN * 2 - GAP * (rows - 1)) / rows;

    let page = null;
    for (let i = 0; i < n; i++) {
      if (i % slotsPerPage === 0) page = out.addPage(A4);

      setStatus(`Rendering label ${i + 1} of ${n}…`);
      const { dataUrl } = await renderPageToPNG(pdf, i, 1200);

      const pngBytes = await (await fetch(dataUrl)).arrayBuffer();
      const img = await out.embedPng(pngBytes);

      // target scale for each cell
      const s = Math.min(cellW / img.width, cellH / img.height);
      const drawW = img.width * s;
      const drawH = img.height * s;

      const slot = i % slotsPerPage;
      const r = Math.floor(slot / cols);
      const c = slot % cols;

      const x0 = MARGIN + c * (cellW + GAP);
      const y0 = MARGIN + (rows - 1 - r) * (cellH + GAP);

      const x = x0 + (cellW - drawW) / 2;
      const y = y0 + (cellH - drawH) / 2;

      page.drawImage(img, { x, y, width: drawW, height: drawH });
    }

    setStatus("Packaging PDF…");
    return out.save();
  }

  $("#process").addEventListener("click", async () => {
    const file = $("#file").files[0];
    if (!file) { alert("Please choose a PDF file."); return; }

    dl.classList.add("hidden");
    dl.removeAttribute("href");
    setStatus("Reading file…");

    try {
      const bytes = await file.arrayBuffer();
      const outBytes = (mode() === "a4") ? await buildA4(bytes) : await build4x6(bytes);

      const blob = new Blob([outBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      dl.href = url;
      dl.download = (mode() === "a4") ? "labels-a4.pdf" : "labels-4x6.pdf";
      dl.classList.remove("hidden");
      setStatus("Done. Click Download.");
    } catch (e) {
      console.error(e);
      setStatus("Error: " + (e?.message || e));
      alert("Failed: " + (e?.message || e));
    }
  });
})();
