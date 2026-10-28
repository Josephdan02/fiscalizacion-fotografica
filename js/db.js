/**
 * Persistencia local con IndexedDB.
 * Proyectos y fotografías viven en almacenes separados; cada fotografía
 * conserva el id del proyecto al que pertenece.
 */

const DB_NAME = "fiscalizacion-fotografica";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_PHOTOS = "photos";

let dbPromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Error de IndexedDB"));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("No se pudo completar la operación en IndexedDB"));
    transaction.onabort = () =>
      reject(transaction.error || new Error("La operación en IndexedDB fue cancelada"));
  });
}

function setupDatabase(db) {
  if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
    const projects = db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
    projects.createIndex("updatedAt", "updatedAt");
  }

  if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
    const photos = db.createObjectStore(STORE_PHOTOS, { keyPath: "id" });
    photos.createIndex("projectId", "projectId");
    photos.createIndex("projectOrder", ["projectId", "order"]);
  }
}

/**
 * Abre la base. Si se abre una versión nueva en otra pestaña,
 * se cierra esta conexión para no bloquearla.
 */
export function openDatabase() {
  if (dbPromise) return dbPromise;

  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("Este navegador no permite almacenamiento local con IndexedDB."));
  }

  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      try {
        setupDatabase(request.result);
      } catch (error) {
        console.error("No se pudo preparar IndexedDB:", error);
        request.transaction?.abort();
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        window.dispatchEvent(new CustomEvent("db-versionchange"));
      };
      resolve(db);
    };

    request.onerror = () => {
      console.error("Error al abrir IndexedDB:", request.error);
      reject(new Error("No se pudo abrir el almacenamiento local. Revisa si el navegador permite datos para este sitio."));
    };

    request.onblocked = () => {
      console.warn("La apertura de IndexedDB está bloqueada por otra pestaña.");
      reject(new Error("Otra pestaña está usando una versión anterior de la aplicación. Ciérrala y vuelve a intentar."));
    };
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

async function getDatabase() {
  if (!dbPromise) return openDatabase();
  return dbPromise;
}

export async function listProjects() {
  const db = await getDatabase();
  const transaction = db.transaction(STORE_PROJECTS, "readonly");
  const projects = await requestToPromise(transaction.objectStore(STORE_PROJECTS).getAll());
  await transactionToPromise(transaction);

  return projects.sort((a, b) => {
    const dateA = a.updatedAt || a.createdAt || "";
    const dateB = b.updatedAt || b.createdAt || "";
    return dateB.localeCompare(dateA);
  });
}

export async function getProject(projectId) {
  const db = await getDatabase();
  const transaction = db.transaction(STORE_PROJECTS, "readonly");
  const project = await requestToPromise(transaction.objectStore(STORE_PROJECTS).get(projectId));
  await transactionToPromise(transaction);
  return project || null;
}

/** Guarda o reemplaza un proyecto. Resuelve cuando la transacción se confirma. */
export async function saveProject(project) {
  const db = await getDatabase();
  const transaction = db.transaction(STORE_PROJECTS, "readwrite");
  transaction.objectStore(STORE_PROJECTS).put(project);
  await transactionToPromise(transaction);
  return project;
}

export async function listPhotos(projectId) {
  const db = await getDatabase();
  const transaction = db.transaction(STORE_PHOTOS, "readonly");
  const index = transaction.objectStore(STORE_PHOTOS).index("projectId");
  const photos = await requestToPromise(index.getAll(projectId));
  await transactionToPromise(transaction);
  return photos.sort((a, b) => a.order - b.order);
}

export async function getPhoto(photoId) {
  const db = await getDatabase();
  const transaction = db.transaction(STORE_PHOTOS, "readonly");
  const photo = await requestToPromise(transaction.objectStore(STORE_PHOTOS).get(photoId));
  await transactionToPromise(transaction);
  return photo || null;
}

/** Guarda una fotografía. Resuelve cuando IndexedDB confirma la escritura. */
export async function savePhoto(photo) {
  const db = await getDatabase();
  const transaction = db.transaction(STORE_PHOTOS, "readwrite");
  transaction.objectStore(STORE_PHOTOS).put(photo);
  await transactionToPromise(transaction);
  return photo;
}

/** Guarda varias fotografías en una sola transacción. */
export async function savePhotos(photos) {
  if (!photos.length) return;
  const db = await getDatabase();
  const transaction = db.transaction(STORE_PHOTOS, "readwrite");
  const store = transaction.objectStore(STORE_PHOTOS);
  photos.forEach((photo) => store.put(photo));
  await transactionToPromise(transaction);
}

export async function deletePhoto(photoId) {
  const db = await getDatabase();
  const transaction = db.transaction(STORE_PHOTOS, "readwrite");
  transaction.objectStore(STORE_PHOTOS).delete(photoId);
  await transactionToPromise(transaction);
}

/** Elimina una foto y guarda el nuevo orden en una sola transacción. */
export async function deletePhotoAndReindex(photoId, remainingPhotos) {
  const db = await getDatabase();
  const transaction = db.transaction(STORE_PHOTOS, "readwrite");
  const store = transaction.objectStore(STORE_PHOTOS);
  store.delete(photoId);
  remainingPhotos.forEach((photo) => store.put(photo));
  await transactionToPromise(transaction);
}

export async function countPhotos() {
  const db = await getDatabase();
  const transaction = db.transaction(STORE_PHOTOS, "readonly");
  const count = await requestToPromise(transaction.objectStore(STORE_PHOTOS).count());
  await transactionToPromise(transaction);
  return count;
}

export async function getStorageInfo() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch (error) {
    console.warn("No se pudo consultar el uso de almacenamiento:", error);
    return null;
  }
}

export function formatDatabaseError(error) {
  if (!error) return "Ocurrió un error desconocido al acceder a los datos.";
  if (error.name === "QuotaExceededError") {
    return "No queda espacio suficiente en el navegador. Elimina fotografías o proyectos antiguos antes de continuar.";
  }
  if (error.name === "SecurityError") {
    return "El navegador bloqueó el almacenamiento local. Revisa la configuración de privacidad del sitio.";
  }
  if (error.name === "InvalidStateError") {
    return "La base de datos local no está disponible en este momento. Recarga la página.";
  }
  return error.message || "No se pudo completar la operación con los datos locales.";
}
