(() => {
  const INCH = 72;
  const PAGE_4x6 = [4 * INCH, 6 * INCH];          // [width, height] in points
  const A4 = [595.28, 841.89];                     // A4 points (portrait)
  const MARGIN = 18;                               // 0.25" margin on A4
  const GAP = 12;                                  // gap between labels on A4

  const $ = (sel) => document.querySelector(sel);
  const status = $("#status");
  const dl = $("#download");

  function setStatus(msg) { status.textContent = msg || ""; }

  function getMode() {
    const el = document.querySelector('input[name="mode"]:checked');
    return el ? el.value : "4x6";
  }

  $("#process").addEventListener("click", async () => {
    const file = $("#file").files[0];
    if (!file) {
      alert("Please choose a PDF file.");
      return;
    }

    dl.classList.add("hidden");
    dl.removeAttribute("href");
    setStatus("Reading PDF…");

    try {
      const bytes = await file.arrayBuffer();
      const src = await PDFLib.PDFDocument.load(bytes);

      const mode = getMode();
      const out =
        mode === "a4"
          ? await makeA4Grid(src)
          : await makeFourBySix(src);

      const blob = new Blob([out], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      dl.href = url;
      dl.download = mode === "a4" ? "labels-a4.pdf" : "labels-4x6.pdf";
      dl.classList.remove("hidden");

      setStatus("Done. Click Download.");
    } catch (err) {
      console.error(err);
      setStatus("Error: " + (err?.message || err));
      alert("Failed: " + (err?.message || err));
    }
  });

  /**
   * Mode 1: Each source page scaled onto its own 4×6 page.
   * Uses embedPage + drawPage with xScale/yScale — the correct pdf-lib flow.
   */
  async function makeFourBySix(srcDoc) {
    const out = await PDFLib.PDFDocument.create();

    const pageCount = srcDoc.getPageCount();
    for (let i = 0; i < pageCount; i++) {
      setStatus(`Processing page ${i + 1} of ${pageCount} (4×6)…`);

      const srcPage = srcDoc.getPage(i);
      // IMPORTANT: embedPage on the *target* document with a page from the *source*.
      const embedded = await out.embedPage(srcPage);

      const [W, H] = PAGE_4x6;
      const page = out.addPage([W, H]);

      // scale to fit while preserving aspect
      const { width, height } = embedded;
      const s = Math.min(W / width, H / height);
      const drawW = width * s;
      const drawH = height * s;
      const x = (W - drawW) / 2;
      const y = (H - drawH) / 2;

      // Correct API: drawPage(embeddedPage, { x, y, xScale, yScale })
      page.drawPage(embedded, { x, y, xScale: s, yScale: s });
    }

    return out.save();
  }

  /**
   * Mode 2: Pack labels on A4 (2×2 grid). Four per page.
   */
  async function makeA4Grid(srcDoc) {
    const out = await PDFLib.PDFDocument.create();

    const slots = 4;                   // 2×2 grid
    const cols = 2, rows = 2;

    // slot size (minus margins/gaps)
    const slotW = (A4[0] - MARGIN * 2 - GAP) / cols;
    const slotH = (A4[1] - MARGIN * 2 - GAP) / rows;

    let page = null;
    let slotIndex = 0;

    const n = srcDoc.getPageCount();
    for (let i = 0; i < n; i++) {
      if (slotIndex % slots === 0) {
        // new A4 page
        page = out.addPage(A4);
      }

      setStatus(`Placing label ${i + 1} of ${n} on A4…`);

      const srcPage = srcDoc.getPage(i);
      const embedded = await out.embedPage(srcPage);

      const { width, height } = embedded;
      const s = Math.min(slotW / width, slotH / height);

      // Which cell?
      const r = Math.floor((slotIndex % slots) / cols);
      const c = (slotIndex % slots) % cols;

      // Lower-left origin in pdf-lib
      const x0 = MARGIN + c * (slotW + GAP);
      const y0 = MARGIN + (rows - 1 - r) * (slotH + GAP);

      const drawW = width * s;
      const drawH = height * s;
      const x = x0 + (slotW - drawW) / 2;
      const y = y0 + (slotH - drawH) / 2;

      page.drawPage(embedded, { x, y, xScale: s, yScale: s });

      slotIndex++;
    }

    return out.save();
  }
})();
