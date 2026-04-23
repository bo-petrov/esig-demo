import * as pdfjsLib from 'pdfjs-dist';

/**
 * Extract every text item from every page of a PDF, with positions expressed
 * in PDF-native bottom-origin coordinates (points from the bottom-left).
 *
 * pdfjs-dist returns `textItem.transform = [a, b, c, d, e, f]` where (e, f)
 * is the text baseline-left in PDF user space, which is already bottom-
 * origin. No Y flip is applied. (Verified against this project's sample:
 * the page title sits at y≈798 on an 842pt-tall page — near the top, as
 * expected in bottom-origin space.) Downstream code — findAnchor,
 * computePlacement, pdf-lib drawImage / drawRectangle — all consume
 * bottom-origin coords, so everything stays in one system end-to-end.
 *
 * Returns: Array<{ text, pageIndex, x, y, width, height, pageHeight }>
 */
export async function extractTextWithPositions(pdfBytes) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  const pdf = await loadingTask.promise;

  const items = [];

  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;
    const content = await page.getTextContent();

    for (const raw of content.items) {
      if (typeof raw.str !== 'string' || raw.str.length === 0) continue;

      const [, , , , tx, ty] = raw.transform;

      items.push({
        text: raw.str,
        pageIndex,
        x: tx,
        y: ty,
        width: raw.width,
        height: raw.height,
        pageHeight,
      });
    }
  }

  // Cyrillic encoding sanity check. Mis-decoded text (mojibake, bare CID
  // placeholders like "(cid:123)") is obvious at a glance in this dump —
  // call it out before any downstream step relies on the text.
  const sample = items.slice(0, 30).map((i) => i.text).join(' | ');
  console.log(
    '[anchorSearch] Extracted %d item(s) across %d page(s).',
    items.length,
    pdf.numPages
  );
  console.log('[anchorSearch] Sample (first 30 items): %s', sample);

  return items;
}

/**
 * Find the Nth occurrence of `phrase` in an items array produced by
 * extractTextWithPositions().
 *
 * Algorithm:
 *   1. Group items into visual lines by Y position (2pt tolerance).
 *   2. Sort each line's items by X, then reconstruct the line's string —
 *      inserting a single space between items whose positional gap exceeds
 *      1pt, because some PDFs encode word breaks by moving the text cursor
 *      instead of emitting an actual space character.
 *   3. indexOf the phrase in the reconstructed line string.
 *   4. Walk the items to find which one contains the match's start, then
 *      interpolate linearly within that item (by character index) to get
 *      the exact X coordinate of the match start.
 *
 * Options:
 *   caseSensitive  (default false)
 *   occurrence     (default 1) — 1-based; useful when a phrase repeats.
 *   pageIndex      (default null) — constrain to a single page.
 *
 * Returns: { pageIndex, x, y, width, height, pageHeight, matchedText } or null.
 *   (x, y) = baseline-left of the matched text; width/height = match extent.
 */
export function findAnchor(items, phrase, options = {}) {
  const {
    caseSensitive = false,
    occurrence = 1,
    pageIndex = null,
  } = options;

  if (!phrase || phrase.length === 0) return null;

  const normalize = caseSensitive
    ? (s) => s
    : (s) => s.toLocaleLowerCase();
  const needle = normalize(phrase);

  const Y_TOLERANCE = 2;
  const GAP_THRESHOLD = 1;

  const scoped =
    pageIndex == null ? items : items.filter((i) => i.pageIndex === pageIndex);

  const byPage = new Map();
  for (const item of scoped) {
    if (!byPage.has(item.pageIndex)) byPage.set(item.pageIndex, []);
    byPage.get(item.pageIndex).push(item);
  }

  let occurrencesSeen = 0;

  const sortedPages = [...byPage.keys()].sort((a, b) => a - b);
  for (const pIdx of sortedPages) {
    const pageItems = byPage.get(pIdx);
    const pageHeight = pageItems[0].pageHeight;

    // Bucket items into lines by Y proximity.
    const lines = [];
    for (const item of pageItems) {
      const line = lines.find((l) => Math.abs(l.y - item.y) <= Y_TOLERANCE);
      if (line) {
        line.items.push(item);
      } else {
        lines.push({ y: item.y, items: [item] });
      }
    }

    // Reading order: top of page first. In bottom-origin space, top = larger y.
    lines.sort((a, b) => b.y - a.y);

    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);

      // Reconstruct the line string while recording where each item's text
      // starts in that string — we need those offsets to back-map a match
      // position to the specific item that contains it.
      let lineStr = '';
      const itemStarts = [];
      let prev = null;
      for (const item of line.items) {
        if (prev) {
          const prevEnd = prev.x + prev.width;
          if (item.x > prevEnd + GAP_THRESHOLD) {
            lineStr += ' ';
          }
        }
        itemStarts.push({ start: lineStr.length, item });
        lineStr += item.text;
        prev = item;
      }

      const haystack = normalize(lineStr);
      let cursor = 0;
      while (true) {
        const idx = haystack.indexOf(needle, cursor);
        if (idx < 0) break;

        occurrencesSeen += 1;
        if (occurrencesSeen === occurrence) {
          // Walk every item that overlaps the match window and interpolate
          // the sub-item X extent linearly by character index. Works even
          // when a phrase spans multiple items on the same line.
          const matchEnd = idx + needle.length;
          let leftX = null;
          let rightX = null;

          for (const { start, item } of itemStarts) {
            const itemEnd = start + item.text.length;
            if (itemEnd <= idx || start >= matchEnd) continue;

            const itemLen = item.text.length;
            const overlapFrom = Math.max(idx, start) - start;
            const overlapTo = Math.min(matchEnd, itemEnd) - start;

            const x1 =
              itemLen > 0
                ? item.x + (overlapFrom / itemLen) * item.width
                : item.x;
            const x2 =
              itemLen > 0
                ? item.x + (overlapTo / itemLen) * item.width
                : item.x + item.width;

            if (leftX === null || x1 < leftX) leftX = x1;
            if (rightX === null || x2 > rightX) rightX = x2;
          }

          // Y/height come from the item containing the match start.
          let containing = itemStarts[0];
          for (let i = itemStarts.length - 1; i >= 0; i--) {
            if (itemStarts[i].start <= idx) {
              containing = itemStarts[i];
              break;
            }
          }

          return {
            pageIndex: pIdx,
            x: leftX,
            y: containing.item.y,
            width: rightX - leftX,
            height: containing.item.height,
            pageHeight,
            matchedText: lineStr.slice(idx, idx + needle.length),
          };
        }

        cursor = idx + Math.max(needle.length, 1);
      }
    }
  }

  return null;
}
