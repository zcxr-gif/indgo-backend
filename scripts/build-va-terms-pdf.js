/* =========================================================================
 * Regenerate VA-Advertisement-Terms.pdf from the structured Terms source.
 *
 * Usage:  node scripts/build-va-terms-pdf.js
 *
 * The Terms text lives in vaTermsContent.js (the single source shared with the
 * public /terms page). This script renders that content to the signed PDF that
 * is attached to partnership tickets and offered for download in the portal.
 *
 * pdfkit is only needed to BUILD the PDF, not to run the app, so it is a
 * dev-time dependency. If it is not installed, run: npm install --no-save pdfkit
 * ========================================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

let PDFDocument;
try {
    PDFDocument = require('pdfkit');
} catch (err) {
    console.error('pdfkit is required to build the Terms PDF. Install it with:\n  npm install --no-save pdfkit');
    process.exit(1);
}

const terms = require('../vaTermsContent');

const OUT = path.join(__dirname, '..', 'VA-Advertisement-Terms.pdf');

const INK = '#111827';
const MUTED = '#4b5563';
const ACCENT = '#2563eb';
const RULE = '#e5e7eb';

const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 64, bottom: 64, left: 64, right: 64 },
    info: {
        Title: `${terms.TITLE} — ${terms.SUBTITLE}`,
        Author: 'Inflight',
        Subject: `VA Advertisement Program Terms & Conditions (${terms.VERSION})`,
    },
});

doc.pipe(fs.createWriteStream(OUT));

// ---- Header -------------------------------------------------------------
doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(terms.TITLE, { align: 'left' });
doc.moveDown(0.15);
doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(14).text(terms.SUBTITLE);
doc.moveDown(0.4);
doc.fillColor(MUTED).font('Helvetica').fontSize(9)
    .text(`Version ${terms.VERSION}  •  Effective ${terms.EFFECTIVE_DATE}`);
doc.moveDown(0.5);

// Divider rule.
const ruleY = doc.y;
doc.moveTo(doc.page.margins.left, ruleY).lineTo(doc.page.width - doc.page.margins.right, ruleY)
    .strokeColor(RULE).lineWidth(1).stroke();
doc.moveDown(0.8);

// ---- Intro --------------------------------------------------------------
doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(terms.INTRO, { align: 'justify', lineGap: 2 });
doc.moveDown(0.8);

// ---- Clauses ------------------------------------------------------------
for (const clause of terms.CLAUSES) {
    // Keep a heading from being orphaned at the very bottom of a page.
    if (doc.y > doc.page.height - doc.page.margins.bottom - 70) doc.addPage();

    const left = doc.page.margins.left;
    doc.x = left;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11.5).text(clause.heading, left, doc.y);
    doc.moveDown(0.25);

    for (const block of clause.blocks) {
        if (block.p) {
            doc.x = left;
            doc.fillColor(MUTED).font('Helvetica').fontSize(10)
                .text(block.p, left, doc.y, { align: 'justify', lineGap: 2 });
            doc.moveDown(0.35);
        } else if (Array.isArray(block.list)) {
            for (const item of block.list) {
                const startY = doc.y;
                doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(10)
                    .text('•', left + 6, startY, { lineBreak: false });
                doc.fillColor(MUTED).font('Helvetica').fontSize(10)
                    .text(item, left + 20, startY, {
                        width: doc.page.width - doc.page.margins.right - (left + 20),
                        align: 'left',
                        lineGap: 2,
                    });
                doc.moveDown(0.3);
            }
            doc.moveDown(0.15);
        }
    }
    // Reset the horizontal cursor so the next heading is never left indented by
    // the preceding bullet list.
    doc.x = left;
    doc.moveDown(0.4);
}

// ---- Footer on every page ----------------------------------------------
const range = doc.bufferedPageRange && doc.bufferedPageRange();
// (Buffered pages aren't enabled; draw a simple closing line instead.)
doc.moveDown(0.6);
const closeY = doc.y;
if (closeY < doc.page.height - doc.page.margins.bottom - 30) {
    doc.moveTo(doc.page.margins.left, closeY).lineTo(doc.page.width - doc.page.margins.right, closeY)
        .strokeColor(RULE).lineWidth(1).stroke();
    doc.moveDown(0.5);
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.5)
        .text(`Inflight VA Advertisement Program — Terms & Conditions ${terms.VERSION}. Effective ${terms.EFFECTIVE_DATE}.`, { align: 'center' });
}

doc.end();

doc.on && doc.on('end', () => {});
console.log(`Building ${path.relative(process.cwd(), OUT)} …`);
