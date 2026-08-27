const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, PageNumber,
  Footer, PageBreak,
} = require('docx');

const FONT = 'Times New Roman';
const BODY = 20;      // 10pt
const PAGE_W = 12240, PAGE_H = 15840, MARGIN = 1080;
const TABLE_W = PAGE_W - 2 * MARGIN;   // 10080
const COL = TABLE_W / 2;               // 5040

// --- inline **bold** parser -------------------------------------------------
function runs(text, o = {}) {
  return text.split('**').map((chunk, i) =>
    new TextRun({ text: chunk, bold: i % 2 === 1 || !!o.bold, italics: !!o.italics,
                  font: FONT, size: o.size || BODY }));
}
function P(text, o = {}) {
  return new Paragraph({
    children: runs(text, o),
    alignment: o.align || AlignmentType.JUSTIFIED,
    spacing: { after: o.after === undefined ? 90 : o.after, line: 250 },
    indent: o.indent ? { left: o.indent, hanging: o.hanging || 0 } : undefined,
  });
}
const H = (t) => P(t, { bold: true, align: AlignmentType.LEFT, after: 120 });
const LI = (t) => P(t, { indent: 340, hanging: 170 });

// --- bilingual clause table -------------------------------------------------
const B = { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' };
const CELL_BORDERS = { top: B, bottom: B, left: B, right: B };

function cell(paras, shade) {
  return new TableCell({
    width: { size: COL, type: WidthType.DXA },
    margins: { top: 90, bottom: 90, left: 130, right: 130 },
    borders: CELL_BORDERS,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: 'auto' } : undefined,
    children: paras,
  });
}

function clauseTable(sections) {
  const rows = [
    new TableRow({
      tableHeader: true,
      children: [
        cell([P('ENGLISH', { bold: true, align: AlignmentType.CENTER, after: 0 })], 'E8E8E8'),
        cell([P('ESPAÑOL', { bold: true, align: AlignmentType.CENTER, after: 0 })], 'E8E8E8'),
      ],
    }),
  ];
  for (const s of sections) {
    rows.push(new TableRow({
      cantSplit: false,
      children: [
        cell([H(s.t), ...s.en.map(toPara)]),
        cell([H(s.te), ...s.es.map(toPara)]),
      ],
    }));
  }
  return new Table({
    width: { size: TABLE_W, type: WidthType.DXA },
    columnWidths: [COL, COL],
    borders: CELL_BORDERS,
    rows,
  });
}
// a line starting with "- " renders as a hanging-indent item
function toPara(line) {
  return line.startsWith('- ') ? LI(line.slice(2)) : P(line);
}
module.exports = { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, PageNumber, Footer, PageBreak,
  FONT, BODY, PAGE_W, PAGE_H, MARGIN, TABLE_W, COL, P, H, LI, runs, cell, clauseTable, CELL_BORDERS };
