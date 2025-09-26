(() => {
  const INCH = 72;
  const PAGE_4x6 = [4 * INCH, 6 * INCH]; // 288 x 432

  const $ = (s) => document.querySelector(s);
  const statusEl = $("#status");
  const dl = $("#download");
  const summaryBtn = document.getElementById("summary-btn");

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

  // --------- Meesho crop ----------
  async function cropMeesho(pdf, pageIndex, targetPixelsWide) {
    // Render page to high-res canvas (e.g. 1200px wide for 4x6 at 300dpi)
    const highResW = 1200;
    const page = await pdf.getPage(pageIndex + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = highResW / vp1.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Find 'Tax Invoice' text position (crop up to just above it)
    const tc = await page.getTextContent();
    let taxInvoiceY = null;
    for (const item of tc.items) {
      if ((item.str || "").toLowerCase().includes("tax invoice")) {
        const yPdf = item.transform[5];
        taxInvoiceY = canvas.height - (yPdf * scale);
        taxInvoiceY = Math.max(0, taxInvoiceY - 24);
        break;
      }
    }
    if (taxInvoiceY === null) {
      taxInvoiceY = Math.floor(canvas.height * 0.6);
    }
    const cropHeight = Math.max(1, Math.floor(taxInvoiceY));
    const c = document.createElement("canvas");
    c.width = canvas.width;
    c.height = cropHeight;
    const cctx = c.getContext("2d");
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(canvas, 0, 0, canvas.width, cropHeight, 0, 0, canvas.width, cropHeight);
    return c;
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
      let targetW = 1200;
      if (platform === "flipkart") targetW = 1800;
      if (platform === "meesho") targetW = 1800; // 6x4 at 300dpi
      let dataUrl, imgWidth, imgHeight, pageW, pageH;
      if (platform === "flipkart") {
        const canvas = await renderPageToCanvas(pdf, i, targetW);
        dataUrl = cropFlipkart(canvas);
        const img = new window.Image();
        img.src = dataUrl;
        imgWidth = canvas.width;
        imgHeight = canvas.height;
        pageW = 288; pageH = 432;
      } else if (platform === "meesho") {
        const croppedCanvas = await cropMeesho(pdf, i, targetW);
        // No rotation, always landscape 6x4 (1800x1200)
        const scaleCanvas = document.createElement("canvas");
        scaleCanvas.width = 1800;
        scaleCanvas.height = 1200;
        const sctx = scaleCanvas.getContext("2d");
        sctx.imageSmoothingEnabled = true;
        sctx.drawImage(croppedCanvas, 0, 0, scaleCanvas.width, scaleCanvas.height);
        dataUrl = scaleCanvas.toDataURL("image/png");
        imgWidth = scaleCanvas.width;
        imgHeight = scaleCanvas.height;
        pageW = 1800; pageH = 1200;
      } else {
        const canvas = await renderPageToCanvas(pdf, i, targetW);
        dataUrl = canvas.toDataURL("image/png");
        imgWidth = canvas.width;
        imgHeight = canvas.height;
        pageW = 288; pageH = 432;
      }
      const pngBytes = await (await fetch(dataUrl)).arrayBuffer();
      const img = await out.embedPng(pngBytes);
      let W = pageW, H = pageH;
      const page = out.addPage([W, H]);
      if (platform === "meesho") {
        page.drawImage(img, { x: 0, y: 0, width: W, height: H });
      } else {
        const s = Math.min(W / img.width, H / img.height);
        const dw = img.width * s, dh = img.height * s;
        const x = (W - dw) / 2, y = (H - dh) / 2;
        page.drawImage(img, { x, y, width: dw, height: dh });
      }
    }
    setStatus("Packaging PDF…");
    return out.save();
  }

  // --------- UI ----------
  // Remove Process Labels button logic entirely
  // (No reference to $("#process") anymore)

  // Update Download Labels click handler to open PDF in new tab
  dl.addEventListener("click", async (e) => {
    e.preventDefault();
    const file = $("#file").files[0];
    if (!file) { alert("Please choose a PDF file."); return; }
    dl.classList.add("hidden");
    dl.removeAttribute("href");
    setStatus("Processing…");
    try {
      const bytes = await file.arrayBuffer();
      const platform = getPlatform();
      const outBytes = await build4x6(bytes, platform);
      const blob = new Blob([outBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setStatus("Done. Labels opened in new tab.");
    } catch (e) {
      console.error(e);
      setStatus("Error: " + (e?.message || e));
      alert("Failed: " + (e?.message || e));
    }
  });

  // ===== Summary button =====
  // Helper to enable/disable Download Summary button
  function updateSummaryBtnState() {
    const file = $("#file").files[0];
    const platform = getPlatform();
    summaryBtn.disabled = !(file && (platform === "flipkart" || platform === "amazon" || platform === "meesho"));
  }

  // Enable/disable Download Summary when file is selected
  $("#file").addEventListener("change", updateSummaryBtnState);

  // Enable/disable Download Summary when platform changes
  document.addEventListener("change", (e) => {
    if (e.target && e.target.matches('input[name="platform"]')) {
      updateSummaryBtnState();
    }
  });

  // On page load, set correct state
  updateSummaryBtnState();

  // --------- Flipkart summary helpers ---------
  async function _buildFlipkartSummary(bytes) {
    const src = await pdfjsLib.getDocument({ data: bytes }).promise;
    // ---- Tally by (SKU, QTY) pair ----
    // key: `${sku}||${qty}` -> orders count
    const tallies = new Map();
    for (let i = 0; i < src.numPages; i++) {
      // Use the same text extraction logic as before
      const { page, canvas, scale } = await (async function _renderPageCanvas(pdf, pageIndex, widthTarget = 2400) {
        const page = await pdf.getPage(pageIndex + 1);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = widthTarget / vp1.width;
        const viewport = page.getViewport({ scale });
        const c = document.createElement("canvas");
        const ctx = c.getContext("2d");
        c.width = Math.floor(viewport.width);
        c.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        return { page, canvas: c, scale };
      })(src, i, 1200);
      const bounds = (function _flipkartCropBounds(canvas) {
        const W = canvas.width, H = canvas.height;
        const leftPct = 0.28, rightPct = 0.28, topPct = 0.02, bottomKeepPct = 0.45;
        return {
          x0: Math.floor(W * leftPct),
          x1: Math.floor(W * (1 - rightPct)),
          y0: Math.floor(H * topPct),
          y1: Math.floor(H * bottomKeepPct),
          W, H
        };
      })(canvas);
      const tc = await page.getTextContent();
      const items = tc.items || [];
      const picked = [];
      for (const it of items) {
        const tr = it.transform;
        if (!tr) continue;
        const xPdf = tr[4], yPdf = tr[5];
        const x = xPdf * scale;
        const yTop = canvas.height - (yPdf * scale);
        if (x >= bounds.x0 && x <= bounds.x1 && yTop >= bounds.y0 && yTop <= bounds.y1) {
          picked.push({ text: (it.str || "").trim(), x, yTop });
        }
      }
      // Heuristics to extract SKU and QTY from the cropped text region
      // ... (same as your previous _extractSkuQty logic) ...
      // Group items by approximate line (bucket by 6px)
      const lines = new Map();
      for (const it of picked) {
        const key = Math.round(it.yTop / 6) * 6;
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push(it);
      }
      let skuHeaderY = null, qtyHeaderY = null;
      for (const [y, arr] of lines) {
        const lineText = arr.map(a => a.text).join(" ");
        if (/\bSKU\s*ID\b/i.test(lineText) || /\bSKU\b/i.test(lineText)) skuHeaderY = y;
        if (/\bQTY\b/i.test(lineText)) qtyHeaderY = y;
      }
      // Allow SKUs with underscores, numbers, letters, parentheses, and at least one digit
      const hasDigit = s => /\d/.test(s);
      const GOOD_TOKEN = /^[A-Za-z0-9_\-()]{3,30}$/;
      const STOP = new Set([
        "SKU","ID","DESCRIPTION","QTY","REG","AWB","COD","SURFACE",
        "ORDERED","THROUGH","FLIPKART","NOT","FOR","RESALE","HBD","CPD",
        "DELIGHTA","GREEN","PRIVATE","LIMITED","THEGREENWEALTH","SEAWEED",
        "EXTRACT","GRANULES","FERTILIZER","PLANTS"
      ]);
      // Exclude tracking IDs (e.g. SF2171888115FPL)
      const TRACKING_ID = /^[A-Z]{2,}\d{6,}/;
      let candidates = [];
      for (const [y, arr] of lines) {
        if (skuHeaderY !== null && (y >= skuHeaderY) && (y <= skuHeaderY + 150)) {
          for (const a of arr) {
            const tok = (a.text || "").trim();
            if (
              GOOD_TOKEN.test(tok) &&
              hasDigit(tok) &&
              !STOP.has(tok.toUpperCase()) &&
              !TRACKING_ID.test(tok)
            ) {
              candidates.push({ tok, y, x: a.x });
            }
          }
        }
      }
      let sku = null;
      if (candidates.length) {
        candidates.sort((a, b) => a.y - b.y || a.x - b.x);
        sku = candidates[0].tok;
      } else {
        for (const it of picked) {
          const tok = (it.text || "").trim();
          if (
            GOOD_TOKEN.test(tok) &&
            hasDigit(tok) &&
            !STOP.has(tok.toUpperCase()) &&
            !TRACKING_ID.test(tok)
          ) { sku = tok; break; }
        }
      }
      let qty = 1;
      if (qtyHeaderY !== null) {
        const nums = (lines.get(qtyHeaderY) || [])
          .map(a => a.text.match(/^\d+$/))
          .filter(Boolean)
          .map(m => parseInt(m[0], 10))
          .filter(Number.isFinite);
        if (nums.length) qty = nums[0];
      } else if (skuHeaderY !== null) {
        outer: for (const [y, arr] of lines) {
          if (y >= skuHeaderY && y <= skuHeaderY + 120) {
            for (const a of arr) {
              const m = a.text.match(/^\d+$/);
              if (m) { qty = parseInt(m[0], 10); break outer; }
            }
          }
        }
      }
      if (!sku) continue;
      const q = Number.isFinite(qty) ? qty : 1;
      const key = `${sku}||${q}`;
      tallies.set(key, (tallies.get(key) || 0) + 1);
    }
    const rows = Array.from(tallies.entries()).map(([key, orders]) => {
      const [sku, qtyStr] = key.split("||");
      const qty = parseInt(qtyStr, 10);
      return { sku, qty, orders };
    });
    const totalOrders = rows.reduce((s, r) => s + r.orders, 0);
    const out = await PDFLib.PDFDocument.create();
    const page = out.addPage([595.28, 841.89]); // A4
    const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await out.embedFont(PDFLib.StandardFonts.HelveticaBold);
    let y = 800;
    page.drawText("Via Green Wealth", { x: 40, y, size: 22, font: bold });
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
    cell("sku",    colX[0], y, colW[0], false, true);
    cell("qty",    colX[1], y, colW[1], true,  true);
    cell("orders", colX[2], y, colW[2], true,  true);
    y -= rowH;
    rows.sort((a, b) => a.sku.localeCompare(b.sku) || a.qty - b.qty);
    for (const r of rows) {
      if (y < 80) { y = 760; out.addPage([595.28, 841.89]); }
      cell(r.sku,    colX[0], y, colW[0]);
      cell(r.qty,    colX[1], y, colW[1], true);
      cell(r.orders, colX[2], y, colW[2], true);
      y -= rowH;
    }
    return out.save();
  }

  async function _buildAmazonSummary(bytes) {
    const src = await pdfjsLib.getDocument({ data: bytes }).promise;
    const tallies = new Map();
    for (let i = 0; i < src.numPages; i++) {
      const page = await src.getPage(i + 1);
      const tc = await page.getTextContent();
      const text = (tc.items || []).map(x => (x.str || "")).join(" ");
      // Extract SKU
      const parenTokens = Array.from(text.matchAll(/\(\s*([A-Z0-9_]+(?:\(\d+\))?)\s*\)/g)).map(m => (m[1] || "").trim().toUpperCase());
      const sku = parenTokens.find(tok => tok.includes("_") && !/^B0[A-Z0-9]{8,}$/i.test(tok));
      if (!sku) continue;
      // Extract QTY
      let qty = 1;
      const m1 = text.match(/\bQty\s+(\d+)\b/i);
      if (m1) qty = parseInt(m1[1], 10);
      else {
        const m2 = text.match(/₹[\d,]+(?:\.\d{1,2})?\s+(\d+)\s+₹/);
        if (m2) qty = parseInt(m2[1], 10);
      }
      const key = `${sku}||${qty}`;
      tallies.set(key, (tallies.get(key) || 0) + 1);
    }
    const rows = Array.from(tallies.entries()).map(([key, orders]) => {
      const [sku, qtyStr] = key.split("||");
      return { sku, qty: parseInt(qtyStr, 10), orders };
    });
    const totalOrders = rows.reduce((s, r) => s + r.orders, 0);
    const out = await PDFLib.PDFDocument.create();
    const page = out.addPage([595.28, 841.89]); // A4
    const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await out.embedFont(PDFLib.StandardFonts.HelveticaBold);
    let y = 800;
    page.drawText("Via Green Wealth — Amazon", { x: 40, y, size: 22, font: bold });
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
    cell("sku",    colX[0], y, colW[0], false, true);
    cell("qty",    colX[1], y, colW[1], true,  true);
    cell("orders", colX[2], y, colW[2], true,  true);
    y -= rowH;
    rows.sort((a, b) => a.sku.localeCompare(b.sku) || a.qty - b.qty);
    for (const r of rows) {
      if (y < 80) { y = 760; out.addPage([595.28, 841.89]); }
      cell(r.sku,    colX[0], y, colW[0]);
      cell(r.qty,    colX[1], y, colW[1], true);
      cell(r.orders, colX[2], y, colW[2], true);
      y -= rowH;
    }
    return out.save();
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
    setStatus("Processing…");
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
      window.open(url, "_blank");
      setStatus("Done. Summary opened in new tab.");
    } catch (e) {
      console.error(e);
      setStatus("Error: " + (e?.message || e));
      alert("Failed: " + (e?.message || e));
    }
  });

  // Extracts the SKU token that appears inside parentheses in description,
  // e.g. "... | B0FGDD62P5 ( PROM_900G )" or "( PROM_3600G(2) )".
  // We ignore ASINs like B0FGDD62P5 and only accept tokens with an underscore.
  function _amazonExtractSku(text) {
    // First, try to find SKUs inside parentheses
    const parenTokens = Array.from(text.matchAll(/\(\s*([A-Za-z0-9_\-()]+)\s*\)/g))
      .map(m => (m[1] || "").trim());
    // Accept SKUs with underscore and at least one digit, but not ASINs
    let sku = parenTokens.find(tok => tok.includes("_") && /\d/.test(tok) && !/^B0[A-Z0-9]{8,}$/i.test(tok));
    if (sku) return sku;
    // Fallback: find any token with underscore and digit, not ASIN, anywhere in text
    const fallback = Array.from(text.matchAll(/\b([A-Za-z0-9_\-]{4,})\b/g))
      .map(m => m[1])
      .find(tok => tok.includes("_") && /\d/.test(tok) && !/^B0[A-Z0-9]{8,}$/i.test(tok));
    return fallback || null;
  }

})();
