const fs = require('fs');
const SECTIONS = [...require('./sections.js'), ...require('./sections2.js')];
const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const md = (s) => esc(s).split('**').map((c,i)=> i%2 ? '<strong>'+c+'</strong>' : c).join('');
const para = (l) => l.startsWith('- ')
  ? '<p class="li">'+md(l.slice(2))+'</p>'
  : '<p>'+md(l)+'</p>';

const rows = SECTIONS.map(s => `<tr>
<td><h3>${esc(s.t)}</h3>${s.en.map(para).join('')}</td>
<td><h3>${esc(s.te)}</h3>${s.es.map(para).join('')}</td>
</tr>`).join('\n');

const sigCol = (h) => `<td class="sig"><p class="sh"><strong>${h}</strong></p>
${['Signature / Firma','Print name / Aclaración','Title / Cargo','Date / Fecha']
  .map(l=>`<p class="line">____________________________________________</p><p class="lbl">${l}</p>`).join('')}</td>`;

const feeRows = [
 ['Shipment volume (CF)','Volumen del embarque (CF)','Broker Fee / Comisión',1],
 ['Less than 500 CF','Menos de 500 CF','US$100.00 per Job / por Job'],
 ['500 CF to 1,000 CF (inclusive)','De 500 CF a 1.000 CF (inclusive)','US$150.00 per Job / por Job'],
 ['More than 1,000 CF','Más de 1.000 CF','US$200.00 per Job / por Job'],
 ['Additional Charges above the original balance','Cargos Adicionales por encima del balance original','10% of the amount collected / del importe cobrado'],
 ['Onboarding Fee (one time)','Cuota de Incorporación (única vez)','US$5,000.00 — 2 x US$2,500.00 — non-refundable / no reembolsable'],
].map(r=>`<tr${r[3]?' class="hd"':''}>${r.slice(0,3).map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('');

const contactRows = [
 ['BROKER — Invictus Brokerage LLC','CARRIER — ____________________________',1],
 ['Notice address / Domicilio de notificaciones: [ADDRESS]','Notice address / Domicilio de notificaciones: __________________'],
 ['Email: [EMAIL]','Email: __________________'],
 ['Phone / Teléfono: [PHONE]','Phone / Teléfono: __________________'],
 ['Dispatch contact / Contacto de dispatch: [NAME]','Dispatch contact / Contacto de dispatch: __________________'],
 ['Dispatch email / SMS: [EMAIL / NUMBER]','Dispatch email / SMS: __________________'],
 ['Claims contact / Contacto de claims: n/a — see Section 8','Claims contact / Contacto de claims: __________________'],
].map(r=>`<tr${r[2]?' class="hd"':''}>${r.slice(0,2).map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Broker–Carrier Agreement — Invictus Brokerage LLC</title>
<style>
@page { size: Letter; margin: 0.75in; }
* { box-sizing: border-box; }
body { font-family: "Times New Roman", Times, serif; font-size: 10pt; line-height: 1.32; color:#000; margin:0; }
h1 { font-size: 15pt; text-align:center; margin:0 0 4pt; }
h2 { font-size: 13pt; text-align:center; margin:0 0 7pt; }
h2.co { font-size: 11pt; margin:0 0 11pt; letter-spacing:.06em; }
h3 { font-size: 10pt; margin:0 0 6pt; }
p { margin:0 0 4.5pt; text-align: justify; }
p.li { margin-left: 17pt; text-indent: -8.5pt; }
.note { text-align:center; font-style:italic; margin-bottom:3pt; }
table { width:100%; border-collapse: collapse; table-layout: fixed; }
table.clauses td, table.grid td { border:.5pt solid #aaa; padding:4.5pt 6.5pt; vertical-align: top; }
table.clauses th { border:.5pt solid #aaa; padding:4.5pt; background:#e8e8e8; font-size:10pt; }
table.grid tr.hd td { background:#e8e8e8; font-weight:bold; }
table.sigs { margin-top:14pt; }
table.sigs td { border:0; width:50%; padding-right:16pt; vertical-align: top; }
.sh { margin-bottom:11pt; }
.line { margin:0 0 1pt; } .lbl { margin:0 0 11pt; }
.pb { page-break-before: always; }
.sec-title { font-size:12pt; font-weight:bold; text-align:center; margin: 0 0 9pt; }
tr { page-break-inside: auto; }
table.grid tr, table.sigs tr { page-break-inside: avoid; }
</style></head><body>
<h1>BROKER–CARRIER AGREEMENT</h1>
<h2>CONTRATO ENTRE BROKER Y CARRIER</h2>
<h2 class="co">INVICTUS BROKERAGE LLC</h2>
<p class="note">This Agreement is presented in English and Spanish in parallel columns. Both columns form part of a single agreement; in the event of any discrepancy, the English column governs (Section 17.9).</p>
<p class="note" style="margin-bottom:11pt">Este Contrato se presenta en inglés y español en columnas paralelas. Ambas columnas integran un único contrato; en caso de discrepancia, prevalece la columna en inglés (Cláusula 17.9).</p>
<table class="clauses"><thead><tr><th>ENGLISH</th><th>ESPAÑOL</th></tr></thead><tbody>${rows}</tbody></table>
<div class="pb"></div>
<p class="sec-title">SIGNATURES / FIRMAS</p>
<p>IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date. Each signatory represents that they are duly authorized to bind their respective Party.</p>
<p style="margin-bottom:14pt">EN PRUEBA DE CONFORMIDAD, las Partes suscriben este Contrato en la Fecha de Vigencia. Cada firmante declara encontrarse debidamente facultado para obligar a su respectiva Parte.</p>
<table class="sigs"><tr>${sigCol('BROKER — INVICTUS BROKERAGE LLC')}${sigCol('CARRIER — ____________________________')}</tr></table>
<div class="pb"></div>
<p class="sec-title">EXHIBIT A — FEE SCHEDULE / ANEXO A — ESQUEMA DE COMISIONES</p>
<table class="grid">${feeRows}</table>
<p style="margin-top:9pt; font-style:italic">Volume is taken from the signed bill of lading and inventory at loading; actual loaded volume controls where it exceeds the estimate (Section 7.2). / El volumen se toma del bill of lading firmado y del inventario al momento de la carga; prevalece el volumen efectivamente cargado cuando supera el estimado (Cláusula 7.2).</p>
<p class="sec-title" style="margin-top:22pt">EXHIBIT B — NOTICE AND DISPATCH CONTACTS / ANEXO B — CONTACTOS DE NOTIFICACIÓN Y DISPATCH</p>
<table class="grid">${contactRows}</table>
</body></html>`;
fs.writeFileSync(process.argv[2] || 'contract.html', html);
console.log('html written');
