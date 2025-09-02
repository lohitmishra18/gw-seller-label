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
    // (kept exactly as you had it)
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

// ===== Summary button (Flipkart only) =====
const summaryBtn = document.getElementById("summary-btn");

// Flipkart-only enabling
document.addEventListener("change", (e) => {
  if (e.target && e.target.matches('input[name="platform"]')) {
    summaryBtn.disabled = e.target.value !== "flipkart";
  }
});

// Helpers reusing your Flipkart crop box
function _flipkartCropBounds(canvas) {
  const W = canvas.width, H = canvas.height;
  const leftPct = 0.28, rightPct = 0.28, topPct = 0.02, bottomKeepPct = 0.45;
  return {
    x0: Math.floor(W * leftPct),
    x1: Math.floor(W * (1 - rightPct)),
    y0: Math.floor(H * topPct),        // from top
    y1: Math.floor(H * bottomKeepPct), // from top
    W, H
  };
}

// Render whole page to canvas (same scale you use for labels)
async function _renderPageCanvas(pdf, pageIndex, widthTarget = 1200) {
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
}

// Collect text inside the crop area only
async function _getTextInsideFlipkartCrop(pdf, pageIndex) {
  const { page, canvas, scale } = await _renderPageCanvas(pdf, pageIndex, 1200);
  const bounds = _flipkartCropBounds(canvas);

  const tc = await page.getTextContent();
  const items = tc.items || [];
  const picked = [];

  for (const it of items) {
    const tr = it.transform;
    if (!tr) continue;
    const xPdf = tr[4], yPdf = tr[5];
    // convert to canvas top-origin coordinates
    const x = xPdf * scale;
    const yTop = canvas.height - (yPdf * scale);
    if (x >= bounds.x0 && x <= bounds.x1 && yTop >= bounds.y0 && yTop <= bounds.y1) {
      picked.push({ text: (it.str || "").trim(), x, yTop });
    }
  }
  return picked;
}

// Heuristics to extract SKU and QTY from the cropped text region
function _extractSkuQty(picked) {
  // Group items by approximate line (bucket by 6px)
  const lines = new Map();
  for (const it of picked) {
    const key = Math.round(it.yTop / 6) * 6;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(it);
  }

  // Find header lines
  let skuHeaderY = null, qtyHeaderY = null;
  for (const [y, arr] of lines) {
    const lineText = arr.map(a => a.text).join(" ");
    if (/\bSKU\s*ID\b/i.test(lineText) || /\bSKU\b/i.test(lineText)) skuHeaderY = y;
    if (/\bQTY\b/i.test(lineText)) qtyHeaderY = y;
  }

  // Helper: token must include at least one digit (to avoid "DELIGHTA")
  const hasDigit = s => /\d/.test(s);
  const GOOD_TOKEN = /^[A-Z0-9_-]{3,20}$/;

  const STOP = new Set([
    "SKU","ID","DESCRIPTION","QTY","REG","AWB","COD","SURFACE",
    "ORDERED","THROUGH","FLIPKART","NOT","FOR","RESALE","HBD","CPD",
    // seller/brand/common words seen on label
    "DELIGHTA","GREEN","PRIVATE","LIMITED","THEGREENWEALTH","SEAWEED",
    "EXTRACT","GRANULES","FERTILIZER","PLANTS"
  ]);

  // Scan lines just below the SKU header for a code-like token
  let candidates = [];
  for (const [y, arr] of lines) {
    if (skuHeaderY !== null && (y >= skuHeaderY) && (y <= skuHeaderY + 150)) {
      for (const a of arr) {
        const tok = (a.text || "").trim().toUpperCase();
        if (GOOD_TOKEN.test(tok) && hasDigit(tok) && !STOP.has(tok)) {
          candidates.push({ tok, y, x: a.x });
        }
      }
    }
  }

  // Choose the leftmost token on the first candidate line
  let sku = null;
  if (candidates.length) {
    candidates.sort((a, b) => a.y - b.y || a.x - b.x);
    sku = candidates[0].tok;
  } else {
    // Fallback: anywhere in crop region
    for (const it of picked) {
      const tok = (it.text || "").trim().toUpperCase();
      if (GOOD_TOKEN.test(tok) && hasDigit(tok) && !STOP.has(tok)) { sku = tok; break; }
    }
  }

  // Quantity: number on the QTY line (or near the header as fallback)
  let qty = 1;
  if (qtyHeaderY !== null) {
    const nums = (lines.get(qtyHeaderY) || [])
      .map(a => a.text.match(/^\d+$/))
      .filter(Boolean)
      .map(m => parseInt(m[0], 10))
      .filter(Number.isFinite);
    if (nums.length) qty = nums[0];
  } else if (skuHeaderY !== null) {
    // look for small integer within 120px under the header
    outer: for (const [y, arr] of lines) {
      if (y >= skuHeaderY && y <= skuHeaderY + 120) {
        for (const a of arr) {
          const m = a.text.match(/^\d+$/);
          if (m) { qty = parseInt(m[0], 10); break outer; }
        }
      }
    }
  }

  return { sku, qty };
}


