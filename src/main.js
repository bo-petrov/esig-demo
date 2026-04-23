import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { initSignatureCapture } from './signatureCapture.js';
import { extractTextWithPositions } from './anchorSearch.js';
import { stampSignatureAtAnchor, highlightAnchorInPdf } from './stamper.js';
import { initMobileSimulation } from './mobileSimulation.js';
import './style.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const DEFAULT_PDF_URL = '/protocol_not_signed_6333227.pdf';
const RENDER_SCALE = 1.4;

const logEl = document.getElementById('log');
const pdfContainer = document.getElementById('pdf-container');
const signatureCanvas = document.getElementById('signature-pad');
const anchorInput = document.getElementById('anchor-input');
const fileInput = document.getElementById('pdf-file');

function log(message, level = 'info') {
  const ts = new Date().toLocaleTimeString();
  const prefix = level === 'error' ? '✗' : level === 'warn' ? '!' : '›';
  logEl.textContent += `[${ts}] ${prefix} ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  if (level === 'error') console.error(message);
}

const signature = initSignatureCapture({
  canvas: signatureCanvas,
  clearButton: document.getElementById('clear-sig'),
  log,
});

const downloadBtn = document.getElementById('download');
downloadBtn.disabled = true;
let lastSignedBytes = null;

document.getElementById('find-stamp').addEventListener('click', async () => {
  if (!currentPdfBytes) return log('No PDF loaded.', 'warn');
  const sigB64 = signature.getSignatureBase64();
  if (!sigB64) return log('Draw a signature first.', 'warn');
  const phrase = anchorInput.value.trim();
  if (!phrase) return log('Enter an anchor phrase.', 'warn');

  try {
    log(`Searching for "${phrase}" and stamping…`);
    const result = await stampSignatureAtAnchor({
      pdfBytes: currentPdfBytes,
      signatureBase64: sigB64,
      anchorPhrase: phrase,
      signatureSize: { width: 160, height: 50 },
      placement: { type: 'right-and-up', offsetX: 8, offsetY: 2 },
    });

    const p = result.placedAt;
    log(
      `Match: "${result.matchedText}" → stamped on p${p.pageIndex} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}), ${p.width}×${p.height}pt`
    );

    lastSignedBytes = result.pdfBytes;
    downloadBtn.disabled = false;

    await renderPdfBytes(new Uint8Array(result.pdfBytes), 'signed-document.pdf');
    log('Preview updated with signed PDF. Download is enabled.');
  } catch (err) {
    log(`Stamp failed: ${err.message}`, 'error');
  }
});

downloadBtn.addEventListener('click', () => {
  if (!lastSignedBytes) return;
  const blob = new Blob([lastSignedBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'signed-document.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log('Downloaded signed-document.pdf');
});

document.getElementById('debug-highlight').addEventListener('click', async () => {
  if (!currentPdfBytes) return log('No PDF loaded.', 'warn');
  const phrase = anchorInput.value.trim();
  if (!phrase) return log('Enter an anchor phrase.', 'warn');

  try {
    log(`Highlighting anchor "${phrase}"…`);
    const result = await highlightAnchorInPdf({
      pdfBytes: currentPdfBytes,
      anchorPhrase: phrase,
    });

    const a = result.anchor;
    log(
      `Anchor "${a.matchedText}" on p${a.pageIndex} at (${a.x.toFixed(1)}, ${a.y.toFixed(1)}), ${a.width.toFixed(1)}×${a.height.toFixed(1)}pt`
    );

    await renderPdfBytes(new Uint8Array(result.pdfBytes), 'debug-highlight.pdf');
    log('Preview updated with anchor highlight.');
  } catch (err) {
    log(`Highlight failed: ${err.message}`, 'error');
  }
});

// Kept at module scope so later wiring (Find Anchor & Stamp, Download, etc.)
// can reach the currently loaded document's bytes and text items.
let currentPdfBytes = null;
let currentItems = null;

async function renderPdfBytes(pdfBytes, label) {
  pdfContainer.innerHTML = '';
  log(`Loading PDF: ${label}`);

  // pdfjs may transfer the underlying ArrayBuffer to its worker, which would
  // detach our copy. Pass a fresh slice so currentPdfBytes stays usable.
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
  const pdf = await loadingTask.promise;
  log(`PDF loaded — ${pdf.numPages} page(s).`);

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pdfContainer.appendChild(canvas);

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
    }).promise;
  }

  log(`Rendered ${pdf.numPages} page(s) at ${RENDER_SCALE}× scale.`);
}

async function loadDocument(pdfBytes, label) {
  currentPdfBytes = pdfBytes;
  currentItems = null;

  await renderPdfBytes(pdfBytes, label);

  const items = await extractTextWithPositions(pdfBytes.slice());
  currentItems = items;

  log(`Extracted ${items.length} text item(s).`);

  const preview = items
    .slice(0, 10)
    .map((it, i) => {
      const n = String(i + 1).padStart(2);
      return `  ${n}. p${it.pageIndex} "${it.text}"  @ (${it.x.toFixed(1)}, ${it.y.toFixed(1)})`;
    })
    .join('\n');
  log(`First 10 items:\n${preview}`);
}

async function fetchPdfBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await loadDocument(bytes, file.name);
  } catch (err) {
    log(`Failed to load custom PDF: ${err.message}`, 'error');
  }
});

log(`PDF.js worker: ${pdfjsWorkerUrl}`);
log(`Anchor phrase default: "${anchorInput.value}"`);

(async () => {
  try {
    const bytes = await fetchPdfBytes(DEFAULT_PDF_URL);
    await loadDocument(bytes, 'protocol_not_signed_6333227.pdf');
  } catch (err) {
    log(`Failed to load default PDF: ${err.message}`, 'error');
  }
})();

initMobileSimulation({
  triggerButton: document.getElementById('simulate-mobile'),
  getCurrentPdfBytes: () => currentPdfBytes,
  getAnchorPhrase: () => anchorInput.value.trim(),
  log,
});

// Auto-open the mobile sim when the URL carries #mobile — useful for
// screenshots / headless checks. No-op in normal browsing.
if (window.location.hash === '#mobile') {
  document.getElementById('simulate-mobile').click();
}
