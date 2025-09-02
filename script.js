document.getElementById("process").onclick = async () => {
  const file = document.getElementById("file").files[0];
  if (!file) return alert("Upload a PDF first!");

  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await PDFLib.PDFDocument.load(arrayBuffer);
  const newPdf = await PDFLib.PDFDocument.create();

  const pages = pdfDoc.getPages();

  for (let i = 0; i < pages.length; i++) {
    // Correct: embed the original page
    const [embeddedPage] = await newPdf.embedPages([pages[i]]);

    // Make new blank 4x6 inch page
    const newPage = newPdf.addPage([288, 432]);

    // Scale to fit
    const { width, height } = embeddedPage;
    const scale = Math.min(288 / width, 432 / height);

    const scaledWidth = width * scale;
    const scaledHeight = height * scale;

    const x = (288 - scaledWidth) / 2;
    const y = (432 - scaledHeight) / 2;

    // ✅ This is the right API call
    newPage.drawPage(embeddedPage, {
      x,
      y,
      xScale: scale,
      yScale: scale,
    });
  }

  const pdfBytes = await newPdf.save();
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  const link = document.getElementById("download");
  link.href = url;
  link.download = "labels.pdf";
  link.style.display = "inline";
};
