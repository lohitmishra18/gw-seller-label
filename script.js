document.getElementById("process").onclick = async () => {
  const file = document.getElementById("file").files[0];
  if (!file) return alert("Upload a PDF first!");

  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await PDFLib.PDFDocument.load(arrayBuffer);
  const newPdf = await PDFLib.PDFDocument.create();

  const pages = await newPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());

  pages.forEach((p) => {
    // Create a new 4x6 inch page
    const newPage = newPdf.addPage([288, 432]);

    // Scale original page to fit 4x6
    const { width, height } = p.getSize();
    const scale = Math.min(288 / width, 432 / height);

    const scaledWidth = width * scale;
    const scaledHeight = height * scale;

    const x = (288 - scaledWidth) / 2;
    const y = (432 - scaledHeight) / 2;

    newPage.drawPage(p, {
      x,
      y,
      xScale: scale,
      yScale: scale,
    });
  });

  const pdfBytes = await newPdf.save();
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  const link = document.getElementById("download");
  link.href = url;
  link.download = "labels.pdf";
  link.style.display = "inline";
};
