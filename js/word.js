import {
  AlignmentType,
  BorderStyle,
  Document,
  HeightRule,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
  convertMillimetersToTwip,
} from "docx";
import { getImageDimensions } from "./images.js";

export const FONT_NAME = "Poppins";
const FONT_HALF_POINTS = 16; // 8 pt
const CONTENT_WIDTH_TWIPS = 9026; // A4 (11906) menos 2,54 cm por lado (2 x 1440)
const PHOTO_COLUMNS = [1701, 7325]; // 3 cm / 12,92 cm
const INFO_COLUMNS = [2100, 2400, 2100, 2426];
const IMAGE_ROW_HEIGHT_MM = 77;
const IMAGE_MAX_WIDTH_PX = 565;
const IMAGE_MAX_HEIGHT_PX = 278;

const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const REQUIRED_PROJECT_FIELDS = [
  ["codigoPractica", "Código de práctica"],
  ["fechaFiscalizacion", "Fecha de fiscalización"],
  ["fiscalizador", "Fiscalizador"],
  ["lugar", "Lugar"],
  ["establecimiento", "Establecimiento o unidad fiscalizada"],
];

export class ExportValidationError extends Error {
  constructor(errors) {
    super("Faltan datos obligatorios para generar el anexo.");
    this.name = "ExportValidationError";
    this.errors = errors;
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

/** Convierte YYYY-MM-DD en fecha local para evitar corrimientos de zona horaria. */
export function parseLocalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function formatLongDate(value) {
  const date = parseLocalDate(value);
  if (!date) return "";
  return `${date.getDate()} de ${MONTHS_ES[date.getMonth()]} de ${date.getFullYear()}`;
}

export function formatLongDateUpper(value) {
  return formatLongDate(value).toUpperCase();
}

export function formatShortDate(value) {
  const date = parseLocalDate(value);
  if (!date) return "";
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
}

export function buildFileName(project) {
  const sanitized = String(project.codigoPractica || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .slice(0, 60);
  return `Anexo-fotografico-${sanitized || "sin-codigo"}.docx`;
}

/**
 * Valida proyecto, fotografías y descripciones antes de construir el Word.
 * Devuelve mensajes concretos que la interfaz puede mostrar.
 */
export function validateExportData(project, photos) {
  const errors = [];

  if (!project) {
    errors.push("No hay un proyecto activo.");
    return errors;
  }

  REQUIRED_PROJECT_FIELDS.forEach(([field, label]) => {
    if (!String(project[field] || "").trim()) {
      errors.push(`Completa el campo «${label}» del proyecto.`);
    }
  });

  if (project.fechaFiscalizacion && !parseLocalDate(project.fechaFiscalizacion)) {
    errors.push("La fecha de fiscalización no es válida.");
  }

  if (!Array.isArray(photos) || photos.length === 0) {
    errors.push("Agrega al menos una fotografía antes de generar el anexo.");
    return errors;
  }

  photos.forEach((photo, index) => {
    const number = pad2(index + 1);
    if (!photo.blob || !(photo.blob instanceof Blob) || photo.blob.size === 0) {
      errors.push(`Foto N.º ${number}: no se encontró la imagen almacenada.`);
    }
    if (!String(photo.description || "").trim()) {
      errors.push(`Foto N.º ${number}: falta la descripción obligatoria.`);
    }
  });

  return errors;
}

function fitImage(width, height) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const scale = Math.min(IMAGE_MAX_WIDTH_PX / safeWidth, IMAGE_MAX_HEIGHT_PX / safeHeight);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

function textRun(text, options = {}) {
  return new TextRun({
    text,
    font: FONT_NAME,
    size: FONT_HALF_POINTS,
    ...options,
  });
}

function descriptionChildren(description) {
  const lines = String(description || "").split(/\r?\n/);
  return lines.map(
    (line, index) =>
      new TextRun({
        text: line,
        font: FONT_NAME,
        size: FONT_HALF_POINTS,
        ...(index > 0 ? { break: 1 } : {}),
      }),
  );
}

function infoCell(text, { label = false, width, columnSpan } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    ...(columnSpan ? { columnSpan } : {}),
    verticalAlign: VerticalAlignTable.CENTER,
    margins: { top: 55, bottom: 55, left: 80, right: 80 },
    shading: label ? { type: ShadingType.CLEAR, fill: "F5F8FB", color: "auto" } : undefined,
    children: [
      new Paragraph({
        spacing: { before: 0, after: 0, line: 230 },
        children: [textRun(text, label ? { bold: true, color: "334E68" } : {})],
      }),
    ],
  });
}

function buildInfoTable(project) {
  return new Table({
    width: { size: CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
    columnWidths: INFO_COLUMNS,
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
    },
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          infoCell("Código de práctica", { label: true, width: INFO_COLUMNS[0] }),
          infoCell(project.codigoPractica, { width: INFO_COLUMNS[1] }),
          infoCell("Fecha de fiscalización", { label: true, width: INFO_COLUMNS[2] }),
          infoCell(formatShortDate(project.fechaFiscalizacion), { width: INFO_COLUMNS[3] }),
        ],
      }),
      new TableRow({
        cantSplit: true,
        children: [
          infoCell("Fiscalizador", { label: true, width: INFO_COLUMNS[0] }),
          infoCell(project.fiscalizador, { width: INFO_COLUMNS[1] }),
          infoCell("Lugar", { label: true, width: INFO_COLUMNS[2] }),
          infoCell(project.lugar, { width: INFO_COLUMNS[3] }),
        ],
      }),
      new TableRow({
        cantSplit: true,
        children: [
          infoCell("Establecimiento / unidad fiscalizada", { label: true, width: INFO_COLUMNS[0] }),
          infoCell(project.establecimiento, {
            width: INFO_COLUMNS[1] + INFO_COLUMNS[2] + INFO_COLUMNS[3],
            columnSpan: 3,
          }),
        ],
      }),
    ],
  });
}

