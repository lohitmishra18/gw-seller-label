document.getElementById("process").onclick = async () => {
  const file = document.getElementById("file").files[0];
  if (!file) return alert("Upload a PDF first!");

  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await PDFLib.PDFDocument.load(arrayBuffer);
  const newPdf = await PDFLib.PDFDocument.create();

  const pages = pdfDoc.getPages();

  // Loop through uploaded pages
  for (let i = 0; i < pages.length; i++) {
    const [origPage] = await newPdf.copyPages(pdfDoc, [i]);

    // Scale to 4x6 inch (288x432 pt @ 72dpi)
    const newPage = newPdf.addPage([288, 432]);
    newPage.drawPage(origPage, { x: 0, y: 0, width: 288, height: 432 });
  }

  const pdfBytes = await newPdf.save();
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  const link = document.getElementById("download");
  link.href = url;
  link.download = "labels.pdf";
  link.style.display = "inline";
};
