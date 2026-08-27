const G = require('./gen.js');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
  ShadingType, AlignmentType, BorderStyle, PageNumber, Footer, PageBreak,
  FONT, PAGE_W, PAGE_H, MARGIN, TABLE_W, COL, P, H, cell, clauseTable, CELL_BORDERS,
} = G;

const VARIANT = process.argv[3] === 'short' ? 'short' : 'full';
const SECTIONS = VARIANT === 'short'
  ? require('./sections-short.js')
  : [...require('./sections.js'), ...require('./sections2.js')];
const REF = VARIANT === 'short'
  ? { lang: '10.6', vol: '6.2', claims: '7' }
  : { lang: '17.9', vol: '7.2', claims: '8' };

const title = (t, size, after) => new Paragraph({
  children: [new TextRun({ text: t, bold: true, font: FONT, size })],
  alignment: AlignmentType.CENTER, spacing: { after },
});

// ---------- signature block -------------------------------------------------
const NB = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NB, bottom: NB, left: NB, right: NB };
const LINE = (label) => [
  P('____________________________________________', { align: AlignmentType.LEFT, after: 20 }),
  P(label, { align: AlignmentType.LEFT, after: 200 }),
];
function sigCell(heading, lines) {
  return new TableCell({
    width: { size: COL, type: WidthType.DXA }, borders: NO_BORDERS,
    margins: { top: 60, bottom: 60, left: 0, right: 200 },
    children: [P(heading, { bold: true, align: AlignmentType.LEFT, after: 200 }), ...lines],
  });
}
const sigLines = () => [
  ...LINE('Signature / Firma'),
  ...LINE('Print name / Aclaración'),
  ...LINE('Title / Cargo'),
  ...LINE('Date / Fecha'),
];
const signatureBlock = new Table({
  width: { size: TABLE_W, type: WidthType.DXA },
  columnWidths: [COL, COL], borders: NO_BORDERS,
  rows: [new TableRow({ children: [
    sigCell('BROKER — INVICTUS BROKERAGE LLC', sigLines()),
    sigCell('CARRIER — ____________________________', sigLines()),
  ]})],
});

// ---------- Exhibit A: fee schedule ----------------------------------------
const c3 = TABLE_W / 3;
function gridRow(cells, shade, bold) {
  return new TableRow({ children: cells.map((txt) => new TableCell({
    width: { size: c3, type: WidthType.DXA },
    margins: { top: 90, bottom: 90, left: 130, right: 130 },
    borders: CELL_BORDERS,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: 'auto' } : undefined,
    children: [P(txt, { bold, align: AlignmentType.LEFT, after: 0 })],
  }))});
}
const exhibitA = new Table({
  width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: [c3, c3, c3], borders: CELL_BORDERS,
  rows: [
    gridRow(['Shipment volume (CF)', 'Volumen del embarque (CF)', 'Broker Fee / Comisión'], 'E8E8E8', true),
    gridRow(['Less than 500 CF', 'Menos de 500 CF', 'US$100.00 per Job / por Job']),
    gridRow(['500 CF to 1,000 CF (inclusive)', 'De 500 CF a 1.000 CF (inclusive)', 'US$150.00 per Job / por Job']),
    gridRow(['More than 1,000 CF', 'Más de 1.000 CF', 'US$200.00 per Job / por Job']),
    gridRow(['Additional Charges above the original balance', 'Cargos Adicionales por encima del balance original', '10% of the amount collected / del importe cobrado']),
    gridRow(['Onboarding Fee (one time)', 'Cuota de Incorporación (única vez)', 'US$5,000.00 — 2 x US$2,500.00 — non-refundable / no reembolsable']),
  ],
});

