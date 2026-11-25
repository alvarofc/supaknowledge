// Best-effort PDF text extraction with unpdf (pdf.js serverless build). Loaded lazily so a broken or
// missing dependency only affects PDFs, never the rest of the worker.
export interface PdfText {
  text: string;
  pages: number | null;
  error: string | null;
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join("\n\n") : text;
    return { text: merged.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), pages: totalPages, error: null };
  } catch (e) {
    return { text: "", pages: null, error: e instanceof Error ? e.message : String(e) };
  }
}
