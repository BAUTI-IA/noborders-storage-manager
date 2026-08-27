// Parseo puro de la guía del CRM: HTML → secciones de texto plano.
//
// Vive separado de scripts/build-guide-index.mjs (que hace la I/O) y de
// lib/retrieval.mjs (que la sirve al agente) para que los tres compartan una
// sola copia de las reglas, y para poder testearlo sin tocar el disco.
// Sin imports a propósito: lo carga el script de build antes de que
// lib/guideText.mjs exista.

// Presupuesto por idioma. Por debajo de esto la recuperación óptima es "traer
// todo": armar un índice cuesta más de lo que ahorra (la guía viva son ~2.100
// tokens). Si algún día se supera, la herramienta `guide` pasa sola a devolver
// el índice de secciones y el modelo pide la que necesita — ver docs/rag.md.
export const GUIDE_TOKEN_BUDGET = 8000;

export const approxTokens = (s) => Math.round(String(s).length / 3.3);

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—",
  ndash: "–", hellip: "…", rarr: "→", larr: "←", laquo: "«", raquo: "»",
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", times: "×", middot: "·",
  deg: "°", euro: "€", pound: "£", bull: "•",
};

// Letras acentuadas (&aacute;, &ntilde;, &uuml;…). Hoy las guías no las usan,
// pero un editor que pegue texto desde Word las mete sin avisar, y "30 d&iacute;as"
// llegándole crudo al modelo es una respuesta rota.
for (const [name, mark] of Object.entries({ acute: "\u0301", grave: "\u0300", circ: "\u0302", tilde: "\u0303", uml: "\u0308", ring: "\u030a", cedil: "\u0327" })) {
  for (const letter of "aeiouyncAEIOUYNC") {
    ENTITIES[letter + name] = (letter + mark).normalize("NFC");
  }
}

// HTML → texto plano legible. Se conserva algo de estructura (encabezados como
// "## ", ítems como "- ") porque el modelo lee mucho mejor una jerarquía que un
// párrafo aplastado.
export function htmlToText(html) {
  return String(html)
    // Los mockups de UI son adorno visual: ruido puro para recuperación de texto.
    .replace(/<!--\s*static-mock\s*-->[\s\S]*?<!--\s*\/static-mock\s*-->/gi, "")
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n\n## ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|ul|ol|section|table)>/gi, "\n")
    .replace(/<t[dh]\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Título de la sección: el primer encabezado que aparezca, si no el id.
const titleOf = (text, id) => {
  const h = text.match(/^##\s+(.+)$/m);
  const t = h ? h[1].trim() : "";
  return t && t.length <= 80 ? t : id;
};

// Las guías vienen delimitadas por <!-- section:ID --> … <!-- /section:ID -->,
// los mismos marcadores que usa scripts/update-guide.mjs para editarlas.
export function parseGuide(html) {
  const re = /<!--\s*section:([^>]*?)\s*-->([\s\S]*?)<!--\s*\/section:\1\s*-->/g;
  const out = [];
  for (const m of String(html).matchAll(re)) {
    const text = htmlToText(m[2]);
    if (!text) continue;
    const id = m[1].trim();
    out.push({ id, title: titleOf(text, id), text });
  }
  return out;
}