// ---------- Exhibit B: contacts --------------------------------------------
const half = TABLE_W / 2;
function contactRow(label, shade, bold) {
  return new TableRow({ children: [
    new TableCell({ width: { size: half, type: WidthType.DXA }, borders: CELL_BORDERS,
      margins: { top: 90, bottom: 90, left: 130, right: 130 },
      shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: 'auto' } : undefined,
      children: [P(label[0], { bold, align: AlignmentType.LEFT, after: 0 })] }),
    new TableCell({ width: { size: half, type: WidthType.DXA }, borders: CELL_BORDERS,
      margins: { top: 90, bottom: 90, left: 130, right: 130 },
      shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: 'auto' } : undefined,
      children: [P(label[1], { bold, align: AlignmentType.LEFT, after: 0 })] }),
  ]});
}
const exhibitB = new Table({
  width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: [half, half], borders: CELL_BORDERS,
  rows: [
    contactRow(['BROKER — Invictus Brokerage LLC', 'CARRIER — ____________________________'], 'E8E8E8', true),
    contactRow(['Notice address / Domicilio de notificaciones: [ADDRESS]', 'Notice address / Domicilio de notificaciones: __________________']),
    contactRow(['Email: [EMAIL]', 'Email: __________________']),
    contactRow(['Phone / Teléfono: [PHONE]', 'Phone / Teléfono: __________________']),
    contactRow(['Dispatch contact / Contacto de dispatch: [NAME]', 'Dispatch contact / Contacto de dispatch: __________________']),
    contactRow(['Dispatch email / SMS: [EMAIL / NUMBER]', 'Dispatch email / SMS: __________________']),
    contactRow(['Claims contact / Contacto de claims: n/a — see Section 8', 'Claims contact / Contacto de claims: __________________']),
  ],
});

// ---------- document --------------------------------------------------------
const footer = new Footer({ children: [new Paragraph({
  alignment: AlignmentType.CENTER,
  children: [new TextRun({ text: 'Broker–Carrier Agreement — Invictus Brokerage LLC — Page ', font: FONT, size: 16 }),
             new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16 }),
             new TextRun({ text: ' of ', font: FONT, size: 16 }),
             new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 16 })],
})]});

const doc = new Document({
  creator: 'Invictus Brokerage LLC',
  title: 'Broker–Carrier Agreement / Contrato entre Broker y Carrier',
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
    footers: { default: footer },
    children: [
      title('BROKER–CARRIER AGREEMENT', 30, 60),
      title('CONTRATO ENTRE BROKER Y CARRIER', 26, 140),
      title('INVICTUS BROKERAGE LLC', 22, VARIANT === 'short' ? 60 : 220),
      ...(VARIANT === 'short' ? [title('SHORT FORM / VERSIÓN ABREVIADA', 19, 220)] : []),
      P(`This Agreement is presented in English and Spanish in parallel columns. Both columns form part of a single agreement; in the event of any discrepancy, the English column governs (Section ${REF.lang}).`, { align: AlignmentType.CENTER, after: 60, italics: true }),
      P(`Este Contrato se presenta en inglés y español en columnas paralelas. Ambas columnas integran un único contrato; en caso de discrepancia, prevalece la columna en inglés (Cláusula ${REF.lang}).`, { align: AlignmentType.CENTER, after: 240, italics: true }),
      clauseTable(SECTIONS),
      new Paragraph({ children: [new PageBreak()] }),
      title('SIGNATURES / FIRMAS', 24, 160),
      P('IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date. Each signatory represents that they are duly authorized to bind their respective Party.', { after: 60 }),
      P('EN PRUEBA DE CONFORMIDAD, las Partes suscriben este Contrato en la Fecha de Vigencia. Cada firmante declara encontrarse debidamente facultado para obligar a su respectiva Parte.', { after: 300 }),
      signatureBlock,
      new Paragraph({ children: [new PageBreak()] }),
      title('EXHIBIT A — FEE SCHEDULE / ANEXO A — ESQUEMA DE COMISIONES', 22, 160),
      exhibitA,
      P('', { after: 120 }),
      P(`Volume is taken from the signed bill of lading and inventory at loading; actual loaded volume controls where it exceeds the estimate (Section ${REF.vol}). / El volumen se toma del bill of lading firmado y del inventario al momento de la carga; prevalece el volumen efectivamente cargado cuando supera el estimado (Cláusula ${REF.vol}).`, { italics: true, after: 400 }),
      title('EXHIBIT B — NOTICE AND DISPATCH CONTACTS / ANEXO B — CONTACTOS DE NOTIFICACIÓN Y DISPATCH', 22, 160),
      exhibitB,
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  require('fs').writeFileSync(process.argv[2] || 'Invictus-Broker-Carrier-Agreement.docx', buf);
  console.log('written:', process.argv[2]);
});
