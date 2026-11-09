// Split a results-table PDF into tab-separated rows, using macOS PDFKit (no installs).
//
//   osascript -l JavaScript pdf_rows.js FILE.pdf "BRAND NAME|PRODUCT NAME|REGION|COUNTRY|MEDAL"
//
// The SFWSC results PDF centres each cell in its column and its text layer runs
// the columns together ("1792 Full Proof Straight Bourbon USA Double Gold"), so
// plain text extraction can't tell the brand from the region. Instead: find each
// header's centre, put the column edges at the midpoints between them, then for
// every text line ask PDFKit for the text inside each column's rectangle. Prints
// one line per row, cells joined by tabs, then the row's whole line of text as
// a last column — a long cell can spill past its column edge and get cut
// mid-word ("…Wheated Bour" | "bon Texas"), and ratings.py uses the whole line
// to put the word back together. Header rows and page titles are dropped.
ObjC.import('PDFKit');

function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) throw new Error('could not open ' + argv[0]);
  const headers = (argv[1] || 'BRAND NAME|PRODUCT NAME|REGION|COUNTRY|MEDAL').split('|');
  const clean = (s) => ObjC.unwrap(s || $('')).replace(/\s+/g, ' ').trim();
  let edges = null;
  const out = [];
  for (let p = 0; p < doc.pageCount; p++) {
    const page = doc.pageAtIndex(p);
    const box = page.boundsForBox(0);
    // Column centres from this page's header row (else keep the last page's).
    const centres = headers.map((h) => {
      const found = doc.findStringWithOptions(h, 0);
      for (let i = 0; i < found.count; i++) {
        const sel = found.objectAtIndex(i);
        if (sel.pages.objectAtIndex(0).isEqual(page)) {
          const b = sel.boundsForPage(page);
          return b.origin.x + b.size.width / 2;
        }
      }
      return null;
    });
    if (centres.every((c) => c !== null)) edges = centres.slice(1).map((c, i) => (centres[i] + c) / 2);
    if (!edges) continue;
    const xs = [box.origin.x, ...edges, box.origin.x + box.size.width];
    // PDFKit can hand one table row back as several line pieces; gather the
    // pieces of each row (same baseline) so the row's whole text is complete.
    const lines = page.selectionForRect(box).selectionsByLine;
    const rows = [];
    for (let i = 0; i < lines.count; i++) {
      const line = lines.objectAtIndex(i);
      const b = line.boundsForPage(page);
      const piece = { x: b.origin.x, s: clean(line.string) };
      const row = rows.find((r) => Math.abs(r.y - b.origin.y) < 0.5);
      if (row) row.pieces.push(piece);
      else rows.push({ y: b.origin.y, h: b.size.height, pieces: [piece] });
    }
    for (const row of rows) {
      const cells = [];
      for (let c = 0; c < headers.length; c++) {
        const r = $.NSMakeRect(xs[c], row.y + row.h * 0.25, xs[c + 1] - xs[c], row.h * 0.5);
        cells.push(clean(page.selectionForRect(r).string));
      }
      const joined = cells.join(' ').toUpperCase();
      if (headers.every((hd) => joined.includes(hd))) continue;       // a header row
      if (cells.filter(Boolean).length < 2) continue;                  // a page title
      const whole = row.pieces.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ');
      out.push(cells.concat([whole]).join('\t'));
    }
  }
  return out.join('\n');
}