function buildPhotosTable(project, photoRows, dateText) {
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: [
      new TableCell({
        width: { size: CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
        columnSpan: 2,
        shading: { type: ShadingType.CLEAR, fill: "E7EFF7", color: "auto" },
        margins: { top: 70, bottom: 70, left: 100, right: 100 },
        verticalAlign: VerticalAlignTable.CENTER,
        children: [
          new Paragraph({
            spacing: { before: 0, after: 0 },
            children: [textRun(`FOTOGRAFÍAS DE FECHA ${dateText}`, { bold: true })],
          }),
        ],
      }),
    ],
  });

  return new Table({
    width: { size: CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
    columnWidths: PHOTO_COLUMNS,
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" },
    },
    rows: [header, ...photoRows],
  });
}

async function buildPhotoRows(photos) {
  const rows = [];

  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    const number = pad2(index + 1);
    const buffer = await photo.blob.arrayBuffer();

    let width = Number(photo.width);
    let height = Number(photo.height);
    if (!width || !height) {
      const dimensions = await getImageDimensions(photo.blob);
      width = dimensions.width;
      height = dimensions.height;
    }
    const size = fitImage(width, height);

    rows.push(
      new TableRow({
        cantSplit: true,
        // Word mantiene esta fila con la siguiente: número + descripción.
        keepNext: true,
        height: {
          value: convertMillimetersToTwip(IMAGE_ROW_HEIGHT_MM),
          rule: HeightRule.EXACT,
        },
        children: [
          new TableCell({
            width: { size: CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
            columnSpan: 2,
            verticalAlign: VerticalAlignTable.CENTER,
            margins: { top: 50, bottom: 50, left: 100, right: 100 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 0 },
                keepNext: true,
                children: [
                  new ImageRun({
                    type: "jpg",
                    data: buffer,
                    transformation: size,
                    altText: {
                      name: `Foto ${number}`,
                      title: `Foto N.º ${number}`,
                      description: String(photo.description || "").slice(0, 500),
                    },
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );

    rows.push(
      new TableRow({
        cantSplit: true,
        height: {
          value: convertMillimetersToTwip(10),
          rule: HeightRule.ATLEAST,
        },
        children: [
          new TableCell({
            width: { size: PHOTO_COLUMNS[0], type: WidthType.DXA },
            verticalAlign: VerticalAlignTable.CENTER,
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [
              new Paragraph({
                spacing: { before: 0, after: 0, line: 230 },
                children: [textRun(`Foto N.º ${number}`, { bold: true })],
              }),
            ],
          }),
          new TableCell({
            width: { size: PHOTO_COLUMNS[1], type: WidthType.DXA },
            verticalAlign: VerticalAlignTable.CENTER,
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [
              new Paragraph({
                spacing: { before: 0, after: 0, line: 230 },
                children: descriptionChildren(photo.description),
              }),
            ],
          }),
        ],
      }),
    );
  }

  return rows;
}

/**
 * Construye un DOCX real y devuelve el Blob listo para descargar.
 * Las imágenes se incrustan, por lo que el archivo no depende del dispositivo.
 */
export async function buildDocx(project, photos) {
  const errors = validateExportData(project, photos);
  if (errors.length) {
    throw new ExportValidationError(errors);
  }

  const photoRows = await buildPhotoRows(photos);
  const dateText = formatLongDateUpper(project.fechaFiscalizacion);

  const document = new Document({
    creator: "Fiscalización fotográfica",
    title: `Anexo fotográfico ${project.codigoPractica}`,
    description: `Anexo fotográfico de la fiscalización de práctica ${project.codigoPractica}`,
    subject: project.establecimiento,
    styles: {
      default: {
        document: {
          run: { font: FONT_NAME, size: FONT_HALF_POINTS, color: "000000" },
          paragraph: { spacing: { before: 0, after: 0, line: 230 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertMillimetersToTwip(210),
              height: convertMillimetersToTwip(297),
            },
            margin: {
              top: convertMillimetersToTwip(25.4),
              right: convertMillimetersToTwip(25.4),
              bottom: convertMillimetersToTwip(25.4),
              left: convertMillimetersToTwip(25.4),
              header: convertMillimetersToTwip(12.7),
              footer: convertMillimetersToTwip(12.7),
              gutter: 0,
            },
          },
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 40 },
            children: [
              new TextRun({
                text: "ANEXO FOTOGRÁFICO",
                font: FONT_NAME,
                size: 28,
                bold: true,
                characterSpacing: 20,
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 120 },
            children: [textRun("Fiscalización de práctica", { color: "486581" })],
          }),
          buildInfoTable(project),
          new Paragraph({
            spacing: { before: 0, after: 100 },
            children: [],
          }),
          buildPhotosTable(project, photoRows, dateText),
          new Paragraph({
            spacing: { before: 0, after: 0 },
            children: [],
          }),
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(document);
  return {
    blob,
    fileName: buildFileName(project),
    photoCount: photos.length,
  };
}

/** Descarga un Blob en el navegador. */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
