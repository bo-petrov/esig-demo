import * as pdfjsLib from 'pdfjs-dist';
import { rgb } from 'pdf-lib';
import { initSignatureCapture } from './signatureCapture.js';
import { stampSignatureAtAnchor, highlightAnchorInPdf } from './stamper.js';

/**
 * Mount the mobile-workflow simulation. Builds a modal that overlays the
 * desktop demo and walks the user through the same flow a field worker
 * sees on a portrait-locked Samsung Galaxy XCover7.
 *
 * Exposes `launch()`, which returns a Promise that resolves with a
 * structured response — mirroring the shape a production ERP integration
 * would get from an async handover callback:
 *
 *   { status: "signed",     pdfBytes, signedAt,    anchor }
 *   { status: "not_signed", pdfBytes, reason, cancelledAt }
 *
 * The phone frame is always portrait (device is portrait-locked). The
 * signing stage is CSS-rotated 90° CW for the landscape signing posture;
 * signatureCapture.js receives `rotation: 90` so pointer coords are
 * un-rotated back into canvas-local space.
 */
export function initMobileSimulation({ getCurrentPdfBytes, getAnchorPhrase, log }) {
  const overlay = document.createElement('div');
  overlay.className = 'mobile-sim-overlay hidden';
  overlay.innerHTML = `
    <button class="mobile-sim-close" type="button" data-action="request-close" aria-label="Exit simulation">✕</button>
    <div class="mobile-sim-hint">Simulated portrait-locked Android — CSS-rotated signing stage</div>

    <div class="phone-frame">
      <div class="phone-notch"></div>
      <div class="phone-screen">

        <section class="mobile-state" data-state="signature-pad">
          <div class="rotated-stage">
            <button type="button" class="rotated-close-btn" data-action="request-cancel" aria-label="Cancel and close">✕</button>
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
          <button type="button" class="mobile-pdf-close-btn" data-action="request-cancel" aria-label="Cancel and close">✕</button>
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
            <button type="button" class="mobile-btn mobile-btn-ghost" data-action="close-signed">Затвори</button>
          </div>
        </section>

        <div class="cancel-confirm-overlay" aria-hidden="true">
          <div class="cancel-confirm-card" role="dialog" aria-modal="true" aria-labelledby="cancel-confirm-title">
            <div class="cancel-confirm-title" id="cancel-confirm-title">Отказ на подписа?</div>
            <div class="cancel-confirm-body">Подписът няма да се запази. Сигурни ли сте?</div>
            <div class="cancel-confirm-actions">
              <button type="button" class="cancel-confirm-back" data-action="cancel-dismiss">Назад</button>
              <button type="button" class="cancel-confirm-cancel" data-action="cancel-confirm">Да, отказ</button>
            </div>
          </div>
        </div>

      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector('.mobile-sig-canvas');
  const placeholder = overlay.querySelector('.rotated-placeholder');
  const pdfContainer = overlay.querySelector('.mobile-pdf-container');
  const spinnerLabel = overlay.querySelector('.mobile-spinner-label');
  const confirmOverlay = overlay.querySelector('.cancel-confirm-overlay');
  const outerCloseBtn = overlay.querySelector('.mobile-sim-close');

  const states = {};
  for (const el of overlay.querySelectorAll('.mobile-state')) {
    states[el.dataset.state] = el;
  }

  // ----- Module state -----
  let signature = null;
  let signatureInitialized = false;
  let stampResult = null;        // last successful stamp output
  let pendingResolve = null;     // current launch() Promise resolver
  let currentState = null;

  function setState(name) {
    currentState = name;
    for (const [key, el] of Object.entries(states)) {
      el.classList.toggle('active', key === name);
    }
    // The outer ✕ is hidden while animations are playing — user can't
    // cancel a signing operation that's already committed.
    const hideOuter = name === 'spinner';
    outerCloseBtn.classList.toggle('hidden', hideOuter);
  }

  function ensureSignatureInitialized() {
    if (signatureInitialized) return;
    signature = initSignatureCapture({
      canvas,
      clearButton: null,
      log: () => {},
      rotation: 90,
    });
    signature.signaturePad.addEventListener('beginStroke', () => {
      placeholder.classList.add('hidden');
    });
    signatureInitialized = true;
  }

  // ----- Confirm dialog -----

  function showConfirmDialog() {
    confirmOverlay.classList.add('visible');
    confirmOverlay.setAttribute('aria-hidden', 'false');
  }

  function hideConfirmDialog() {
    confirmOverlay.classList.remove('visible');
    confirmOverlay.setAttribute('aria-hidden', 'true');
  }

  // ----- Promise resolution paths -----

  function resolveFlow(response) {
    if (!pendingResolve) return;
    const resolve = pendingResolve;
    pendingResolve = null;
    overlay.classList.add('hidden');
    hideConfirmDialog();
    resetFlowState();
    resolve(response);
  }

  function resetFlowState() {
    // Start next run fresh: clear strokes, reset stamp result, restore
    // placeholder, dismiss any mid-flight confirm dialog.
    if (signature) {
      signature.clear();
    }
    placeholder.classList.remove('hidden');
    stampResult = null;
    setState('signature-pad');
  }

  function buildSignedResponse() {
    const a = stampResult.anchor;
    return {
      status: 'signed',
      pdfBytes: new Uint8Array(stampResult.pdfBytes),
      signedAt: new Date().toISOString(),
      anchor: {
        matchedText: a.matchedText,
        pageIndex: a.pageIndex,
        x: a.x,
        y: a.y,
      },
    };
  }

  function buildNotSignedResponse(reason = 'user_cancelled') {
    const original = getCurrentPdfBytes();
    return {
      status: 'not_signed',
      pdfBytes: original ? new Uint8Array(original) : new Uint8Array(0),
      reason,
      cancelledAt: new Date().toISOString(),
    };
  }

  function performSignedClose() {
    resolveFlow(buildSignedResponse());
  }

  function performCancelClose() {
    resolveFlow(buildNotSignedResponse());
  }

  // ----- Cancel routing -----

  function requestCancel() {
    // Mid-animation: nothing to cancel.
    if (currentState === 'spinner') return;
    // From success: user tapped outer ✕ after signing — treat as signed close.
    if (currentState === 'success') {
      performSignedClose();
      return;
    }
    // From sig-pad or pdf-view: smart confirmation.
    if (!signature || signature.isEmpty()) {
      performCancelClose();
    } else {
      showConfirmDialog();
    }
  }

  // ----- Flows -----

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

    stampResult = result;
    log(
      `Mobile flow: stamped at (${result.placedAt.x.toFixed(1)}, ${result.placedAt.y.toFixed(1)})`
    );

    spinnerLabel.textContent = 'Качване към ERP…';
    await new Promise((r) => setTimeout(r, 1500));
    log('Mobile flow: upload simulated.');

    setState('success');
  }

  function triggerDownload() {
    if (!stampResult) return;
    const blob = new Blob([stampResult.pdfBytes], { type: 'application/pdf' });
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

  // ----- Event delegation -----

  overlay.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    switch (action) {
      case 'clear':
        signature?.clear();
        placeholder.classList.remove('hidden');
        break;
      case 'view-pdf':
        showPdfView();
        break;
      case 'back-to-sig':
        setState('signature-pad');
        break;
      case 'confirm':
        runConfirmFlow();
        break;
      case 'download':
        triggerDownload();
        break;
      case 'close-signed':
        performSignedClose();
        break;
      case 'request-cancel':
      case 'request-close':
        requestCancel();
        break;
      case 'cancel-dismiss':
        hideConfirmDialog();
        break;
      case 'cancel-confirm':
        performCancelClose();
        break;
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (overlay.classList.contains('hidden')) return;
    if (ev.key === 'Escape') {
      // Esc behaves like the outer ✕ — routes through the same logic.
      if (confirmOverlay.classList.contains('visible')) {
        hideConfirmDialog();
      } else {
        requestCancel();
      }
    }
  });

  // ----- Public API -----

  function launch() {
    if (pendingResolve) {
      return Promise.reject(
        new Error('Mobile simulation already active — resolve the current Promise first.')
      );
    }
    return new Promise((resolve) => {
      pendingResolve = resolve;
      overlay.classList.remove('hidden');
      setState('signature-pad');
      requestAnimationFrame(() => {
        ensureSignatureInitialized();
        placeholder.classList.toggle('hidden', !signature.isEmpty());
      });
    });
  }

  return { launch };
}
