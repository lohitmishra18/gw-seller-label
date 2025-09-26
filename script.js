(() => {
  const INCH = 72;
  const PAGE_4x6 = [4 * INCH, 6 * INCH]; // 288 x 432

  const $ = (s) => document.querySelector(s);
  const statusEl = $("#status");
  const dl = $("#download");
  const summaryBtn = document.getElementById("summary-btn");
  const processBtn = document.getElementById("process-btn"); // may not exist on all pages

  function setStatus(t) { if (statusEl) statusEl.textContent = t || ""; }
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

  // --------- AMAZON: helper to append SKU inside ITEM TYPE cell ----------
  function drawSkuInAmazonItemTypeCell(canvas, pageObj, tc, sku) {
    if (!sku) return;

    // Find "ITEM TYPE" header token
    let header = null;
    for (const it of tc.items || []) {
      const t = (it.str || "").trim().toUpperCase();
      if (t.includes("ITEM TYPE")) {
        header = { x: it.transform[4], y: it.transform[5] };
        break;
      }
    }
    if (!header) return;

    // In PDF coordinates origin is bottom-left; rows are BELOW header => y is LESS than header.y
    // Pick the closest baseline directly below the header
    let rowY = null;
    for (const it of tc.items || []) {
      const y = it.transform[5];
      const dy = header.y - y; // positive if token is below header
      if (dy > 1 && (rowY === null || Math.abs(header.y - y) < Math.abs(header.y - rowY))) {
        rowY = y;
      }
    }
    if (rowY === null) return;

    // Gather tokens on that baseline and after the ITEM TYPE column start (>= header.x)
    const sameLineTol = 1.8;
    const rowTokens = (tc.items || [])
      .filter(it => Math.abs(it.transform[5] - rowY) < sameLineTol)
      .sort((a, b) => a.transform[4] - b.transform[4]);

    // Compute right-edge inside the ITEM TYPE column on that row
    let rightEdgeX = header.x;
    let fertilizerToken = null;
    for (const it of rowTokens) {
      if (it.transform[4] >= header.x - 2) {
        const tok = (it.str || "").trim();
        if (!fertilizerToken && tok.toUpperCase().includes("FERTILIZER")) fertilizerToken = it;
        const approxRight = it.transform[4] + (it.width || (tok.length * 5.8)); // width fallback
        if (approxRight > rightEdgeX) rightEdgeX = approxRight;
      }
    }

    // Choose x to draw: after "FERTILIZER" if present; otherwise after the farthest token in that cell
    const baseXPdf = fertilizerToken
      ? (fertilizerToken.transform[4] + (fertilizerToken.width || (fertilizerToken.str.length * 5.8)))
      : rightEdgeX;

    // Convert to canvas coordinates
    const scale = canvas.width / pageObj.view[2];
    const xCanvas = baseXPdf * scale + 12; // small padding inside the cell
    const yCanvas = canvas.height - (rowY * scale) + 18;

    // ★ draw SKU inside ITEM TYPE
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.font = "bold 18px Arial";
    ctx.fillStyle = "#000";
    ctx.textAlign = "left";
    ctx.fillText(sku, xCanvas, yCanvas);
    ctx.restore();
  }

  // --------- 4x6 builder ----------
  async function build4x6(pdfArrayBuffer, platform) {
    const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
    const out = await PDFLib.PDFDocument.create();
    let indices = [...Array(pdf.numPages).keys()];
    if (platform === "amazon") indices = await amazonSelectKeepIndices(pdf);

    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      setStatus(`Rendering label ${k + 1} of ${indices.length} (${platform})…`);
      let targetW = 1200;
      if (platform === "flipkart") targetW = 1800;
      if (platform === "meesho") targetW = 1800;

      let dataUrl, imgWidth, imgHeight, pageW, pageH;

      if (platform === "flipkart") {
        const canvas = await renderPageToCanvas(pdf, i, targetW);
        dataUrl = cropFlipkart(canvas);
        imgWidth = canvas.width;
        imgHeight = canvas.height;
        pageW = 288; pageH = 432;

      } else if (platform === "meesho") {
        const croppedCanvas = await cropMeesho(pdf, i, targetW);
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

      } else if (platform === "amazon") {
        // Render label page to canvas
        const canvas = await renderPageToCanvas(pdf, i, targetW);
        // Try to extract SKU from the next page (invoice page)
        let sku = "";
        if (i + 1 < pdf.numPages) {
          const invoicePage = await pdf.getPage(i + 2); // i is 0-based, getPage is 1-based
          const tc = await invoicePage.getTextContent();
          const text = (tc.items || []).map(x => (x.str || "")).join(" ");
          const rx = /\b[A-Za-z0-9]+_[A-Za-z0-9]+\b/g;
          const allSkus = [...new Set((text.match(rx) || []).filter(sku => !/^B0[A-Z0-9]{8,}$/i.test(sku)))];
          sku = allSkus[0] || "";
          console.log('AMAZON LABEL PAGE', i + 1, 'EXTRACTED SKU FROM INVOICE PAGE:', sku);
        }
        // Overwrite the ITEM TYPE cell with SKU (and original value if present)
        if (sku) {
          const page = await pdf.getPage(i + 1);
          const tc = await page.getTextContent();
          // Find ITEM TYPE header position
          let itemTypeHeader = null;
          for (const item of tc.items) {
            if ((item.str || "").toUpperCase().includes("ITEM TYPE")) {
              itemTypeHeader = { x: item.transform[4], y: item.transform[5] };
              break;
            }
          }
          // Find the cell value in the same column (closest x, greater y)
          let itemTypeCell = null;
          if (itemTypeHeader) {
            let minDy = Infinity;
            for (const item of tc.items) {
              const dx = Math.abs(item.transform[4] - itemTypeHeader.x);
              const dy = item.transform[5] - itemTypeHeader.y;
              if (dx < 10 && dy > 5 && dy < minDy && item.str && item.str.trim() && item.str !== "ITEM TYPE") {
                minDy = dy;
                itemTypeCell = { x: item.transform[4], y: item.transform[5], text: item.str };
              }
            }
          }
          // Overwrite the ITEM TYPE cell with SKU (and original value if present)
          const ctx = canvas.getContext("2d");
          ctx.save();
          ctx.font = "bold 20px Arial";
          ctx.fillStyle = "#000";
          ctx.textAlign = "left";
          const pageView = page.view || [0, 0, canvas.width, canvas.height];
          const scale = canvas.width / pageView[2];
          let x, y;
          if (itemTypeCell) {
            x = itemTypeCell.x * scale + 8;
            y = canvas.height - (itemTypeCell.y * scale) + 20;
            ctx.fillStyle = "#fff";
            ctx.fillRect(x - 2, y - 18, 180, 24);
            ctx.fillStyle = "#000";
            ctx.fillText((itemTypeCell.text + ' ' + sku).trim(), x, y);
          } else if (itemTypeHeader) {
            x = itemTypeHeader.x * scale + 8;
            y = canvas.height - ((itemTypeHeader.y - 20) * scale) + 20;
            ctx.fillStyle = "#fff";
            ctx.fillRect(x - 2, y - 18, 180, 24);
            ctx.fillStyle = "#000";
            ctx.fillText(sku, x, y);
          }
          ctx.restore();
        }
        // Overwrite the ITEM TYPE cell with SKU and Quantity (guaranteed visible, fixed position)
        let qty = 1;
        if (sku) {
          // Extract quantity from invoice page text
          if (i + 1 < pdf.numPages) {
            const invoicePage = await pdf.getPage(i + 2);
            const tcInv = await invoicePage.getTextContent();
            const textInv = (tcInv.items || []).map(x => (x.str || "")).join(" ");
            const m1 = textInv.match(/\bQty\s+(\d+)\b/i);
            if (m1) qty = parseInt(m1[1], 10);
            else {
              const m2 = textInv.match(/₹[\d,]+(?:\.\d{1,2})?\s+(\d+)\s+₹/);
              if (m2) qty = parseInt(m2[1], 10);
            }
          }
          const ctx = canvas.getContext("2d");
          ctx.save();
          ctx.font = "bold 30px Arial";
          ctx.fillStyle = "#000";
          ctx.textAlign = "left";
          // Draw SKU and QTY at a fixed position near the bottom right of the table
          const x = canvas.width - 350;
          const y = canvas.height - 200;
          ctx.fillText(`${sku}`, x, y);
          ctx.font = "bold 30px Arial";
          ctx.fillText(`QTY: ${qty}`, x, y + 28);
          ctx.restore();
        }
        dataUrl = canvas.toDataURL("image/png");
        imgWidth = canvas.width;
        imgHeight = canvas.height;
        pageW = 288; pageH = 432;

      } else {
        const canvas = await renderPageToCanvas(pdf, i, targetW);
        dataUrl = canvas.toDataURL("image/png");
        imgWidth = canvas.width;
        imgHeight = canvas.height;
        pageW = 288; pageH = 432;
      }

      const pngBytes = await (await fetch(dataUrl)).arrayBuffer();
      const img = await out.embedPng(pngBytes);
      const W = pageW, H = pageH;
      const outPage = out.addPage([W, H]);

      if (platform === "meesho") {
        outPage.drawImage(img, { x: 0, y: 0, width: W, height: H });
      } else {
        const s = Math.min(W / img.width, H / img.height);
        const dw = img.width * s, dh = img.height * s;
        const x = (W - dw) / 2, y = (H - dh) / 2;
        outPage.drawImage(img, { x, y, width: dw, height: dh });
      }
    }
    setStatus("Packaging PDF…");
    return out.save();
  }

  // --------- Download Labels button ----------
  if (dl) {
    dl.addEventListener("click", async (e) => {
      e.preventDefault();
      const file = $("#file") && $("#file").files[0];
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
      } catch (e2) {
        console.error(e2);
        setStatus("Error: " + (e2?.message || e2));
        alert("Failed: " + (e2?.message || e2));
      }
    });
  }

  // ===== Summary button =====
  function updateSummaryBtnState() {
    const file = $("#file") && $("#file").files[0];
    const platform = getPlatform();
    if (summaryBtn) {
      summaryBtn.disabled = !(file && (platform === "flipkart" || platform === "amazon" || platform === "meesho"));
    }
  }

  if ($("#file")) $("#file").addEventListener("change", updateSummaryBtnState);
  document.addEventListener("change", (e) => {
    if (e.target && e.target.matches('input[name="platform"]')) {
      updateSummaryBtnState();
    }
  });
  updateSummaryBtnState();

  // --------- Flipkart summary helpers ---------
  async function _buildFlipkartSummary(bytes) {
    const src = await pdfjsLib.getDocument({ data: bytes }).promise;
    const tallies = new Map();
    for (let i = 0; i < src.numPages; i++) {
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

      // Group items by approximate line
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

      const hasDigit = s => /\d/.test(s);
      const GOOD_TOKEN = /^[A-Za-z0-9_\-()]{3,30}$/;
      const STOP = new Set([
        "SKU","ID","DESCRIPTION","QTY","REG","AWB","COD","SURFACE",
        "ORDERED","THROUGH","FLIPKART","NOT","FOR","RESALE","HBD","CPD",
        "DELIGHTA","GREEN","PRIVATE","LIMITED","THEGREENWEALTH","SEAWEED",
        "EXTRACT","GRANULES","FERTILIZER","PLANTS"
      ]);
      const TRACKING_ID = /^[A-Z]{2,}\d{6,}/;

      let candidates = [];
      for (const [y, arr] of lines) {
        if (skuHeaderY !== null && (y >= skuHeaderY) && (y <= skuHeaderY + 150)) {
          for (const a of arr) {
            const tok = (a.text || "").trim();
            if (GOOD_TOKEN.test(tok) && hasDigit(tok) && !STOP.has(tok.toUpperCase()) && !TRACKING_ID.test(tok)) {
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
          if (GOOD_TOKEN.test(tok) && hasDigit(tok) && !STOP.has(tok.toUpperCase()) && !TRACKING_ID.test(tok)) { sku = tok; break; }
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
    let page = out.addPage([595.28, 841.89]); // A4
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
      if (y < 80) { y = 760; page = out.addPage([595.28, 841.89]); }
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
      const rx = /\b[A-Za-z0-9]+_[A-Za-z0-9]+\b/g;
      const allSkus = [...new Set((text.match(rx) || []).filter(sku => !/^B0[A-Z0-9]{8,}$/i.test(sku)))];

      let qty = 1;
      const m1 = text.match(/\bQty\s+(\d+)\b/i);
      if (m1) qty = parseInt(m1[1], 10);
      else {
        const m2 = text.match(/₹[\d,]+(?:\.\d{1,2})?\s+(\d+)\s+₹/);
        if (m2) qty = parseInt(m2[1], 10);
      }

      for (const sku of allSkus) {
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
    let page = out.addPage([595.28, 841.89]); // A4
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
      if (y < 80) { y = 760; page = out.addPage([595.28, 841.89]); }
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
    let page = out.addPage([595.28, 841.89]);
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
      if (y < 80) { y = 760; page = out.addPage([595.28, 841.89]); }
      cell(r.sku, colX[0], y, colW[0]);
      cell(r.qty, colX[1], y, colW[1], true);
      cell(r.orders, colX[2], y, colW[2], true);
      y -= rowH;
    }

    return out.save();
  }

  // --------- Summary button handler ---------
  if (summaryBtn) {
    summaryBtn.addEventListener("click", async () => {
      const file = $("#file") && $("#file").files[0];
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
      } catch (e2) {
        console.error(e2);
        setStatus("Error: " + (e2?.message || e2));
        alert("Failed: " + (e2?.message || e2));
      }
    });
  }

  // ---------- Amazon helpers used by legacy process ----------
  function _amazonExtractSku(text) {
    const rx = /\b[A-Za-z0-9]+_[A-Za-z0-9]+\b/g;
    const matches = text.match(rx) || [];
    return matches.filter(sku => !/^B0[A-Z0-9]{8,}$/i.test(sku));
  }

  async function _extractSkuQty(pdf, pageIndex) {
    const page = await pdf.getPage(pageIndex + 1);
    const tc = await page.getTextContent();
    const text = (tc.items || []).map(x => (x.str || "")).join(" ");
    const skus = _amazonExtractSku(text);
    let qty = 1;
    const m1 = text.match(/\bQty\s+(\d+)\b/i);
    if (m1) qty = parseInt(m1[1], 10);
    else {
      const m2 = text.match(/₹[\d,]+(?:\.\d{1,2})?\s+(\d+)\s+₹/);
      if (m2) qty = parseInt(m2[1], 10);
    }
    return { skus, qty };
  }

  async function _amazonExtractAll(pdf) {
    const total = pdf.numPages;
    const { skus } = await _extractSkuQty(pdf, 0);
    const skuSet = new Set(skus);
    const keepIndices = [];
    for (let i = 0; i < total; i++) {
      if (i === 0) { keepIndices.push(i); continue; }
      const page = await pdf.getPage(i + 1);
      const tc = await page.getTextContent();
      const text = (tc.items || []).map(x => (x.str || "")).join(" ");
      const pageSkus = _amazonExtractSku(text);
      const hasCommonSku = pageSkus.some(sku => skuSet.has(sku));
      if (hasCommonSku) keepIndices.push(i);
    }
    return keepIndices;
  }

  // --------- Optional: Process labels legacy button (guarded) ---------
  if (processBtn) {
    processBtn.addEventListener("click", async () => {
      const file = $("#file") && $("#file").files[0];
      if (!file) { alert("Please choose a PDF file."); return; }
      const platform = getPlatform();
      setStatus("Processing…");
      try {
        const bytes = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        let indices = [...Array(pdf.numPages).keys()];
        if (platform === "amazon") {
          indices = await _amazonExtractAll(pdf);
          console.log("Amazon indices:", indices);
        }

        const out = await PDFLib.PDFDocument.create();
        for (let k = 0; k < indices.length; k++) {
          const i = indices[k];
          setStatus(`Rendering label ${k + 1} of ${indices.length} (${platform})…`);
          let targetW = 1200;
          if (platform === "flipkart") targetW = 1800;
          if (platform === "meesho") targetW = 1800;

          let dataUrl, pageW, pageH;

          if (platform === "flipkart") {
            const canvas = await renderPageToCanvas(pdf, i, targetW);
            dataUrl = cropFlipkart(canvas);
            pageW = 288; pageH = 432;

          } else if (platform === "meesho") {
            const croppedCanvas = await cropMeesho(pdf, i, targetW);
            const scaleCanvas = document.createElement("canvas");
            scaleCanvas.width = 1800;
            scaleCanvas.height = 1200;
            const sctx = scaleCanvas.getContext("2d");
            sctx.imageSmoothingEnabled = true;
            sctx.drawImage(croppedCanvas, 0, 0, scaleCanvas.width, scaleCanvas.height);
            dataUrl = scaleCanvas.toDataURL("image/png");
            pageW = 1800; pageH = 1200;

          } else if (platform === "amazon") {
            // Render label page to canvas
            const canvas = await renderPageToCanvas(pdf, i, targetW);
            // Try to extract SKU from the next page (invoice page)
            let sku = "";
            if (i + 1 < pdf.numPages) {
              const invoicePage = await pdf.getPage(i + 2); // i is 0-based, getPage is 1-based
              const tc = await invoicePage.getTextContent();
              const text = (tc.items || []).map(x => (x.str || "")).join(" ");
              const rx = /\b[A-Za-z0-9]+_[A-Za-z0-9]+\b/g;
              const allSkus = [...new Set((text.match(rx) || []).filter(sku => !/^B0[A-Z0-9]{8,}$/i.test(sku)))];
              sku = allSkus[0] || "";
              console.log('AMAZON LABEL PAGE', i + 1, 'EXTRACTED SKU FROM INVOICE PAGE:', sku);
            }
            // Overwrite the ITEM TYPE cell with SKU (and original value if present)
            if (sku) {
              const page = await pdf.getPage(i + 1);
              const tc = await page.getTextContent();
              // Find ITEM TYPE header position
              let itemTypeHeader = null;
              for (const item of tc.items) {
                if ((item.str || "").toUpperCase().includes("ITEM TYPE")) {
                  itemTypeHeader = { x: item.transform[4], y: item.transform[5] };
                  break;
                }
              }
              // Find the cell value in the same column (closest x, greater y)
              let itemTypeCell = null;
              if (itemTypeHeader) {
                let minDy = Infinity;
                for (const item of tc.items) {
                  const dx = Math.abs(item.transform[4] - itemTypeHeader.x);
                  const dy = item.transform[5] - itemTypeHeader.y;
                  if (dx < 10 && dy > 5 && dy < minDy && item.str && item.str.trim() && item.str !== "ITEM TYPE") {
                    minDy = dy;
                    itemTypeCell = { x: item.transform[4], y: item.transform[5], text: item.str };
                  }
                }
              }
              // Overwrite the ITEM TYPE cell with SKU (and original value if present)
              const ctx = canvas.getContext("2d");
              ctx.save();
              ctx.font = "bold 20px Arial";
              ctx.fillStyle = "#000";
              ctx.textAlign = "left";
              const pageView = page.view || [0, 0, canvas.width, canvas.height];
              const scale = canvas.width / pageView[2];
              let x, y;
              if (itemTypeCell) {
                x = itemTypeCell.x * scale + 8;
                y = canvas.height - (itemTypeCell.y * scale) + 20;
                ctx.fillStyle = "#fff";
                ctx.fillRect(x - 2, y - 18, 180, 24);
                ctx.fillStyle = "#000";
                ctx.fillText((itemTypeCell.text + ' ' + sku).trim(), x, y);
              } else if (itemTypeHeader) {
                x = itemTypeHeader.x * scale + 8;
                y = canvas.height - ((itemTypeHeader.y - 20) * scale) + 20;
                ctx.fillStyle = "#fff";
                ctx.fillRect(x - 2, y - 18, 180, 24);
                ctx.fillStyle = "#000";
                ctx.fillText(sku, x, y);
              }
              ctx.restore();
            }
            // Overwrite the ITEM TYPE cell with SKU and Quantity (guaranteed visible, fixed position)
            let qty = 1;
            if (sku) {
              // Extract quantity from invoice page text
              if (i + 1 < pdf.numPages) {
                const invoicePage = await pdf.getPage(i + 2);
                const tcInv = await invoicePage.getTextContent();
                const textInv = (tcInv.items || []).map(x => (x.str || "")).join(" ");
                const m1 = textInv.match(/\bQty\s+(\d+)\b/i);
                if (m1) qty = parseInt(m1[1], 10);
                else {
                  const m2 = textInv.match(/₹[\d,]+(?:\.\d{1,2})?\s+(\d+)\s+₹/);
                  if (m2) qty = parseInt(m2[1], 10);
                }
              }
              const ctx = canvas.getContext("2d");
              ctx.save();
              ctx.font = "bold 30px Arial";
              ctx.fillStyle = "#000";
              ctx.textAlign = "left";
              // Draw SKU and QTY at a fixed position near the bottom right of the table
              const x = canvas.width - 350;
              const y = canvas.height - 200;
              ctx.fillText(`${sku}`, x, y);
              ctx.font = "bold 30px Arial";
              ctx.fillText(`QTY: ${qty}`, x, y + 28);
              ctx.restore();
            }
            dataUrl = canvas.toDataURL("image/png");
            imgWidth = canvas.width;
            imgHeight = canvas.height;
            pageW = 288; pageH = 432;

          } else {
            const canvas = await renderPageToCanvas(pdf, i, targetW);
            dataUrl = canvas.toDataURL("image/png");
            pageW = 288; pageH = 432;
          }

          const pngBytes = await (await fetch(dataUrl)).arrayBuffer();
          const img = await out.embedPng(pngBytes);
          const W = pageW, H = pageH;
          const outPage = out.addPage([W, H]);

          if (platform === "meesho") {
            outPage.drawImage(img, { x: 0, y: 0, width: W, height: H });
          } else {
            const s = Math.min(W / img.width, H / img.height);
            const dw = img.width * s, dh = img.height * s;
            const x = (W - dw) / 2, y = (H - dh) / 2;
            outPage.drawImage(img, { x, y, width: dw, height: dh });
          }
        }

        setStatus("Packaging PDF…");
        const outBytes = await out.save();
        const blob = new Blob([outBytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setStatus("Done. PDF opened in new tab.");
      } catch (e2) {
        console.error(e2);
        setStatus("Error: " + (e2?.message || e2));
        alert("Failed: " + (e2?.message || e2));
      }
    }); // end legacy click
  }
})();
