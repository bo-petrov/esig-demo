import * as pdfjsLib from 'pdfjs-dist';
import { rgb } from 'pdf-lib';
import { initSignatureCapture } from './signatureCapture.js';
import { stampSignatureAtAnchor, highlightAnchorInPdf } from './stamper.js';

/**
 * Mount the mobile-workflow simulation. Builds a modal that overlays the
 * desktop demo and walks the user through the same flow a field worker
 * sees on a portrait-locked Samsung Galaxy XCover7: sign → view PDF →
 * confirm → stamp → upload → download.
 *
 * The production app is portrait-locked, so the 90° "landscape" signing
 * orientation is achieved by CSS-rotating the signing stage, not by
 * changing device orientation. The signature canvas sits inside a rotated
 * wrapper div; signatureCapture.js receives `rotation: 90` so pointer
 * events are un-rotated back into canvas-local space before drawing.
 */
export function initMobileSimulation({
  triggerButton,
  getCurrentPdfBytes,
  getAnchorPhrase,
  log,
}) {
  const overlay = document.createElement('div');
  overlay.className = 'mobile-sim-overlay hidden';
  overlay.innerHTML = `
    <button class="mobile-sim-close" type="button" aria-label="Exit simulation">✕</button>
    <div class="mobile-sim-hint">Simulated portrait-locked Android — CSS-rotated signing stage</div>

    <div class="phone-frame">
      <div class="phone-notch"></div>
      <div class="phone-screen">

        <section class="mobile-state" data-state="signature-pad">
          <div class="rotated-stage">
            <div class="rotated-canvas-wrap">
              <canvas class="mobile-sig-canvas"></canvas>
              <div class="rotated-placeholder">Подпис на получател</div>
            </div>
            <div class="rotated-controls">
              <button type="button" class="mobile-btn mobile-btn-ghost" data-action="view-pdf">Виж PDF</button>
              <button type="button" class="mobile-btn mobile-btn-ghost" data-action="clear">Изчисти</button>
              <button type="button" class="mobile-btn mobile-btn-success" data-action="confirm" aria-label="Confirm">✓</button>
            </div>
          </div>
        </section>

        <section class="mobile-state" data-state="pdf-view">
          <div class="mobile-pdf-scroller">
            <div class="mobile-pdf-container"></div>
          </div>
          <button type="button" class="mobile-floating-back" data-action="back-to-sig">← Назад към подписа</button>
        </section>

        <section class="mobile-state mobile-state-center" data-state="spinner">
          <div class="mobile-spinner"></div>
          <div class="mobile-spinner-label"></div>
        </section>

        <section class="mobile-state mobile-state-center" data-state="success">
          <div class="mobile-success-check">✓</div>
          <div class="mobile-success-text">Готово! Документът е<br/>подписан и запазен.</div>
          <div class="mobile-success-buttons">
            <button type="button" class="mobile-btn mobile-btn-primary" data-action="download">Изтегли PDF</button>
            <button type="button" class="mobile-btn mobile-btn-ghost" data-action="close">Затвори</button>
          </div>
        </section>

      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector('.mobile-sig-canvas');
  const placeholder = overlay.querySelector('.rotated-placeholder');
  const pdfContainer = overlay.querySelector('.mobile-pdf-container');
  const spinnerLabel = overlay.querySelector('.mobile-spinner-label');

  const states = {};
  for (const el of overlay.querySelectorAll('.mobile-state')) {
    states[el.dataset.state] = el;
  }

  let signature = null;
  let signedBytes = null;
  let initialized = false;

  function setState(name) {
    for (const [key, el] of Object.entries(states)) {
      el.classList.toggle('active', key === name);
    }
  }

  function ensureSignatureInitialized() {
    if (initialized) return;
    signature = initSignatureCapture({
      canvas,
      clearButton: null,
      log: () => {}, // don't pollute the desktop log with every stroke
      rotation: 90,
    });
    signature.signaturePad.addEventListener('beginStroke', () => {
      placeholder.classList.add('hidden');
    });
    initialized = true;
  }

  function openSim() {
    overlay.classList.remove('hidden');
    setState('signature-pad');
    // Init AFTER the overlay is visible so the canvas has real layout
    // dimensions (offsetWidth/Height). Delayed to next frame to let the
    // transition settle before devicePixelRatio math runs.
    requestAnimationFrame(() => {
      ensureSignatureInitialized();
      // If re-opening, show/hide the placeholder based on current state.
      placeholder.classList.toggle('hidden', !signature.isEmpty());
    });
  }

  function closeSim() {
    overlay.classList.add('hidden');
  }

  async function showPdfView() {
    const pdfBytes = getCurrentPdfBytes();
    const phrase = getAnchorPhrase();
    if (!pdfBytes) {
      log('Mobile: no PDF loaded yet.', 'warn');
      return;
    }
    try {
      const result = await highlightAnchorInPdf({
        pdfBytes,
        anchorPhrase: phrase,
        color: rgb(0.16, 0.4, 1),
        opacity: 0.25,
      });
      await renderPdfFit(result.pdfBytes);
      setState('pdf-view');
    } catch (err) {
      log(`Mobile view PDF failed: ${err.message}`, 'error');
    }
  }

  async function renderPdfFit(pdfBytes) {
    pdfContainer.innerHTML = '';
    const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
    // Compute the target width from the scroller's inner width the FIRST
    // frame it is visible; fallback to 340 if not yet laid out.
    const targetWidth =
      pdfContainer.parentElement.clientWidth ||
      pdfContainer.clientWidth ||
      340;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const unit = page.getViewport({ scale: 1 });
      const scale = targetWidth / unit.width;
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.className = 'mobile-pdf-page';
      c.width = vp.width;
      c.height = vp.height;
      pdfContainer.appendChild(c);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp })
        .promise;
    }
  }

  async function runConfirmFlow() {
    if (!signature || signature.isEmpty()) {
      log('Mobile: signature is empty — tap somewhere to draw first.', 'warn');
      return;
    }
    const pdfBytes = getCurrentPdfBytes();
    if (!pdfBytes) {
      log('Mobile: no PDF loaded yet.', 'warn');
      return;
    }
    const phrase = getAnchorPhrase();
    const sigB64 = signature.getSignatureBase64();

    spinnerLabel.textContent = 'Подписване…';
    setState('spinner');
    log('Mobile flow: stamping…');

    let result;
    try {
      const [stamped] = await Promise.all([
        stampSignatureAtAnchor({
          pdfBytes,
          signatureBase64: sigB64,
          anchorPhrase: phrase,
          signatureSize: { width: 160, height: 50 },
          placement: { type: 'right-and-up', offsetX: 8, offsetY: 2 },
        }),
        new Promise((r) => setTimeout(r, 800)),
      ]);
      result = stamped;
    } catch (err) {
      log(`Mobile stamp failed: ${err.message}`, 'error');
      setState('signature-pad');
      return;
    }

    signedBytes = result.pdfBytes;
    log(`Mobile flow: stamped at (${result.placedAt.x.toFixed(1)}, ${result.placedAt.y.toFixed(1)})`);

    spinnerLabel.textContent = 'Качване към ERP…';
    await new Promise((r) => setTimeout(r, 1500));
    log('Mobile flow: upload simulated.');

    setState('success');
  }

  function triggerDownload() {
    if (!signedBytes) return;
    const blob = new Blob([signedBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'signed-document.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log('Mobile: downloaded signed-document.pdf');
  }

  // Delegated click handling.
  overlay.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'clear') {
      signature?.clear();
      placeholder.classList.remove('hidden');
    } else if (action === 'view-pdf') {
      showPdfView();
    } else if (action === 'back-to-sig') {
      setState('signature-pad');
    } else if (action === 'confirm') {
      runConfirmFlow();
    } else if (action === 'download') {
      triggerDownload();
    } else if (action === 'close') {
      closeSim();
    }
  });

  overlay.querySelector('.mobile-sim-close').addEventListener('click', closeSim);

  // Esc closes the modal.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !overlay.classList.contains('hidden')) {
      closeSim();
    }
  });

  triggerButton.addEventListener('click', openSim);
}
