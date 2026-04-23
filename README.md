# E-Signature Demo

A minimal, fully client-side proof that we can:

1. Render a PDF in the browser with **PDF.js**.
2. Capture a hand-drawn signature with **signature_pad**.
3. Locate an anchor phrase (default: `Получил:`) inside the PDF and stamp the signature there with **pdf-lib**.
4. Export the signed PDF — no server round-trip.

The goal is to validate the approach end-to-end before committing to it in the main app.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL. The bundled sample PDF (`public/protocol_not_signed_6333227.pdf`) loads automatically. Use the file picker to try a custom PDF.

## Two modes

### Desktop demo (default)

Two-column layout — PDF preview on the left, signature pad + controls on the right. Useful for inspecting intermediate state: status/log panel, "Debug: Highlight Anchor" to see exactly where the anchor search lands, etc. This is the engineering view.

### Mobile workflow simulation

Click **📱 Simulate Mobile Workflow** above the desktop layout. A modal mocks up the production UX on a Samsung Galaxy XCover7 rugged Android device:

- The phone frame is **portrait and stays portrait** — the production app is portrait-locked, so rotating the physical device has no effect.
- The signing stage is **CSS-rotated 90° clockwise** (not a device orientation change) because a landscape signing area is more natural to draw on than a portrait one.
- Flow: `signature-pad` → `pdf-view` (with the anchor highlighted in blue) → `stamping` (real `stampSignatureAtAnchor` running) → `uploading` (simulated 1.5s) → `success` → `Download PDF`.

### On the rotated canvas

CSS `transform: rotate(…)` makes `Element.getBoundingClientRect()` return the rotated visual bbox, but signature_pad computes stroke coordinates as `clientX - rect.left` against the canvas's untransformed drawing buffer. Left alone, that puts strokes 90° away from the finger. `initSignatureCapture({ rotation: 90 })` installs a tiny monkey-patch on `_createPoint` that un-rotates viewport coords back into canvas-local space before the rest of the pipeline touches them. The wrapper-div layout (rotating an ancestor instead of the canvas itself) is about layout cleanliness, not pointer mapping — the coord fix is required either way.

## Project layout

```
esig-demo/
├── index.html                    # Shell, launcher button, and state-panel containers
├── src/
│   ├── main.js                   # Entry: PDF.js worker, render loop, button wiring
│   ├── signatureCapture.js       # signature_pad wrapper (DPR, rugged tuning, rotation fix)
│   ├── anchorSearch.js           # extractTextWithPositions + findAnchor
│   ├── stamper.js                # computePlacement + stampSignatureAtAnchor + highlightAnchorInPdf
│   ├── mobileSimulation.js       # Phone-frame modal + 5-state workflow machine
│   └── style.css                 # Desktop styles + mobile simulation styles
├── public/
│   └── protocol_not_signed_6333227.pdf   # Default PDF served at /<filename>
└── package.json
```

## Notes on the setup

- **PDF.js worker** is imported via Vite's `?url` pattern (`pdfjs-dist/build/pdf.worker.mjs?url`) and assigned to `pdfjsLib.GlobalWorkerOptions.workerSrc`. This avoids the fake-worker fallback and keeps rendering off the main thread.
- **Coordinate system.** `textItem.transform[5]` in this `pdfjs-dist` version is already PDF-native bottom-origin — the whole pipeline (`findAnchor`, `computePlacement`, `pdf-lib` drawImage/drawRectangle) stays in one coord system end-to-end. See the comment at the top of `src/anchorSearch.js`.
- **No build step** beyond `vite dev`. Nothing is pre-bundled or pre-signed; everything is exercised at runtime the way production would be.
