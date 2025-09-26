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

  // --------- Amazon page filter ----------
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
        keep.push(i);
      }
    }

    if (keep.length === 0 && total >= 2) return [...Array(total).keys()].filter(i => i % 2 === 0);
    if (keep.length === 0) return [...Array(total).keys()];
    return keep;
  }

  // --------- Flipkart crop ----------
  function cropFlipkart(canvas) {
    const W = canvas.width, H = canvas.height;
    const leftPct = 0.28, rightPct = 0.28, topPct = 0.02, bottomKeepPct = 0.45;

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
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

    return c.toDataURL("image/png");
  }

  // --------- 4x6 builder ----------
  async function build4x6(pdfArrayBuffer, platform) {
    const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
    const out = await PDFLib.PDFDocument.create();

    let indices = [...Array(pdf.numPages).keys()];
    if (platform === "amazon") {
      indices = await amazonSelectKeepIndices(pdf);
    }

    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      setStatus(`Rendering label ${k + 1} of ${indices.length} (${platform})…`);

      const targetW = (platform === "flipkart") ? 1800 : 1200;
      const canvas = await renderPageToCanvas(pdf, i, targetW);

      let dataUrl;
      if (platform === "flipkart") {
        dataUrl = cropFlipkart(canvas);
      } else {
        dataUrl = canvas.toDataURL("image/png");
      }

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

  // ===== Summary button =====
  const summaryBtn = document.getElementById("summary-btn");

  document.addEventListener("change", (e) => {
    if (e.target && e.target.matches('input[name="platform"]')) {
      const v = e.target.value;
      summaryBtn.disabled = !(v === "flipkart" || v === "amazon" || v === "meesho");
    }
  });

  // --------- Flipkart summary helpers ---------
  async function _buildFlipkartSummary(bytes) {
    // (existing Flipkart summary logic here… omitted for brevity in this answer)
    // Keep your working version unchanged
  }

  async function _buildAmazonSummary(bytes) {
    // (your Amazon summary logic stays here)
  }

  // --------- Meesho summary ---------
  async function _meeshoPageText(pdf, pageIndex) {
    const page = await pdf.getPage(pageIndex + 1);
    const tc = await page.getTextContent();
    return tc.items.map(x => x.str).join(" ");
  }

  function _parseMeeshoSkuQty(pageText) {
    const regex = /(PROM_[0-9A-Z]+)\s+.*?\s+(\d+)\s+Black/gi;
    const results = [];
    let m;
    while ((m = regex.exec(pageText)) !== null) {
      const sku = m[1].trim();
      const qty = parseInt(m[2], 10) || 1;
      results.push({ sku, qty });
    }
    return results;
  }

  async function _buildMeeshoSummary(bytes) {
    const src = await pdfjsLib.getDocument({ data: bytes }).promise;

    const tallies = new Map();
    for (let i = 0; i < src.numPages; i++) {
      const text = await _meeshoPageText(src, i);
      const items = _parseMeeshoSkuQty(text);
      for (const { sku, qty } of items) {
        const key = `${sku}||${qty}`;
        tallies.set(key, (tallies.get(key) || 0) + 1);
      }
    }

    const rows = Array.from(tallies.entries()).map(([key, orders]) => {
      const [sku, qtyStr] = key.split("||");
      return { sku, qty: parseInt(qtyStr, 10), orders };
    });

    const totalOrders = rows.reduce((s, r) => s + r.orders, 0);

    const out = await PDFLib.PDFDocument.create();
    const page = out.addPage([595.28, 841.89]);
    const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await out.embedFont(PDFLib.StandardFonts.HelveticaBold);

    let y = 800;
    page.drawText("Via Green Wealth - Meesho", { x: 40, y, size: 22, font: bold });
    y -= 28;
    page.drawText(`Total Orders: ${totalOrders}`, { x: 40, y, size: 14, font: bold });
    y -= 22;

    const colX = [40, 260, 320];
    const colW = [220, 60, 60];
    const rowH = 18;

    function cell(text, x, y, w, alignRight=false, isBold=false){
      page.drawRectangle({ x, y: y-rowH+4, width: w, height: rowH, borderColor: PDFLib.rgb(0,0,0), borderWidth: 1 });
      const f = isBold ? bold : font;
      const s = 12;
      const str = String(text);
      const tw = f.widthOfTextAtSize(str, s);
      const tx = alignRight ? x + w - tw - 6 : x + 6;
      page.drawText(str, { x: tx, y: y - rowH + 8, size: s, font: f });
    }

    cell("sku", colX[0], y, colW[0], false, true);
    cell("qty", colX[1], y, colW[1], true, true);
    cell("orders", colX[2], y, colW[2], true, true);
    y -= rowH;

    rows.sort((a, b) => a.sku.localeCompare(b.sku) || a.qty - b.qty);
    for (const r of rows) {
      if (y < 80) { y = 760; out.addPage([595.28, 841.89]); }
      cell(r.sku, colX[0], y, colW[0]);
      cell(r.qty, colX[1], y, colW[1], true);
      cell(r.orders, colX[2], y, colW[2], true);
      y -= rowH;
    }

    return out.save();
  }

  // --------- Summary button handler ---------
  summaryBtn.addEventListener("click", async () => {
    const file = $("#file").files[0];
    if (!file) { alert("Please choose a PDF file."); return; }
    setStatus("Reading file for summary…");

    try {
      const bytes = await file.arrayBuffer();
      const platform = getPlatform();

      let outBytes;
      if (platform === "flipkart") {
        outBytes = await _buildFlipkartSummary(bytes);
      } else if (platform === "amazon") {
        outBytes = await _buildAmazonSummary(bytes);
      } else if (platform === "meesho") {
        outBytes = await _buildMeeshoSummary(bytes);
      } else {
        alert("Summary not supported.");
        return;
      }

      const blob = new Blob([outBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      dl.href = url;
      dl.download = `summary-${platform}.pdf`;
      dl.classList.remove("hidden");
      setStatus("Summary ready. Click Download.");
    } catch (e) {
      console.error(e);
      setStatus("Error: " + (e?.message || e));
      alert("Failed: " + (e?.message || e));
    }
  });

})();
