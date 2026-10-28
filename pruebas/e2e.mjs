/**
 * Prueba de extremo a extremo de la aplicación.
 *
 * Uso:
 *   npm run test:e2e
 *
 * El script inicia Vite en el puerto 4319 (si no hay uno activo), abre
 * Chromium con Playwright y recorre el flujo completo: creación de
 * proyectos, incorporación de imágenes sintéticas generadas en memoria,
 * descripciones, recarga, orden, eliminación, aislamiento entre proyectos,
 * validaciones, vista previa y descarga del DOCX.
 *
 * No requiere archivos de imagen en el repositorio: las fotografías de
 * prueba son SVG generados al vuelo y se convierten a JPEG dentro de la app.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4319;
const BASE = `http://localhost:${PORT}`;
const OUTPUT_DIR = path.join(os.tmpdir(), "fiscalizacion-fotografica-e2e");

const results = [];
let failures = 0;

function check(name, passed, detail = "") {
  results.push({ name, passed: Boolean(passed), detail });
  if (!passed) failures += 1;
  const icon = passed ? "OK  " : "FALLA";
  console.log(`[${icon}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function photoSvg(index) {
  const palettes = [
    ["#1f6f8b", "#eaf6f9"],
    ["#8b3a2f", "#f9ecea"],
    ["#2f6b4f", "#e9f6ef"],
    ["#5b3f8b", "#efeaf9"],
    ["#8b6a1f", "#f9f3e2"],
    ["#1f4e79", "#e8f0f8"],
    ["#7a2f5b", "#f9eaf3"],
  ];
  const [fill, text] = palettes[index % palettes.length];
  const width = index % 3 === 0 ? 900 : index % 3 === 1 ? 1200 : 700;
  const height = index % 3 === 0 ? 1200 : index % 3 === 1 ? 700 : 900;
  const label = `FOTO DE PRACTICA N. ${index}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${fill}"/>
    <g fill="${text}" font-family="Arial, sans-serif" text-anchor="middle">
      <text x="50%" y="50%" font-size="${Math.round(Math.min(width, height) / 9)}">${label}</text>
      <text x="50%" y="60%" font-size="${Math.round(Math.min(width, height) / 22)}">Imagen sintetica de prueba</text>
    </g>
  </svg>`;
}

function testFile(index) {
  return {
    name: `foto-prueba-${String(index).padStart(2, "0")}.svg`,
    mimeType: "image/svg+xml",
    buffer: Buffer.from(photoSvg(index), "utf8"),
  };
}

/** Lector mínimo de ZIP (DOCX) para inspeccionar su contenido sin dependencias. */
function readZip(buffer) {
  let eocd = -1;
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("El archivo no es un ZIP válido (no se encontró el EOCD).");

  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < total; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Cabecera central de ZIP inválida.");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, method, data });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function zipText(entries, name) {
  const entry = entries.find((item) => item.name === name);
  if (!entry) throw new Error(`No se encontró ${name} dentro del DOCX.`);
  const raw = entry.method === 0 ? entry.data : zlib.inflateRawSync(entry.data);
  return raw.toString("utf8");
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  if (await isReachable(BASE)) return null;

  const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (error) => {
    console.error("No se pudo iniciar Vite:", error);
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Vite terminó antes de estar disponible.");
    if (await isReachable(BASE)) return child;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  child.kill();
  throw new Error("Vite no respondió en el tiempo esperado.");
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
  });

  try {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => document.querySelector("#project-mode-badge")?.textContent === "Nuevo proyecto",
      null,
      { timeout: 15000 },
    );

    /* 1. Estado inicial */
    const initial = await page.evaluate(() => ({
      badge: document.querySelector("#project-mode-badge")?.textContent,
      summary: document.querySelector("#photos-summary")?.textContent,
      cameraDisabled: document.querySelector("#btn-camera")?.disabled,
      wordDisabled: document.querySelector("#btn-word")?.disabled,
      formTag: document.querySelector("#project-form")?.tagName,
      date: document.querySelector("#fecha")?.value,
    }));
    check(
      "1. Estado inicial con proyecto nuevo y acciones de fotos deshabilitadas",
      initial.badge === "Nuevo proyecto" &&
        initial.cameraDisabled === true &&
        initial.wordDisabled === true &&
        initial.formTag === "FORM" &&
        /^\d{4}-\d{2}-\d{2}$/.test(initial.date),
      JSON.stringify(initial),
    );

    /* 2. Validación de campos obligatorios */
    await page.fill("#fecha", "");
    await page.click("#btn-save-project");
    await page.waitForSelector("#dialog-alert[open]");
    const required = await page.evaluate(() => ({
      title: document.querySelector("#dialog-alert-title")?.textContent,
      details: Array.from(document.querySelectorAll("#dialog-alert-body li")).map((node) => node.textContent),
      projectOptions: document.querySelectorAll("#project-select option").length,
    }));
    check(
      "2. Campos obligatorios: se bloquea el guardado y se enumeran los 5 campos",
      required.title === "Faltan datos obligatorios" && required.details.length === 5,
      `${required.details.length} campos señalados`,
    );
    await page.click("#dialog-alert [data-close-dialog]");
    await page.waitForTimeout(200);

    /* 3. Crear proyecto */
    await page.fill("#codigo", "PF-2026-001");
    await page.fill("#fecha", "2026-10-15");
    await page.fill("#fiscalizador", "Ana Torres Vega");
    await page.fill("#lugar", "Lima, Lima, Lima");
    await page.fill("#establecimiento", "Establecimiento ficticio Los Alamos");
    await page.click("#btn-save-project");
    await page.waitForFunction(
      () => document.querySelector("#project-mode-badge")?.textContent === "Proyecto guardado",
      null,
      { timeout: 15000 },
    );
    const created = await page.evaluate(() => ({
      options: Array.from(document.querySelectorAll("#project-select option")).map((node) => node.textContent),
      cameraDisabled: document.querySelector("#btn-camera")?.disabled,
      wordDisabled: document.querySelector("#btn-word")?.disabled,
    }));
    check(
      "3. Proyecto creado y guardado en IndexedDB",
      created.options.some((text) => text.includes("PF-2026-001")) &&
        created.cameraDisabled === false &&
        created.wordDisabled === false,
      created.options.join(" / "),
    );

    /* 4. Vista previa de archivos y cancelación */
    await page.setInputFiles("#input-files", Array.from({ length: 6 }, (_, i) => testFile(i + 1)));
    await page.waitForSelector("#dialog-files[open]");
    const previewBefore = await page.evaluate(() => ({
      count: document.querySelectorAll(".file-preview-item").length,
      text: document.querySelector("#file-preview-count")?.textContent,
    }));
    await page.locator(".file-preview-item__remove").first().click();
    await page.waitForTimeout(200);
    const previewAfterRemove = await page.evaluate(() => ({
      count: document.querySelectorAll(".file-preview-item").length,
      text: document.querySelector("#file-preview-count")?.textContent,
    }));
    await page.getByRole("button", { name: "Cancelar" }).click();
    await page.waitForTimeout(300);
    const afterCancel = await page.evaluate(() => ({
      cards: document.querySelectorAll(".photo-card").length,
      dialogOpen: document.querySelector("#dialog-files")?.open,
    }));
    check(
      "4. Vista previa permite quitar imágenes y cancelar sin incorporar",
      previewBefore.count === 6 &&
        previewBefore.text.includes("6 imágenes listas") &&
        previewAfterRemove.count === 5 &&
        afterCancel.cards === 0 &&
        afterCancel.dialogOpen === false,
      `${previewBefore.count} → ${previewAfterRemove.count}, tarjetas: ${afterCancel.cards}`,
    );

    /* 5. Incorporar seis fotografías */
    await page.setInputFiles("#input-files", Array.from({ length: 6 }, (_, i) => testFile(i + 1)));
    await page.waitForSelector("#dialog-files[open]");
    await page.click("#btn-confirm-files");
    await page.waitForFunction(
      () => document.querySelectorAll(".photo-card").length === 6,
      null,
      { timeout: 60000 },
    );
    const incorporated = await page.evaluate(() => ({
      cards: document.querySelectorAll(".photo-card").length,
      titles: Array.from(document.querySelectorAll(".photo-card__title")).map((node) =>
        node.textContent.replace(/\s+/g, " ").trim(),
      ),
      summary: document.querySelector("#photos-summary")?.textContent,
      status: document.querySelector("#save-status")?.textContent,
    }));
    check(
      "5. Se incorporan 6 fotografías con numeración 01–06",
      incorporated.cards === 6 &&
        incorporated.titles[0].includes("01") &&
        incorporated.titles[5].includes("06") &&
        incorporated.summary.includes("6 fotografías"),
      incorporated.status,
    );

    /* 6. Descripciones y autoguardado */
    const descriptions = [
      "Fachada principal del establecimiento ficticio, con el letrero visible.",
      "Zona de recepcion: mostrador, sillas de espera y senalizacion interna.",
      "Almacen de insumos con estantes ordenados y productos identificados.",
      "Area de preparacion con superficies limpias y equipos de trabajo.",
      "Servicios higienicos con lavamanos y dispensadores implementados.",
      "Patio posterior: contenedores de residuos diferenciados por tipo.",
    ];
    const textareas = page.locator(".photo-card__description");
    for (let i = 0; i < descriptions.length; i += 1) {
      await textareas.nth(i).fill(descriptions[i]);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(1500);
    const described = await page.evaluate(() => ({
      pendingBadges: document.querySelectorAll(".photo-validation.badge--warning").length,
      summary: document.querySelector("#photos-summary")?.textContent,
      labels: Array.from(document.querySelectorAll(".photo-save")).map((node) => node.textContent),
      status: document.querySelector("#save-status")?.textContent,
    }));
    check(
      "6. Descripciones guardadas automáticamente",
      described.pendingBadges === 0 &&
        described.summary.includes("todas las descripciones están completas") &&
        described.labels.every((text) => text === "Guardado"),
      described.status,
    );

    /* 7. Persistencia tras recargar */
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(
      () => document.querySelectorAll(".photo-card").length === 6,
      null,
      { timeout: 20000 },
    );
    const reloaded = await page.evaluate(() => ({
      code: document.querySelector("#codigo")?.value,
      cards: document.querySelectorAll(".photo-card").length,
      first: document.querySelector(".photo-card__description")?.value,
      summary: document.querySelector("#photos-summary")?.textContent,
    }));
    check(
      "7. Proyecto, fotografías y descripciones persisten al recargar",
      reloaded.code === "PF-2026-001" &&
        reloaded.cards === 6 &&
        reloaded.first === descriptions[0] &&
        reloaded.summary.includes("completas"),
      `${reloaded.cards} fotografías recuperadas`,
    );

    /* 8. Reordenar */
    await page.locator(".photo-card").first().getByTitle("Mover hacia abajo").click();
    await page.waitForTimeout(800);
    const reordered = await page.evaluate(() => ({
      descriptions: Array.from(document.querySelectorAll(".photo-card__description")).map(
        (node) => node.value,
      ),
      numbers: Array.from(document.querySelectorAll(".photo-card__title")).map((node) =>
        node.textContent.match(/Foto N\.º (\d+)/)?.[1],
      ),
    }));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(
      () => document.querySelectorAll(".photo-card").length === 6,
      null,
      { timeout: 20000 },
    );
    const reorderedAfterReload = await page.evaluate(() => ({
      first: document.querySelector(".photo-card__description")?.value,
    }));
    check(
      "8. El orden se guarda y la numeración se recalcula",
      reordered.descriptions[0] === descriptions[1] &&
        reordered.numbers.join(",") === "01,02,03,04,05,06" &&
        reorderedAfterReload.first === descriptions[1],
      `primer texto tras recargar: «${reorderedAfterReload.first?.slice(0, 32)}…»`,
    );

    /* 9. Eliminar con confirmación (cancelar y aceptar) */
    await page.locator(".photo-card").nth(1).getByTitle("Eliminar fotografía").click();
    await page.waitForSelector("#dialog-confirm[open]");
    await page.locator("#dialog-confirm [data-cancel-confirm]").first().click();
    await page.waitForTimeout(300);
    const afterCancelDelete = await page.locator(".photo-card").count();
    await page.locator(".photo-card").nth(1).getByTitle("Eliminar fotografía").click();
    await page.waitForSelector("#dialog-confirm[open]");
    await page.click("#btn-confirm-action");
    await page.waitForFunction(
      () => document.querySelectorAll(".photo-card").length === 5,
      null,
      { timeout: 20000 },
    );
    const afterDelete = await page.evaluate(() => ({
      cards: document.querySelectorAll(".photo-card").length,
      numbers: Array.from(document.querySelectorAll(".photo-card__title")).map((node) =>
        node.textContent.match(/Foto N\.º (\d+)/)?.[1],
      ),
      summary: document.querySelector("#photos-summary")?.textContent,
    }));
    check(
      "9. Eliminación con confirmación y numeración continua",
      afterCancelDelete === 6 &&
        afterDelete.cards === 5 &&
        afterDelete.numbers.join(",") === "01,02,03,04,05",
      afterDelete.summary,
    );

    /* 10. Añadir una foto más (6 en total) */
    await page.setInputFiles("#input-files", testFile(7));
    await page.waitForSelector("#dialog-files[open]");
    await page.click("#btn-confirm-files");
    await page.waitForFunction(
      () => document.querySelectorAll(".photo-card").length === 6,
      null,
      { timeout: 60000 },
    );
    await page.locator(".photo-card__description").last().fill(
      "Acceso lateral y rotulo de numeracion del establecimiento ficticio.",
    );
    await page.waitForTimeout(1500);
    const sixAgain = await page.evaluate(() => ({
      cards: document.querySelectorAll(".photo-card").length,
      summary: document.querySelector("#photos-summary")?.textContent,
      pending: document.querySelectorAll(".photo-validation.badge--warning").length,
    }));
    check(
      "10. Se puede añadir otra fotografía y completar su descripción",
      sixAgain.cards === 6 && sixAgain.pending === 0 && sixAgain.summary.includes("completas"),
      sixAgain.summary,
    );

    /* 11. Segundo proyecto aislado */
    await page.click("#btn-new-project");
    await page.waitForFunction(
      () => document.querySelector("#project-mode-badge")?.textContent === "Nuevo proyecto",
      null,
      { timeout: 10000 },
    );
    await page.fill("#codigo", "PF-2026-002");
    await page.fill("#fecha", "2026-10-20");
    await page.fill("#fiscalizador", "Luis Ramos Diaz");
    await page.fill("#lugar", "Arequipa, Arequipa, Arequipa");
    await page.fill("#establecimiento", "Botica ficticia San Rafael");
    await page.click("#btn-save-project");
    await page.waitForFunction(
      () => document.querySelector("#project-mode-badge")?.textContent === "Proyecto guardado",
      null,
      { timeout: 15000 },
    );
    const projectB = await page.evaluate(() => ({
      cards: document.querySelectorAll(".photo-card").length,
      summary: document.querySelector("#photos-summary")?.textContent,
      optionCount: document.querySelectorAll("#project-select option").length - 1,
    }));
    check(
      "11. Un segundo proyecto no hereda fotografías del primero",
      projectB.cards === 0 && projectB.optionCount === 2,
      projectB.summary,
    );

    /* 12. Exportación bloqueada sin fotografías */
    await page.click("#btn-word");
    await page.waitForSelector("#dialog-alert[open]");
    const blockedNoPhotos = await page.evaluate(() => ({
      title: document.querySelector("#dialog-alert-title")?.textContent,
      details: Array.from(document.querySelectorAll("#dialog-alert-body li")).map((node) => node.textContent),
    }));
    check(
      "12. La exportación se bloquea si no hay fotografías",
      blockedNoPhotos.title === "No se puede generar el Word" &&
        blockedNoPhotos.details.some((text) => text.includes("al menos una fotografía")),
      blockedNoPhotos.details.join(" | "),
    );
    await page.click("#dialog-alert [data-close-dialog]");
    await page.waitForTimeout(200);

    /* 13. Exportación bloqueada por descripción faltante */
    await page.setInputFiles("#input-files", testFile(8));
    await page.waitForSelector("#dialog-files[open]");
    await page.click("#btn-confirm-files");
    await page.waitForFunction(
      () => document.querySelectorAll(".photo-card").length === 1,
      null,
      { timeout: 60000 },
    );
    await page.locator("#codigo").click();
    await page.waitForTimeout(1000);
    await page.click("#btn-word");
    await page.waitForSelector("#dialog-alert[open]");
    const blockedNoDescription = await page.evaluate(() => ({
      title: document.querySelector("#dialog-alert-title")?.textContent,
      details: Array.from(document.querySelectorAll("#dialog-alert-body li")).map((node) => node.textContent),
      invalid: document.querySelector('.photo-card__description[aria-invalid="true"]') !== null,
    }));
    check(
      "13. La exportación se bloquea si falta una descripción y marca el campo",
      blockedNoDescription.title === "No se puede generar el Word" &&
        blockedNoDescription.details.some((text) => text.includes("falta la descripción")) &&
        blockedNoDescription.invalid,
      blockedNoDescription.details.join(" | "),
    );
    await page.click("#dialog-alert [data-close-dialog]");
    await page.waitForTimeout(200);

    /* 14. Aislamiento al reabrir el proyecto A */
    const options = await page
      .locator("#project-select option")
      .evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, text: node.textContent })));
    const optionA = options.find((option) => option.text.includes("PF-2026-001"));
    const optionB = options.find((option) => option.text.includes("PF-2026-002"));
    await page.selectOption("#project-select", optionA.value);
    await page.waitForTimeout(900);
    const reopenedA = await page.evaluate(() => ({
      code: document.querySelector("#codigo")?.value,
      cards: document.querySelectorAll(".photo-card").length,
      pending: document.querySelectorAll(".photo-validation.badge--warning").length,
    }));
    await page.selectOption("#project-select", optionB.value);
    await page.waitForTimeout(900);
    const reopenedB = await page.evaluate(() => ({
      code: document.querySelector("#codigo")?.value,
      cards: document.querySelectorAll(".photo-card").length,
      pending: document.querySelectorAll(".photo-validation.badge--warning").length,
    }));
    check(
      "14. Cada proyecto conserva sus propias fotografías",
      reopenedA.code === "PF-2026-001" &&
        reopenedA.cards === 6 &&
        reopenedB.code === "PF-2026-002" &&
        reopenedB.cards === 1 &&
        reopenedB.pending === 1,
      `A: ${reopenedA.cards} fotos, B: ${reopenedB.cards} foto`,
    );

    /* 15. Vista previa del anexo */
    await page.selectOption("#project-select", optionA.value);
    await page.waitForTimeout(900);
    await page.click("#btn-preview");
    await page.waitForSelector("#dialog-preview[open]");
    const preview = await page.evaluate(() => ({
      pages: document.querySelectorAll(".anexo-page").length,
      numbers: Array.from(document.querySelectorAll(".anexo-preview-table__num")).map(
        (node) => node.textContent,
      ),
      images: document.querySelectorAll(".anexo-preview-table__image img").length,
      date: document.querySelector(".anexo-page__date")?.textContent,
    }));
    check(
      "15. Vista previa: 3 páginas, 2 fotos por página y numeración 01–06",
      preview.pages === 3 &&
        preview.images === 6 &&
        preview.numbers.join(",") === "Foto N.º 01,Foto N.º 02,Foto N.º 03,Foto N.º 04,Foto N.º 05,Foto N.º 06" &&
        preview.date.includes("15 DE OCTUBRE DE 2026"),
      `${preview.pages} páginas, ${preview.images} imágenes`,
    );
    await page.locator("#dialog-preview .dialog__actions [data-close-dialog]").click();
    await page.waitForTimeout(300);

    /* 16. Generar y verificar el DOCX */
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120000 }),
      page.click("#btn-word"),
    ]);
    const docxPath = path.join(OUTPUT_DIR, download.suggestedFilename());
    await download.saveAs(docxPath);
    await page.waitForFunction(
      () => document.querySelector("#save-status")?.textContent === "Word generado",
      null,
      { timeout: 15000 },
    );

    const buffer = fs.readFileSync(docxPath);
    const entries = readZip(buffer);
    const media = entries.filter((entry) => /^word\/media\/.+\.jpe?g$/i.test(entry.name));
    const documentXml = zipText(entries, "word/document.xml");
    const documentText = [...documentXml.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/g)]
      .map((match) => match[1])
      .join(" | ");
    const drawings = (documentXml.match(/<w:drawing>/g) || []).length;
    const checks = {
      filename: download.suggestedFilename() === "Anexo-fotografico-PF-2026-001.docx",
      zip: buffer.readUInt32LE(0) === 0x04034b50,
      media: media.length === 6,
      drawings: drawings === 6,
      pageSize: /<w:pgSz w:w="1190\d" w:h="1683\d"/.test(documentXml),
      margins: /w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/.test(documentXml),
      font: documentXml.includes('w:ascii="Poppins"'),
      size: /<w:sz w:val="16"\/>/.test(documentXml),
      headerRepeat: documentXml.includes("<w:tblHeader/>"),
      exactRows: (documentXml.match(/w:trHeight w:val="4365" w:hRule="exact"/g) || []).length === 6,
      date: documentText.includes("FOTOGRAFÍAS DE FECHA 15 DE OCTUBRE DE 2026"),
      captions: documentText.includes("Foto N.º 06"),
    };
    check(
      "16. DOCX válido, con 6 imágenes incrustadas y formato solicitado",
      Object.values(checks).every(Boolean),
      Object.entries(checks)
        .filter(([, value]) => !value)
        .map(([key]) => key)
        .join(", ") || `${Math.round(buffer.length / 1024)} KB`,
    );

    /* 17. Vista móvil sin desbordamiento horizontal */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(700);
    await page.evaluate(() => window.scrollTo(0, 0));
    const mobile = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      cameraVisible: Boolean(document.querySelector("#btn-camera")?.offsetParent),
      wordVisible: Boolean(document.querySelector("#btn-word")?.offsetParent),
      toolbarHeight: Math.round(document.querySelector(".toolbar")?.getBoundingClientRect().height || 0),
    }));
    await page.screenshot({
      path: path.join(OUTPUT_DIR, "movil.png"),
      fullPage: false,
    });
    check(
      "17. Diseño móvil a 390 px sin desbordamiento ni huecos en la barra",
      mobile.scrollWidth <= mobile.innerWidth + 1 &&
        mobile.cameraVisible &&
        mobile.wordVisible &&
        mobile.toolbarHeight < 300,
      `${mobile.scrollWidth}px de ancho útil, barra de ${mobile.toolbarHeight}px`,
    );
    await page.setViewportSize({ width: 1280, height: 900 });

    /* 18. Sin errores de JavaScript en la consola */
    check(
      "18. Sin errores de JavaScript ni de consola durante todo el recorrido",
      pageErrors.length === 0,
      pageErrors.join(" | ") || "sin errores",
    );

    console.log(`\nDOCX generado: ${docxPath}`);
    console.log(`Capturas de la prueba: ${OUTPUT_DIR}`);
  } finally {
    await context.close();
    await browser.close();
    if (server) {
      server.kill();
      await once(server, "exit").catch(() => {});
    }
  }

  const passed = results.filter((result) => result.passed).length;
  console.log(`\nResultado: ${passed}/${results.length} verificaciones superadas.`);
  if (failures) {
    console.error(`${failures} verificación(es) fallida(s).`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("\nLa prueba no pudo completarse:", error);
  process.exitCode = 1;
});
