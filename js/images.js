/** Utilidades para validar, comprimir y leer imágenes en el navegador. */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 1600;
export const JPEG_QUALITY = 0.86;

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("El archivo no contiene una imagen que este navegador pueda leer."));
    };
    image.src = url;
  });
}

async function decodeImage(blob) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (error) {
      console.warn("createImageBitmap falló; se intentará con HTMLImageElement.", error);
    }
  }
  return loadImageElement(blob);
}

function closeDecoded(image) {
  if (typeof image.close === "function") image.close();
}

/**
 * Comprueba tipo, tamaño y que la imagen se pueda decodificar.
 * Devuelve dimensiones sin modificar el archivo.
 */
export async function inspectImageFile(file) {
  if (!(file instanceof Blob)) {
    throw new Error("El archivo seleccionado no es válido.");
  }
  if (!file.type || !file.type.startsWith("image/")) {
    throw new Error(`«${file.name || "Archivo"}» no es una imagen compatible.`);
  }
  if (file.size === 0) {
    throw new Error(`«${file.name || "Archivo"}» está vacío.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`«${file.name}» supera el límite de 25 MB.`);
  }

  let decoded;
  try {
    decoded = await decodeImage(file);
  } catch (error) {
    throw new Error(
      `No se pudo leer «${file.name || "la imagen"}». Puede estar dañada o usar un formato no compatible (por ejemplo HEIC en algunos navegadores).`,
      { cause: error },
    );
  }

  const width = decoded.width || decoded.naturalWidth;
  const height = decoded.height || decoded.naturalHeight;
  closeDecoded(decoded);

  if (!width || !height) {
    throw new Error(`No se pudieron obtener las dimensiones de «${file.name || "la imagen"}».`);
  }

  return { width, height };
}

function canvasToJpeg(canvas, quality) {
  if (canvas.convertToBlob) {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("No se pudo comprimir la imagen."))),
      "image/jpeg",
      quality,
    );
  });
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Reescala y normaliza a JPEG para reducir el espacio que ocupa en IndexedDB
 * y en el DOCX. Mantiene siempre la proporción original.
 */
export async function normalizeImage(file) {
  const decoded = await decodeImage(file);
  const originalWidth = decoded.width || decoded.naturalWidth;
  const originalHeight = decoded.height || decoded.naturalHeight;

  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(originalWidth, originalHeight));
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));

  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    closeDecoded(decoded);
    throw new Error("Este navegador no permitió procesar la imagen.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(decoded, 0, 0, width, height);
  closeDecoded(decoded);

  const blob = await canvasToJpeg(canvas, JPEG_QUALITY);
  return {
    blob,
    width,
    height,
    originalWidth,
    originalHeight,
    originalName: file.name || "fotografia",
    originalType: file.type || "image/unknown",
    originalSize: file.size,
  };
}

export async function createThumbnail(blob, maxDimension = 420) {
  const decoded = await decodeImage(blob);
  const width = decoded.width || decoded.naturalWidth;
  const height = decoded.height || decoded.naturalHeight;
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const thumbWidth = Math.max(1, Math.round(width * scale));
  const thumbHeight = Math.max(1, Math.round(height * scale));

  const canvas = createCanvas(thumbWidth, thumbHeight);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    closeDecoded(decoded);
    throw new Error("No se pudo crear la miniatura.");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, thumbWidth, thumbHeight);
  context.imageSmoothingQuality = "high";
  context.drawImage(decoded, 0, 0, thumbWidth, thumbHeight);
  closeDecoded(decoded);

  return canvasToJpeg(canvas, 0.78);
}

/** Procesa un archivo y devuelve los blobs definitivos para IndexedDB. */
export async function preparePhotoFile(file) {
  await inspectImageFile(file);
  const normalized = await normalizeImage(file);
  const thumbnailBlob = await createThumbnail(normalized.blob);
  return {
    blob: normalized.blob,
    thumbnailBlob,
    width: normalized.width,
    height: normalized.height,
    originalWidth: normalized.originalWidth,
    originalHeight: normalized.originalHeight,
    originalName: normalized.originalName,
    originalType: normalized.originalType,
    originalSize: normalized.originalSize,
    mimeType: "image/jpeg",
  };
}

export async function getImageDimensions(blob) {
  const decoded = await decodeImage(blob);
  const width = decoded.width || decoded.naturalWidth;
  const height = decoded.height || decoded.naturalHeight;
  closeDecoded(decoded);
  return { width, height };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
