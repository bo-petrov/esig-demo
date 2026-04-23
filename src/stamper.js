import { PDFDocument, rgb } from 'pdf-lib';
import { extractTextWithPositions, findAnchor } from './anchorSearch.js';

/**
 * Given an anchor (bottom-origin baseline-left of matched text with width/height)
 * and a signature box, compute the signature's bottom-left placement in
 * PDF-native bottom-origin coordinates.
 *
 * strategy.type:
 *   'right-of'          sig right of anchor, vertically centred on the text
 *   'right-and-up'      sig right of anchor, bottom sitting at the baseline
 *   'below'             sig below the baseline, left-aligned with the anchor
 *   'above'             sig above the cap line, left-aligned with the anchor
 *   'absolute-x-below'  sig below the baseline, caller sets X via offsetX
 *
 * All strategies accept offsetX / offsetY for fine-tuning.
 */
export function computePlacement(anchor, signatureBox, strategy) {
  const { type, offsetX = 0, offsetY = 0 } = strategy;
  let x;
  let y;

  switch (type) {
    case 'right-of':
      x = anchor.x + anchor.width + offsetX;
      y = anchor.y + anchor.height / 2 - signatureBox.height / 2 + offsetY;
      break;

    case 'right-and-up':
      // Plant the signature's bottom-left at (end-of-anchor, baseline) and
      // let it rise upward from there. A real handwritten signature is
      // almost entirely above the baseline — ink lives where ascenders
      // live, not centred on the line — so pinning the sig's bottom to the
      // text baseline produces the same visual composition you get when
      // someone signs next to a printed label on paper.
      x = anchor.x + anchor.width + offsetX;
      y = anchor.y + offsetY;
      break;

    case 'below':
      x = anchor.x + offsetX;
      y = anchor.y - signatureBox.height + offsetY;
      break;

    case 'above':
      x = anchor.x + offsetX;
      y = anchor.y + anchor.height + offsetY;
      break;

    case 'absolute-x-below':
      x = offsetX;
      y = anchor.y - signatureBox.height + offsetY;
      break;

    default:
      throw new Error(`Unknown placement strategy: "${type}"`);
  }

  return {
    pageIndex: anchor.pageIndex,
    x,
    y,
    width: signatureBox.width,
    height: signatureBox.height,
  };
}

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Full pipeline: extract text → find anchor → compute placement →
 * embed PNG → draw onto the page → save. Returns signed bytes + metadata.
 */
export async function stampSignatureAtAnchor({
  pdfBytes,
  signatureBase64,
  anchorPhrase,
  signatureSize,
  placement,
  searchOptions = {},
}) {
  if (!pdfBytes) throw new Error('pdfBytes is required.');
  if (!signatureBase64) {
    throw new Error('Signature is empty — draw a signature before stamping.');
  }
  if (!anchorPhrase) throw new Error('anchorPhrase is required.');
  if (!signatureSize || !signatureSize.width || !signatureSize.height) {
    throw new Error('signatureSize must include width and height (PDF points).');
  }
  if (!placement || !placement.type) {
    throw new Error('placement.type is required (e.g. "right-and-up").');
  }

  const items = await extractTextWithPositions(pdfBytes.slice());
  const anchor = findAnchor(items, anchorPhrase, searchOptions);
  if (!anchor) {
    throw new Error(`Anchor phrase not found: "${anchorPhrase}"`);
  }

  const placedAt = computePlacement(anchor, signatureSize, placement);

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes.slice());
  } catch (err) {
    throw new Error(`pdf-lib failed to parse the PDF: ${err.message}`);
  }

  const pngImage = await pdfDoc.embedPng(base64ToUint8Array(signatureBase64));

  const pages = pdfDoc.getPages();
  const page = pages[placedAt.pageIndex];
  if (!page) {
    throw new Error(
      `Page ${placedAt.pageIndex} out of range (document has ${pages.length}).`
    );
  }

  page.drawImage(pngImage, {
    x: placedAt.x,
    y: placedAt.y,
    width: placedAt.width,
    height: placedAt.height,
  });

  const outBytes = await pdfDoc.save();
  return {
    pdfBytes: outBytes,
    placedAt,
    matchedText: anchor.matchedText,
  };
}

/**
 * Debug aid: draw a translucent red rectangle over the anchor's bounding
 * box so we can see what findAnchor actually matched. If the stamp ever
 * lands wrong, this is how we tell whether the bug is in the search or in
 * the placement math.
 */
export async function highlightAnchorInPdf({
  pdfBytes,
  anchorPhrase,
  searchOptions = {},
  color = rgb(1, 0, 0),
  opacity = 0.3,
  borderColor,
  borderWidth = 0.5,
}) {
  if (!pdfBytes) throw new Error('pdfBytes is required.');
  if (!anchorPhrase) throw new Error('anchorPhrase is required.');

  const items = await extractTextWithPositions(pdfBytes.slice());
  const anchor = findAnchor(items, anchorPhrase, searchOptions);
  if (!anchor) {
    throw new Error(`Anchor phrase not found: "${anchorPhrase}"`);
  }

  const pdfDoc = await PDFDocument.load(pdfBytes.slice());
  const pages = pdfDoc.getPages();
  const page = pages[anchor.pageIndex];
  if (!page) {
    throw new Error(`Page ${anchor.pageIndex} out of range.`);
  }

  const PAD = 2;
  page.drawRectangle({
    x: anchor.x - PAD,
    y: anchor.y - PAD,
    width: anchor.width + PAD * 2,
    height: anchor.height + PAD * 2,
    color,
    opacity,
    borderColor: borderColor ?? color,
    borderOpacity: Math.min(1, opacity + 0.5),
    borderWidth,
  });

  const outBytes = await pdfDoc.save();
  return { pdfBytes: outBytes, anchor };
}
