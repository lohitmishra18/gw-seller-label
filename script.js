(() => {
  const INCH = 72;
  const PAGE_4x6 = [4 * INCH, 6 * INCH];   // 288 x 432 points

  const $ = (s) => document.querySelector(s);
  const statusEl = $("#status");
  const dl = $("#download");

  function setStatus(t) { statusEl.textContent = t || ""; }
  function getPlatform() {
    const el = document.querySelector('input[name="platform"]:checked');
    return el ? el.value : "amazon";
  }

  // --- PDF.js helpers -------------------------------------------------------

  // Render a single PDF page to a PNG (data URL)
  async function renderPageToPNG(pdf, pageIndex, targetPixelsWide) {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1.0 });
    const scale = targetPixelsWide / viewport.width;
    const scaledViewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = Math.floor(scaledViewport.width);
    canvas.height = Math.floor(scaledViewport.height);

    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    const dataUrl = canvas.toDataURL("image/png");
    return { dataUrl, pxW: canvas.width, pxH: canvas.height };
  }

  // Read plain text from a page (used to detect invoice pages)
  async function getPageText(pdf, pageIndex) {
    const page = await pdf.getPage(pageIndex + 1);
    const tc = await page.getTextContent();
    return tc.items.map(i => i.str).join(" ");
  }

  // Decide which page indices to keep based on platform
  async function selectPageIndices(pdf, platform) {
    const total = pdf.numPages;
    const indices = [...Array(total).keys()]; // [0..total-1]

    if (platform !== "amazon") return indices;

    // AMAZON RULES:
    // 1) Prefer text-based filter: drop pages containing "Tax Invoice"
    // 2) Fallback: keep first page of each pair (0,2,4,...) if we removed none
    const keep = [];
    const dropped = [];

    for (let i = 0; i < total; i++) {
      setStatus(`Checking page ${i + 1}/${total} for invoice text…`);
      try {
        const text = await getPageText(pdf, i);
        if (/\bTax\s+Invoice\b/i.test(text) || /Bill of Supply|Cash Memo/i.test(text)) {
          dropped.push(i);           // invoice page
        } else {
          keep.push(i);              // label page
        }
      } catch {
        // If text extraction fails, we'll decide in fallback step
        keep.push(i); // temporarily keep; may fallback below
      }
    }

    // If text-based pass didn't drop anything and page count looks like pairs,
    // fallback to keeping first page of each pair (0,2,4,...)
    const removedByText = dropped.length > 0;
    if (!removedByText && total >= 2) {
      const pairKeep = indices.filter(i => i % 2 === 0);
      return pairKeep;
    }

    return keep;
  }

  // --- 4x6 builder ----------------------------------------------------------

  async function build4x6(pdfArrayBuffer, platform) {
    const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
    const out = await PDFLib.PDFDocument.create();

    const useIndices = await selectPageIndices(pdf, platform);
    const n = useIndices.length;

    for (let k = 0; k < n; k++) {
      const i = useIndices[k];
      setStatus(`Rendering label ${k + 1} of ${n} (${platform})…`);
      const { dataUrl } = await renderPageToPNG(pdf, i, 1200);

      const pngBytes = await (await fetch(dataUrl)).arrayBuffer();
      const img = await out.embedPng(pngBytes);

      const [W, H] = PAGE_4x6;
      const page = out.addPage([W, H]);

      const s = Math.min(W / img.width, H / img.height);
      const drawW = img.width * s;
      const drawH = img.height * s;
      const x = (W - drawW) / 2;
      const y = (H - drawH) / 2;

      page.drawImage(img, { x, y, width: drawW, height: drawH });
    }

    setStatus("Packaging PDF…");
    return out.save();
  }

  // --- UI wire-up -----------------------------------------------------------

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