// Build the Summary PDF
async function _buildFlipkartSummary(bytes) {
  const src = await pdfjsLib.getDocument({ data: bytes }).promise;

  // ---- Tally by (SKU, QTY) pair ----
  // key: `${sku}||${qty}` -> orders count
  const tallies = new Map();
  for (let i = 0; i < src.numPages; i++) {
    const picked = await _getTextInsideFlipkartCrop(src, i);
    const { sku, qty } = _extractSkuQty(picked);
    if (!sku) continue;

    const q = Number.isFinite(qty) ? qty : 1;
    const key = `${sku}||${q}`;
    tallies.set(key, (tallies.get(key) || 0) + 1);
  }

  // Convert to rows
  const rows = Array.from(tallies.entries()).map(([key, orders]) => {
    const [sku, qtyStr] = key.split("||");
    const qty = parseInt(qtyStr, 10);
    return { sku, qty, orders };
  });

  // Total orders = sum of orders over all (SKU, QTY) pairs
  const totalOrders = rows.reduce((s, r) => s + r.orders, 0);

  // ---- Compose summary PDF (A4) ----
  const out = await PDFLib.PDFDocument.create();
  const page = out.addPage([595.28, 841.89]); // A4
  const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await out.embedFont(PDFLib.StandardFonts.HelveticaBold);

  let y = 800;
  page.drawText("Via Green Wealth", { x: 40, y, size: 22, font: bold }); 
  y -= 28;

  page.drawText(`Total Orders: ${totalOrders}`, { x: 40, y, size: 14, font: bold });
  y -= 22;

  // Continuous columns (no gaps)
  const colX = [40, 260, 320];    // SKU, QTY, ORDERS
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

  // Header
  cell("sku",    colX[0], y, colW[0], false, true);
  cell("qty",    colX[1], y, colW[1], true,  true);
  cell("orders", colX[2], y, colW[2], true,  true);
  y -= rowH;

  // Sort by SKU then QTY
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


// Click handler: build & download summary
if (summaryBtn) {
  summaryBtn.addEventListener("click", async () => {
    const fileInput = document.getElementById("file");
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) { alert("Please choose a PDF file first."); return; }
    try {
      setStatus("Building Flipkart summary…");
      const bytes = await file.arrayBuffer();
      const outBytes = await _buildFlipkartSummary(bytes);
      const blob = new Blob([outBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "summary-flipkart.pdf";
      document.body.appendChild(a); a.click(); a.remove();
      setStatus("Summary ready.");
    } catch (err) {
      console.error(err);
      setStatus("Error building summary.");
      alert("Failed to build summary: " + (err?.message || err));
    }
  });
}

// Also: enable Summary immediately if Flipkart was already selected on load
(function initSummaryState(){
  const checked = document.querySelector('input[name="platform"]:checked');
  if (checked) summaryBtn.disabled = checked.value !== "flipkart";
})();


  // --- Beautiful popup for Meesho ---
(function bindMeeshoPopup() {
  const meesho = document.querySelector('input[name="platform"][value="meesho"]');
  const overlay = document.getElementById("popup-overlay");
  const closeBtn = document.getElementById("popup-close");

  function showPopup() {
    overlay.classList.remove("hidden");
  }

  function hidePopup() {
    overlay.classList.add("hidden");
  }

  if (meesho) {
    meesho.addEventListener("change", () => {
      if (meesho.checked) showPopup();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", hidePopup);
  }

  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hidePopup();
    });
  }
})();

})();
