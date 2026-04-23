import SignaturePad from 'signature_pad';

/**
 * Wire up signature capture on a canvas element.
 *
 * Options:
 *   canvas       — HTMLCanvasElement
 *   clearButton  — optional button that clears the pad on click
 *   log          — log function (message) => void
 *   rotation     — 0 | 90 | 180 | 270. Set to 90 when the canvas (or any
 *                  ancestor) is rotated via CSS `transform: rotate(…)`.
 *                  See note below — a monkey-patch un-rotates pointer
 *                  coords so strokes land under the finger.
 *
 * Returns:
 *   { signaturePad, getSignatureBase64, clear, isEmpty }
 */
export function initSignatureCapture({
  canvas,
  clearButton,
  log,
  rotation = 0,
}) {
  // Rugged Android target: disable browser gesture capture on the canvas so
  // pinch-zoom / pull-to-refresh / swipe-back don't steal pointer events
  // mid-stroke. touch-action:none must be set on the element itself; CSS
  // alone is brittle across vendor WebViews.
  canvas.style.touchAction = 'none';

  // Tuning for rugged handhelds and gloved input:
  //   minWidth 1.0 / maxWidth 2.8 — a heavier stroke than the library
  //     defaults so signatures drawn through a glove (lower contact
  //     pressure, noisier signal) remain legible without looking scratchy.
  //   velocityFilterWeight 0.7 — stronger smoothing to absorb the jittery
  //     pointer stream produced by capacitive-through-glove contact.
  //   minDistance 2 — drops near-duplicate samples that rugged digitizers
  //     emit on slow drags, which otherwise produce visible curve artifacts.
  const signaturePad = new SignaturePad(canvas, {
    penColor: '#00008b',
    backgroundColor: 'rgb(255, 255, 255)',
    minWidth: 1.0,
    maxWidth: 2.8,
    velocityFilterWeight: 0.7,
    minDistance: 2,
  });

  // When the canvas is rotated (either directly or through an ancestor with
  // `transform: rotate(…)`), `getBoundingClientRect()` returns the ROTATED
  // visual bbox. signature_pad does `clientX - rect.left` to get a point in
  // the canvas's internal (unrotated) coord system — those two spaces
  // disagree, and strokes land 90° away from the finger.
  //
  // Fix: wrap `_createPoint` so it un-rotates the viewport coordinate into
  // canvas-local space, then feeds the corrected point back through the
  // original code path by injecting synthetic clientX/Y values. The rest of
  // the pipeline (DPR scaling, curve fitting, toDataURL) stays untouched.
  if (rotation % 360 !== 0) {
    const origCreatePoint = signaturePad._createPoint.bind(signaturePad);
    signaturePad._createPoint = function (clientX, clientY, pressure) {
      const rect = canvas.getBoundingClientRect();
      const dx = clientX - rect.left;
      const dy = clientY - rect.top;
      const W = canvas.offsetWidth;
      const H = canvas.offsetHeight;
      let cx;
      let cy;
      switch (((rotation % 360) + 360) % 360) {
        case 90:
          // Pre-rotation top edge becomes post-rotation right edge.
          cx = dy;
          cy = H - dx;
          break;
        case 180:
          cx = W - dx;
          cy = H - dy;
          break;
        case 270:
          cx = W - dy;
          cy = dx;
          break;
        default:
          cx = dx;
          cy = dy;
      }
      // Re-enter the original method with clientX/Y chosen so its
      // `x - rect.left / y - rect.top` subtraction reproduces (cx, cy).
      return origCreatePoint(rect.left + cx, rect.top + cy, pressure);
    };
  }

  // devicePixelRatio handling: match the backing store to the physical
  // pixel grid so strokes stay crisp on HiDPI screens. Re-applied on
  // resize; completed strokes are preserved via toData/fromData.
  function resizeCanvas() {
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const data = signaturePad.toData();

    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d').scale(ratio, ratio);

    // Re-render existing strokes at the new scale. fromData clears first,
    // so empty data simply resets the background without discarding work.
    signaturePad.fromData(data);
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  signaturePad.addEventListener('endStroke', () => {
    log('Signature captured');
  });

  if (clearButton) {
    clearButton.addEventListener('click', () => {
      signaturePad.clear();
      log('Signature pad cleared.');
    });
  }

  function getSignatureBase64() {
    if (signaturePad.isEmpty()) return null;
    const dataUrl = signaturePad.toDataURL('image/png');
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  }

  return {
    signaturePad,
    getSignatureBase64,
    clear: () => signaturePad.clear(),
    isEmpty: () => signaturePad.isEmpty(),
  };
}
