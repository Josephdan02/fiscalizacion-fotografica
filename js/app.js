import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/latin-700.css";

import * as db from "./db.js";
import { formatBytes, inspectImageFile, preparePhotoFile } from "./images.js";
import {
  ExportValidationError,
  buildDocx,
  downloadBlob,
  formatLongDateUpper,
  formatShortDate,
  parseLocalDate,
  validateExportData,
} from "./word.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const LAST_PROJECT_KEY = "fiscalizacion-fotografica:ultimo-proyecto";

const state = {
  ready: false,
  projects: [],
  activeProjectId: null,
  mode: "empty", // empty | create | view
  photos: [],
  selectedPhotoId: null,
  projectDirty: false,
  photoDirty: false,
  invalidPhotoIds: new Set(),
  pendingEntries: [],
  processingFiles: false,
  exporting: false,
  reordering: false,
  descriptionTimers: new Map(),
  photoSavePromises: new Set(),
};

const thumbUrls = new Map();
const fullUrls = new Map();
const dateTimeFormatter = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "medium",
  timeStyle: "short",
});

/* ---------- Utilidades de interfaz ---------- */

function pad2(value) {
  return String(value).padStart(2, "0");
}

function newId(prefix = "id") {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function h(tag, properties = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(properties).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value === true ? "" : value);
    }
  });
  (Array.isArray(children) ? children : [children]).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function option(value, label) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function todayValue() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function formatAddedAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha no disponible";
  return dateTimeFormatter.format(date);
}

function setStatus(status, text) {
  const label = $("#save-status");
  label.textContent = text;
  const container = label.closest(".header-status");
  if (container) container.dataset.state = status;
}

function toast(message, type = "info", duration = 4500) {
  const region = $("#toast-region");
  const node = h("div", { className: `toast toast--${type}`, role: "status" }, [
    h("span", { text: message }),
  ]);
  region.append(node);
  while (region.children.length > 4) region.firstElementChild.remove();
  window.setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity 180ms ease";
    window.setTimeout(() => node.remove(), 200);
  }, duration);
}

function openDialog(dialog) {
  if (!dialog || dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog, value = "cancel") {
  if (!dialog?.open) return;
  if (typeof dialog.close === "function") dialog.close(value);
  else dialog.removeAttribute("open");
}

function showAlert({ title, message = "", details = [], kicker = "Aviso", tone = "warning" }) {
  $("#dialog-alert-kicker").textContent = kicker;
  $("#dialog-alert-title").textContent = title;
  const body = $("#dialog-alert-body");
  body.replaceChildren();

  if (message) body.append(h("p", { text: message }));
  if (details.length) {
    body.append(
      h(
        "ul",
        { className: `alert-details${tone === "error" ? " alert-details--error" : ""}` },
        details.map((detail) => h("li", { text: detail })),
      ),
    );
  }

  openDialog($("#dialog-alert"));
}

function confirmAction({
  title,
  message,
  confirmLabel = "Confirmar",
  danger = true,
}) {
  return new Promise((resolve) => {
    const dialog = $("#dialog-confirm");
    $("#dialog-confirm-title").textContent = title;
    $("#dialog-confirm-message").textContent = message;
    const accept = $("#btn-confirm-action");
    accept.textContent = confirmLabel;
    accept.classList.toggle("btn--danger", danger);
    accept.classList.toggle("btn--primary", !danger);

    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "confirm");
    };
    dialog.addEventListener("close", onClose);
    dialog.returnValue = "cancel";
    openDialog(dialog);
  });
}

function setButtonBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.normalHtml) button.dataset.normalHtml = button.innerHTML;
    button.textContent = busyText;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  } else {
    if (button.dataset.normalHtml) {
      button.innerHTML = button.dataset.normalHtml;
      delete button.dataset.normalHtml;
    }
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function readLastProjectId() {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function saveLastProjectId(projectId) {
  try {
    if (projectId) localStorage.setItem(LAST_PROJECT_KEY, projectId);
    else localStorage.removeItem(LAST_PROJECT_KEY);
  } catch (error) {
    console.warn("No se pudo recordar el último proyecto:", error);
  }
}

/* ---------- URLs de imágenes ---------- */

function thumbUrl(photo) {
  if (!thumbUrls.has(photo.id)) {
    thumbUrls.set(photo.id, URL.createObjectURL(photo.thumbnailBlob || photo.blob));
  }
  return thumbUrls.get(photo.id);
}

function fullUrl(photo) {
  if (!fullUrls.has(photo.id)) {
    fullUrls.set(photo.id, URL.createObjectURL(photo.blob));
  }
  return fullUrls.get(photo.id);
}

function revokePhotoUrls(photoId) {
  const thumb = thumbUrls.get(photoId);
  if (thumb) URL.revokeObjectURL(thumb);
  thumbUrls.delete(photoId);
  const full = fullUrls.get(photoId);
  if (full) URL.revokeObjectURL(full);
  fullUrls.delete(photoId);
}

function clearPhotoUrls() {
  thumbUrls.forEach((url) => URL.revokeObjectURL(url));
  fullUrls.forEach((url) => URL.revokeObjectURL(url));
  thumbUrls.clear();
  fullUrls.clear();
}

/* ---------- Proyectos ---------- */

async function refreshProjects() {
  state.projects = await db.listProjects();
  renderProjectSelect();
  updateProjectHint();
}

function renderProjectSelect() {
  const select = $("#project-select");
  select.replaceChildren();
  if (!state.projects.length) {
    select.append(option("", "No hay proyectos guardados"));
    select.value = "";
    return;
  }

  select.append(option("", "Selecciona un proyecto…"));
  state.projects.forEach((project) => {
    const label = `${project.codigoPractica || "Sin código"} · ${project.establecimiento || "Sin establecimiento"}`;
    select.append(option(project.id, label));
  });
  select.value = state.activeProjectId || "";
}

function updateProjectHint() {
  const count = state.projects.length;
  $("#project-hint").textContent =
    count === 0
      ? "Aún no hay proyectos. Completa el formulario para crear el primero."
      : `${count} proyecto${count === 1 ? "" : "s"} guardado${count === 1 ? "" : "s"} en este navegador.`;
}

function getActiveProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function currentProjectForDisplay() {
  const project = getActiveProject();
  if (!project) return null;
  return { ...project, ...readProjectForm() };
}

function readProjectForm() {
  return {
    codigoPractica: $("#codigo").value.trim(),
    fechaFiscalizacion: $("#fecha").value,
    fiscalizador: $("#fiscalizador").value.trim(),
    lugar: $("#lugar").value.trim(),
    establecimiento: $("#establecimiento").value.trim(),
  };
}

function fillProjectForm(project) {
  $("#codigo").value = project.codigoPractica || "";
  $("#fecha").value = project.fechaFiscalizacion || "";
  $("#fiscalizador").value = project.fiscalizador || "";
  $("#lugar").value = project.lugar || "";
  $("#establecimiento").value = project.establecimiento || "";
  clearProjectFieldErrors();
}

function clearProjectFieldErrors() {
  ["#codigo", "#fecha", "#fiscalizador", "#lugar", "#establecimiento"].forEach((selector) => {
    $(selector).removeAttribute("aria-invalid");
  });
}

function validateProjectForm({ mark = true } = {}) {
  const values = readProjectForm();
  const errors = [];
  const fields = [
    ["codigoPractica", "#codigo", "Código de práctica"],
    ["fechaFiscalizacion", "#fecha", "Fecha de fiscalización"],
    ["fiscalizador", "#fiscalizador", "Fiscalizador"],
    ["lugar", "#lugar", "Lugar"],
    ["establecimiento", "#establecimiento", "Establecimiento o unidad fiscalizada"],
  ];

  clearProjectFieldErrors();
  fields.forEach(([key, selector, label]) => {
    if (!values[key]) {
      errors.push(`Completa el campo «${label}».`);
      if (mark) $(selector).setAttribute("aria-invalid", "true");
    }
  });

  if (values.fechaFiscalizacion && !parseLocalDate(values.fechaFiscalizacion)) {
    errors.push("La fecha de fiscalización no es válida.");
    if (mark) $("#fecha").setAttribute("aria-invalid", "true");
  }

  return { values, errors };
}

function updateProjectUi() {
  const active = Boolean(state.activeProjectId);
  const badge = $("#project-mode-badge");
  const saveButton = $("#btn-save-project");

  if (state.mode === "create") {
    badge.textContent = "Nuevo proyecto";
    badge.className = "badge badge--warning";
    saveButton.textContent = "Crear proyecto";
  } else if (state.projectDirty) {
    badge.textContent = "Cambios sin guardar";
    badge.className = "badge badge--warning";
    saveButton.textContent = "Guardar datos";
  } else if (state.mode === "view") {
    badge.textContent = "Proyecto guardado";
    badge.className = "badge badge--success";
    saveButton.textContent = "Guardar datos";
  } else {
    badge.textContent = "Sin proyecto";
    badge.className = "badge badge--muted";
    saveButton.textContent = "Crear proyecto";
  }

  saveButton.disabled = !state.ready;
  $("#btn-camera").disabled = !active;
  $("#btn-files").disabled = !active;
  $("#btn-preview").disabled = !active;
  $("#btn-word").disabled = !active;
}

function markProjectDirty() {
  state.projectDirty = true;
  updateProjectUi();
  setStatus("dirty", "Cambios sin guardar");
}

async function saveProjectData({ quiet = false } = {}) {
  if (!state.ready) {
    showAlert({
      title: "Almacenamiento no disponible",
      message: "No se puede guardar porque IndexedDB no está disponible en este navegador.",
      tone: "error",
    });
    return false;
  }

  const { values, errors } = validateProjectForm();
  if (errors.length) {
    showAlert({
      kicker: "Revisa los datos",
      title: "Faltan datos obligatorios",
      message: "Completa los siguientes campos antes de guardar el proyecto.",
      details: errors,
      tone: "error",
    });
    const firstInvalid = $('[aria-invalid="true"]');
    firstInvalid?.focus();
    firstInvalid?.scrollIntoView({ behavior: "smooth", block: "center" });
    return false;
  }

  const button = $("#btn-save-project");
  setButtonBusy(button, true, "Guardando…");
  setStatus("saving", "Guardando datos…");

  try {
    const now = new Date().toISOString();
    let savedProject;

    if (state.mode === "create") {
      savedProject = {
        id: newId("proyecto"),
        ...values,
        createdAt: now,
        updatedAt: now,
      };
      await db.saveProject(savedProject);
      state.projects.push(savedProject);
      state.activeProjectId = savedProject.id;
      state.mode = "view";
      await refreshProjects();
      state.selectedPhotoId = null;
      state.projectDirty = false;
      saveLastProjectId(savedProject.id);
      clearPhotoUrls();
      state.photos = [];
      renderAll();
      setStatus("saved", "Proyecto creado y guardado");
      if (!quiet) toast("Proyecto creado. Ya puedes agregar fotografías.", "success");
    } else {
      const current = getActiveProject();
      if (!current) throw new Error("No se encontró el proyecto activo.");
      savedProject = {
        ...current,
        ...values,
        updatedAt: now,
      };
      await db.saveProject(savedProject);
      state.projects = state.projects.map((project) =>
        project.id === savedProject.id ? savedProject : project,
      );
      state.projectDirty = false;
      await refreshProjects();
      updateProjectUi();
      setStatus("saved", "Datos guardados localmente");
      if (!quiet) toast("Datos de la fiscalización guardados.", "success");
    }

    return true;
  } catch (error) {
    console.error("No se pudo guardar el proyecto:", error);
    setStatus("error", "Error al guardar");
    showAlert({
      title: "No se pudieron guardar los datos",
      message: db.formatDatabaseError(error),
      tone: "error",
    });
    return false;
  } finally {
    setButtonBusy(button, false);
    updateProjectUi();
  }
}

async function loadProject(projectId, { skipPrompt = false, silent = false } = {}) {
  if (!projectId) return false;

  if (!skipPrompt && state.projectDirty) {
    const proceed = await confirmAction({
      title: "Cambios sin guardar",
      message:
        "Los datos del formulario tienen cambios sin guardar. Si abres otro proyecto, esos cambios se perderán.",
      confirmLabel: "Descartar y abrir",
    });
    if (!proceed) return false;
  }

  await flushPhotoSaves();

  try {
    const project =
      state.projects.find((item) => item.id === projectId) || (await db.getProject(projectId));
    if (!project) {
      showAlert({
        title: "Proyecto no encontrado",
        message: "El proyecto ya no existe en el almacenamiento local.",
        tone: "error",
      });
      await refreshProjects();
      if (!state.projects.length) startNewProject({ skipPrompt: true, focus: false });
      return false;
    }

    clearPhotoUrls();
    state.activeProjectId = project.id;
    state.mode = "view";
    state.projectDirty = false;
    state.photoDirty = false;
    state.invalidPhotoIds.clear();
    fillProjectForm(project);

    state.photos = await db.listPhotos(project.id);
    state.photos.forEach((photo, index) => {
      photo.order = index;
    });
    state.selectedPhotoId = state.photos[0]?.id || null;
    saveLastProjectId(project.id);

    renderAll();
    setStatus("saved", "Datos recuperados de este navegador");
    if (!silent) toast("Proyecto abierto.", "info", 2500);
    updateStorageInfo();
    return true;
  } catch (error) {
    console.error("No se pudo abrir el proyecto:", error);
    setStatus("error", "Error de lectura");
    showAlert({
      title: "No se pudo abrir el proyecto",
      message: db.formatDatabaseError(error),
      tone: "error",
    });
    return false;
  }
}

function startNewProject({ skipPrompt = false, focus = true } = {}) {
  const begin = async () => {
    try {
      await flushPhotoSaves();
      clearPhotoUrls();
      state.activeProjectId = null;
      state.mode = "create";
      state.photos = [];
      state.selectedPhotoId = null;
      state.projectDirty = false;
      state.photoDirty = false;
      state.invalidPhotoIds.clear();
      state.pendingEntries = [];
      saveLastProjectId(null);

      $("#project-form").reset();
      $("#fecha").value = todayValue();
      clearProjectFieldErrors();
      renderAll();
      setStatus("dirty", "Proyecto nuevo sin guardar");
      if (focus) $("#codigo").focus();
    } catch (error) {
      console.error("No se pudo preparar el proyecto nuevo:", error);
      setStatus("error", "Error al preparar el proyecto");
      showAlert({
        title: "No se pudo preparar el proyecto nuevo",
        message: "Recarga la página y vuelve a intentarlo.",
        tone: "error",
      });
    }
  };

  if (!skipPrompt && state.projectDirty) {
    confirmAction({
      title: "Cambios sin guardar",
      message:
        "Si creas un proyecto nuevo, se descartarán los datos que aún no has guardado en este formulario.",
      confirmLabel: "Crear de todos modos",
    }).then((proceed) => {
      if (proceed) begin();
    });
    return;
  }

  begin();
}

async function handleProjectSelect(event) {
  const projectId = event.target.value;
  if (!projectId) {
    event.target.value = state.activeProjectId || "";
    return;
  }
  if (projectId === state.activeProjectId) return;

  const previousValue = state.activeProjectId || "";
  const opened = await loadProject(projectId);
  if (!opened) event.target.value = previousValue;
}

/* ---------- Galería ---------- */

function selectedPhoto() {
  return state.photos.find((photo) => photo.id === state.selectedPhotoId) || null;
}

function sortedPhotos() {
  return [...state.photos].sort((a, b) => a.order - b.order);
}

function updateSummary() {
  const summary = $("#photos-summary");
  const pendingCount = $("#pending-count");

  if (!state.activeProjectId) {
    summary.textContent = "Crea o abre un proyecto para comenzar.";
    pendingCount.hidden = true;
    return;
  }

  const pending = state.photos.filter((photo) => !String(photo.description || "").trim()).length;
  summary.textContent =
    state.photos.length === 0
      ? "Aún no hay fotografías en este proyecto."
      : `${state.photos.length} fotografía${state.photos.length === 1 ? "" : "s"} · ${
          pending === 0
            ? "todas las descripciones están completas"
            : `${pending} ${pending === 1 ? "descripción pendiente" : "descripciones pendientes"}`
        }`;

  pendingCount.hidden = pending === 0;
  pendingCount.textContent = `${pending} pendiente${pending === 1 ? "" : "s"}`;
}

function updateCardBadge(card, photo) {
  const badge = $(".photo-validation", card);
  if (!badge) return;
  const pending = !String(photo.description || "").trim();
  badge.textContent = pending ? "Pendiente" : "Descripción lista";
  badge.className = `badge photo-validation ${pending ? "badge--warning" : "badge--success"}`;
}

function setPhotoSaveState(photoId, status, text) {
  const label = $(`.photo-save[data-photo-id="${CSS.escape(photoId)}"]`);
  if (!label) return;
  label.dataset.state = status;
  label.textContent = text;
}

function renderGallery() {
  const gallery = $("#photo-gallery");
  gallery.replaceChildren();
  updateSummary();
  updateProjectUi();

  if (!state.activeProjectId) {
    gallery.append(
      h("div", { className: "empty-state" }, [
        h("div", { className: "empty-state__icon", text: "＋" }),
        h("h3", { text: "Primero crea el proyecto" }),
        h("p", {
          text: "Completa los datos de la fiscalización y pulsa «Crear proyecto». Después podrás tomar o agregar fotografías.",
        }),
      ]),
    );
    return;
  }

  if (!state.photos.length) {
    gallery.append(
      h("div", { className: "empty-state" }, [
        h("div", { className: "empty-state__icon", text: "▣" }),
        h("h3", { text: "Todavía no hay fotografías" }),
        h("p", {
          text: "Usa «Tomar foto» en el celular o «Agregar imágenes» para incorporar las fotografías de práctica. Podrás revisarlas antes de confirmar.",
        }),
      ]),
    );
    return;
  }

  sortedPhotos().forEach((photo, index) => {
    gallery.append(createPhotoCard(photo, index));
  });
}

function createPhotoCard(photo, index) {
  const number = pad2(index + 1);
  const isActive = photo.id === state.selectedPhotoId;
  const pending = !String(photo.description || "").trim();
  const card = h("article", {
    className: `photo-card${isActive ? " photo-card--active" : ""}`,
    dataset: { photoId: photo.id },
  });

  const thumb = h(
    "button",
    {
      type: "button",
      className: "photo-card__thumb",
      "aria-label": `Ver la Foto N.º ${number}`,
      onclick: () => selectPhoto(photo.id),
    },
    h("img", {
      src: thumbUrl(photo),
      alt: `Miniatura de la Foto N.º ${number}`,
      loading: "lazy",
    }),
  );

  const title = h("h3", { className: "photo-card__title" }, [
    h("span", { className: "number-chip", text: number }),
    h("span", { text: `Foto N.º ${number}` }),
  ]);

  const badge = h("span", {
    className: `badge photo-validation ${pending ? "badge--warning" : "badge--success"}`,
    text: pending ? "Pendiente" : "Descripción lista",
  });

  const textareaId = `descripcion-${photo.id}`;
  const textarea = h("textarea", {
    id: textareaId,
    className: "photo-card__description",
    rows: "2",
    maxlength: "600",
    placeholder: "Describe qué se observa en la fotografía (obligatorio para exportar).",
    "aria-label": `Descripción de la Foto N.º ${number}`,
    "aria-invalid": state.invalidPhotoIds.has(photo.id) ? "true" : "false",
  });
  textarea.value = photo.description || "";

  textarea.addEventListener("input", () => {
    photo.description = textarea.value;
    if (textarea.value.trim()) {
      state.invalidPhotoIds.delete(photo.id);
      textarea.setAttribute("aria-invalid", "false");
    }
    updateCardBadge(card, photo);
    updateSummary();
    if (state.selectedPhotoId === photo.id) renderInspector();
    state.photoDirty = true;
    if (!state.projectDirty) setStatus("dirty", "Guardando descripción…");
    setPhotoSaveState(photo.id, "dirty", "Sin guardar");
    scheduleDescriptionSave(photo.id);
  });

  textarea.addEventListener("blur", () => {
    if (state.descriptionTimers.has(photo.id)) {
      clearTimeout(state.descriptionTimers.get(photo.id));
      state.descriptionTimers.delete(photo.id);
      persistDescription(photo.id);
    }
  });

  const saveLabel = h("span", {
    className: "photo-save",
    dataset: { photoId: photo.id, state: "saved" },
    text: "Guardado",
  });

  const up = h("button", {
    type: "button",
    className: "tool-btn",
    text: "↑",
    title: "Mover hacia arriba",
    "aria-label": `Mover la Foto N.º ${number} hacia arriba`,
    disabled: index === 0,
    onclick: () => movePhoto(photo.id, -1),
  });

  const down = h("button", {
    type: "button",
    className: "tool-btn",
    text: "↓",
    title: "Mover hacia abajo",
    "aria-label": `Mover la Foto N.º ${number} hacia abajo`,
    disabled: index === state.photos.length - 1,
    onclick: () => movePhoto(photo.id, 1),
  });

  const remove = h("button", {
    type: "button",
    className: "tool-btn tool-btn--danger",
    text: "✕",
    title: "Eliminar fotografía",
    "aria-label": `Eliminar la Foto N.º ${number}`,
    onclick: () => deletePhotoWithConfirmation(photo.id),
  });

  card.append(
    thumb,
    h("div", { className: "photo-card__content" }, [
      h("div", { className: "photo-card__heading" }, [title, badge]),
      h("p", {
        className: "photo-meta",
        text: `Incorporada: ${formatAddedAt(photo.addedAt)} · ${photo.width} × ${photo.height} px`,
      }),
      textarea,
      h("div", { className: "photo-card__footer" }, [
        saveLabel,
        h("div", { className: "photo-card__tools" }, [up, down, remove]),
      ]),
    ]),
  );

  return card;
}

function selectPhoto(photoId) {
  state.selectedPhotoId = photoId;
  $$(".photo-card").forEach((card) => {
    card.classList.toggle("photo-card--active", card.dataset.photoId === photoId);
  });
  renderInspector();
}

function scheduleDescriptionSave(photoId) {
  const existing = state.descriptionTimers.get(photoId);
  if (existing) clearTimeout(existing);
  const timer = window.setTimeout(() => {
    state.descriptionTimers.delete(photoId);
    persistDescription(photoId);
  }, 700);
  state.descriptionTimers.set(photoId, timer);
}

async function persistDescription(photoId) {
  const photo = state.photos.find((item) => item.id === photoId);
  if (!photo) return;
  setPhotoSaveState(photoId, "saving", "Guardando…");
  if (!state.projectDirty) setStatus("saving", "Guardando descripción…");

  let failed = false;
  const task = db
    .savePhoto(photo)
    .then(() => {
      if (!state.photos.some((item) => item.id === photoId)) return;
      setPhotoSaveState(photoId, "saved", "Guardado");
    })
    .catch((error) => {
      failed = true;
      console.error("No se pudo guardar la descripción:", error);
      setPhotoSaveState(photoId, "error", "Error al guardar");
      setStatus("error", "Error al guardar descripción");
      toast(`No se pudo guardar la descripción: ${db.formatDatabaseError(error)}`, "error", 6500);
    })
    .finally(() => {
      state.photoSavePromises.delete(task);
      if (
        !failed &&
        !state.projectDirty &&
        state.descriptionTimers.size === 0 &&
        state.photoSavePromises.size === 0
      ) {
        state.photoDirty = false;
        setStatus("saved", "Descripción guardada");
      }
    });

  state.photoSavePromises.add(task);
  await task;
}

async function flushPhotoSaves() {
  const ids = [...state.descriptionTimers.keys()];
  ids.forEach((photoId) => {
    clearTimeout(state.descriptionTimers.get(photoId));
    state.descriptionTimers.delete(photoId);
  });
  if (ids.length) {
    await Promise.all(ids.map((photoId) => persistDescription(photoId)));
  }
  if (state.photoSavePromises.size) {
    await Promise.allSettled([...state.photoSavePromises]);
  }
}

async function movePhoto(photoId, direction) {
  if (state.reordering) return;
  const photos = sortedPhotos();
  const index = photos.findIndex((photo) => photo.id === photoId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= photos.length) return;

  state.reordering = true;
  const previous = state.photos.map((photo) => ({ ...photo }));
  const [moved] = photos.splice(index, 1);
  photos.splice(target, 0, moved);
  photos.forEach((photo, position) => {
    photo.order = position;
  });
  state.photos = photos;

  try {
    setStatus("saving", "Guardando orden…");
    await db.savePhotos(state.photos);
    renderGallery();
    renderInspector();
    setStatus(state.projectDirty ? "dirty" : "saved", state.projectDirty ? "Cambios sin guardar" : "Orden guardado");
    toast("Orden actualizado y numeración recalculada.", "success", 2600);
  } catch (error) {
    console.error("No se pudo guardar el nuevo orden:", error);
    state.photos = previous;
    renderGallery();
    renderInspector();
    setStatus("error", "Error al guardar orden");
    showAlert({
      title: "No se pudo cambiar el orden",
      message: db.formatDatabaseError(error),
      tone: "error",
    });
  } finally {
    state.reordering = false;
  }
}

async function deletePhotoWithConfirmation(photoId) {
  const sorted = sortedPhotos();
  const index = sorted.findIndex((photo) => photo.id === photoId);
  if (index < 0) return;
  const number = pad2(index + 1);

  const proceed = await confirmAction({
    title: `¿Eliminar la Foto N.º ${number}?`,
    message:
      "La fotografía y su descripción se eliminarán de este proyecto. La numeración de las demás se actualizará automáticamente. Esta acción no se puede deshacer.",
    confirmLabel: "Eliminar fotografía",
  });
  if (!proceed) return;

  try {
    await flushPhotoSaves();
    const remaining = sorted.filter((photo) => photo.id !== photoId);
    remaining.forEach((photo, position) => {
      photo.order = position;
    });
    await db.deletePhotoAndReindex(photoId, remaining);

    revokePhotoUrls(photoId);
    state.photos = remaining;
    state.invalidPhotoIds.delete(photoId);
    if (state.selectedPhotoId === photoId) {
      state.selectedPhotoId = remaining[Math.min(index, remaining.length - 1)]?.id || null;
    }
    renderGallery();
    renderInspector();
    setStatus("saved", "Fotografía eliminada");
    toast("Fotografía eliminada. La numeración fue actualizada.", "success");
    updateStorageInfo();
  } catch (error) {
    console.error("No se pudo eliminar la fotografía:", error);
    setStatus("error", "Error al eliminar");
    showAlert({
      title: "No se pudo eliminar la fotografía",
      message: db.formatDatabaseError(error),
      tone: "error",
    });
  }
}

/* ---------- Inspector y vista previa ---------- */

function renderInspector() {
  const body = $("#inspector-body");
  const positionBadge = $("#photo-position");
  body.replaceChildren();

  const photo = selectedPhoto();
  if (!photo) {
    positionBadge.textContent = "Sin selección";
    body.append(
      h("div", { className: "empty-state empty-state--small" }, [
        h("div", { className: "empty-state__icon", text: "◫" }),
        h("p", {
          text: state.activeProjectId
            ? "Agrega o selecciona una fotografía para revisar su descripción y apariencia en el anexo."
            : "Abre o crea un proyecto para ver sus fotografías.",
        }),
      ]),
    );
    return;
  }

  const index = sortedPhotos().findIndex((item) => item.id === photo.id);
  const number = pad2(index + 1);
  positionBadge.textContent = `Foto ${number} de ${pad2(state.photos.length)}`;
  const description = String(photo.description || "").trim();

  const image = h("img", {
    className: "inspector__image",
    src: fullUrl(photo),
    alt: description ? `Foto N.º ${number}: ${description}` : `Foto N.º ${number} sin descripción`,
  });

  const details = h("div", { className: "inspector__details" }, [
    h("p", { className: "inspector__caption" }, [
      h("strong", { text: `Foto N.º ${number}` }),
      h("br"),
      h("span", {
        className: description ? "" : "text-warning",
        text: description || "Descripción pendiente para exportar.",
      }),
    ]),
    h("p", { className: "inspector__meta" }, [
      `Incorporada: ${formatAddedAt(photo.addedAt)}`,
      h("br"),
      `${photo.width} × ${photo.height} px · ${formatBytes(photo.blob?.size || 0)}`,
      h("br"),
      `Archivo original: ${photo.originalName || "sin nombre"}`,
      h("br"),
      "La fecha de incorporación no certifica la fecha de captura.",
    ]),
  ]);

  body.append(image, details, buildMiniAnexo(photo, number));
}

function buildMiniAnexo(photo, number) {
  const project = currentProjectForDisplay();
  const table = h("table", { className: "anexo-mini__table" });
  table.append(
    h("tr", {}, [
      h("td", {
        colspan: "2",
        className: "anexo-mini__header",
        text: `FOTOGRAFÍAS DE FECHA ${formatLongDateUpper(project?.fechaFiscalizacion) || "SIN FECHA"}`,
      }),
    ]),
    h("tr", {}, [
      h(
        "td",
        { colspan: "2", className: "anexo-mini__image" },
        h("img", {
          src: fullUrl(photo),
          alt: `Vista de la Foto N.º ${number} en el anexo`,
        }),
      ),
    ]),
    h("tr", {}, [
      h("td", { className: "anexo-mini__num", text: `Foto N.º ${number}` }),
      h("td", {
        className: "anexo-mini__text",
        text: String(photo.description || "").trim() || "Descripción pendiente",
      }),
    ]),
  );

  return h("div", { className: "anexo-mini" }, [
    h("p", { className: "anexo-mini__title", text: "Así se verá en el anexo" }),
    table,
  ]);
}

function renderAnexoPreview() {
  const container = $("#anexo-preview");
  container.replaceChildren();
  const project = currentProjectForDisplay();
  if (!project) return;

  const errors = validateExportData(project, sortedPhotos());
  if (errors.length) {
    const previewError = h("div", { className: "anexo-preview-alert" }, [
      h("strong", { text: "La vista previa contiene datos incompletos. " }),
      h("span", {
        text: "Completa los campos y descripciones marcados antes de generar el Word.",
      }),
    ]);
    container.append(previewError);
  }

  const pages = [];
  const photos = sortedPhotos();
  for (let index = 0; index < Math.max(photos.length, 1); index += 2) {
    pages.push(photos.slice(index, index + 2));
  }

  pages.forEach((pagePhotos, pageIndex) => {
    const page = h("section", {
      className: "anexo-page",
      "aria-label": `Página ${pageIndex + 1} de la vista previa`,
    });

    if (pageIndex === 0) {
      page.append(
        h("p", { className: "anexo-page__brand", text: "Registro de fiscalización de práctica" }),
        h("p", { className: "anexo-page__title", text: "ANEXO FOTOGRÁFICO" }),
        h("p", {
          className: "anexo-page__subtitle",
          text: project.establecimiento || "Establecimiento sin completar",
        }),
        buildPreviewInfoTable(project),
      );
    }

    page.append(
      h("div", {
        className: "anexo-page__date",
        text: `FOTOGRAFÍAS DE FECHA ${formatLongDateUpper(project.fechaFiscalizacion) || "SIN FECHA"}`,
      }),
    );

    const table = h("table", { className: "anexo-preview-table" });
    if (!pagePhotos.length) {
      table.append(
        h("tr", {}, [
          h("td", {
            colspan: "2",
            className: "anexo-preview-table__desc anexo-preview-table__empty",
            text: "Aún no hay fotografías en este proyecto.",
          }),
        ]),
      );
    } else {
      pagePhotos.forEach((photo, position) => {
        const number = pad2(pageIndex * 2 + position + 1);
        const description = String(photo.description || "").trim();
        table.append(
          h("tr", {}, [
            h(
              "td",
              { colspan: "2", className: "anexo-preview-table__image" },
              h("img", {
                src: fullUrl(photo),
                alt: description ? `Foto N.º ${number}: ${description}` : `Foto N.º ${number}`,
              }),
            ),
          ]),
          h("tr", {}, [
            h("td", { className: "anexo-preview-table__num", text: `Foto N.º ${number}` }),
            h("td", {
              className: `anexo-preview-table__desc${description ? "" : " anexo-preview-table__empty"}`,
              text: description || "Descripción pendiente",
            }),
          ]),
        );
      });
    }

    page.append(
      table,
      h("p", { className: "anexo-page__page-number", text: `Página ${pageIndex + 1}` }),
    );
    container.append(page);
  });
}

function buildPreviewInfoTable(project) {
  const label = (text) => h("td", { className: "anexo-page__label", text });
  const value = (text) => h("td", { text: text || "Sin completar" });
  const table = h("table", { className: "anexo-page__info" });
  table.append(
    h("tr", {}, [
      label("Código de práctica"),
      value(project.codigoPractica),
      label("Fecha de fiscalización"),
      value(formatShortDate(project.fechaFiscalizacion) || project.fechaFiscalizacion),
    ]),
    h("tr", {}, [
      label("Fiscalizador"),
      value(project.fiscalizador),
      label("Lugar"),
      value(project.lugar),
    ]),
    h("tr", {}, [
      label("Establecimiento / unidad"),
      h("td", { colspan: "3", text: project.establecimiento || "Sin completar" }),
    ]),
  );
  return table;
}

/* ---------- Captura e incorporación ---------- */

async function handleSelectedFiles(fileList) {
  if (state.processingFiles) return;
  if (!state.activeProjectId) {
    showAlert({
      title: "Primero guarda el proyecto",
      message: "Las fotografías deben pertenecer a un proyecto guardado. Crea el proyecto y vuelve a intentarlo.",
      tone: "warning",
    });
    return;
  }

  const files = Array.from(fileList || []);
  if (!files.length) return;

  const entries = [];
  const errors = [];
  for (const file of files) {
    try {
      const dimensions = await inspectImageFile(file);
      entries.push({
        id: newId("archivo"),
        file,
        previewUrl: URL.createObjectURL(file),
        description: "",
        width: dimensions.width,
        height: dimensions.height,
      });
    } catch (error) {
      console.warn("Archivo omitido:", error);
      errors.push(error.message);
    }
  }

  state.pendingEntries = entries;

  if (!entries.length) {
    showAlert({
      kicker: "Archivos no admitidos",
      title: "No se pudo incorporar ninguna imagen",
      message: "Selecciona archivos de imagen válidos (JPG, PNG, WebP u otro formato compatible con el navegador).",
      details: errors,
      tone: "error",
    });
    return;
  }

  if (errors.length) {
    toast(`Se omitieron ${errors.length} archivo(s) no válido(s).`, "warning", 6000);
  }
  renderFilePreview();
  openDialog($("#dialog-files"));
}

function renderFilePreview() {
  const list = $("#file-preview-list");
  list.replaceChildren();
  const count = state.pendingEntries.length;
  $("#file-preview-count").textContent = `${count} ${count === 1 ? "imagen lista" : "imágenes listas"} para incorporar.`;
  $("#btn-confirm-files").disabled = count === 0;

  if (!count) {
    list.append(
      h("div", { className: "empty-state" }, [
        h("h3", { text: "No quedan imágenes" }),
        h("p", { text: "Cierra esta ventana y selecciona otras fotografías." }),
      ]),
    );
    return;
  }

  state.pendingEntries.forEach((entry) => {
    const descriptionId = `desc-nueva-${entry.id}`;
    const textarea = h("textarea", {
      id: descriptionId,
      rows: "2",
      maxlength: "600",
      placeholder: "Descripción inicial (opcional por ahora)",
    });
    textarea.value = entry.description;
    textarea.addEventListener("input", () => {
      entry.description = textarea.value;
    });

    const remove = h("button", {
      type: "button",
      className: "tool-btn tool-btn--danger file-preview-item__remove",
      text: "✕",
      title: "Quitar de la selección",
      "aria-label": `Quitar ${entry.file.name}`,
      onclick: () => {
        if (state.processingFiles) return;
        URL.revokeObjectURL(entry.previewUrl);
        state.pendingEntries = state.pendingEntries.filter((item) => item.id !== entry.id);
        renderFilePreview();
      },
    });

    list.append(
      h("div", { className: "file-preview-item" }, [
        h(
          "div",
          { className: "file-preview-item__image" },
          h("img", { src: entry.previewUrl, alt: `Vista previa de ${entry.file.name}` }),
        ),
        h("div", { className: "file-preview-item__body" }, [
          h("p", { className: "file-preview-item__name", text: entry.file.name, title: entry.file.name }),
          h("p", {
            className: "file-preview-item__size",
            text: `${formatBytes(entry.file.size)} · ${entry.width} × ${entry.height} px`,
          }),
          h("label", { for: descriptionId, text: "Descripción inicial" }),
          textarea,
        ]),
        remove,
      ]),
    );
  });
}

async function confirmFileIncorporation() {
  if (state.processingFiles || !state.pendingEntries.length) return;
  const dialog = $("#dialog-files");
  const entries = [...state.pendingEntries];
  const confirmButton = $("#btn-confirm-files");
  const closeButtons = $$("[data-close-dialog]", dialog);

  state.processingFiles = true;
  closeButtons.forEach((button) => {
    button.disabled = true;
  });
  setButtonBusy(confirmButton, true, "Procesando imágenes…");
  setStatus("saving", "Procesando imágenes…");

  const prepared = [];
  const errors = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    confirmButton.textContent = `Procesando ${index + 1} de ${entries.length}…`;
    try {
      const processed = await preparePhotoFile(entry.file);
      prepared.push({ ...processed, description: entry.description.trim() });
    } catch (error) {
      console.warn("No se pudo procesar una imagen:", error);
      errors.push(error.message);
    }
  }

  try {
    if (prepared.length) {
      const maxOrder = state.photos.reduce(
        (max, photo) => Math.max(max, Number(photo.order) || 0),
        -1,
      );
      const addedAt = new Date().toISOString();
      const newPhotos = prepared.map((item, index) => ({
        id: newId("foto"),
        projectId: state.activeProjectId,
        blob: item.blob,
        thumbnailBlob: item.thumbnailBlob,
        width: item.width,
        height: item.height,
        originalWidth: item.originalWidth,
        originalHeight: item.originalHeight,
        originalName: item.originalName,
        originalType: item.originalType,
        originalSize: item.originalSize,
        mimeType: item.mimeType,
        description: item.description,
        addedAt,
        order: maxOrder + 1 + index,
      }));

      await db.savePhotos(newPhotos);
      state.photos.push(...newPhotos);
      state.selectedPhotoId = newPhotos[0].id;
      entries.forEach((entry) => URL.revokeObjectURL(entry.previewUrl));
      state.pendingEntries = [];
      renderGallery();
      renderInspector();
      setStatus("saved", "Fotografías incorporadas");
      toast(
        `${newPhotos.length} fotografía${newPhotos.length === 1 ? "" : "s"} incorporada${newPhotos.length === 1 ? "" : "s"} al proyecto.`,
        "success",
      );
      updateStorageInfo();
    }

    state.processingFiles = false;
    setButtonBusy(confirmButton, false);
    closeButtons.forEach((button) => {
      button.disabled = false;
    });
    closeDialog(dialog, prepared.length ? "incorporated" : "cancel");
    $("#file-preview-list").replaceChildren();
    $("#file-preview-count").textContent = "";

    if (errors.length) {
      showAlert({
        kicker: prepared.length ? "Incorporación parcial" : "Error de lectura",
        title: prepared.length
          ? "Algunas imágenes no se pudieron incorporar"
          : "No se pudo incorporar ninguna imagen",
        message: prepared.length
          ? "Las imágenes válidas se guardaron correctamente. Revisa los archivos omitidos:"
          : "Ninguna de las imágenes seleccionadas se pudo procesar.",
        details: errors,
        tone: "error",
      });
    }
  } catch (error) {
    console.error("No se pudieron guardar las fotografías:", error);
    state.processingFiles = false;
    setButtonBusy(confirmButton, false);
    closeButtons.forEach((button) => {
      button.disabled = false;
    });
    setStatus("error", "Error al guardar fotografías");
    showAlert({
      title: "No se pudieron guardar las fotografías",
      message: db.formatDatabaseError(error),
      details: ["La selección sigue abierta para que puedas intentarlo nuevamente o quitar algunas imágenes."],
      tone: "error",
    });
  }
}

/* ---------- Word ---------- */

function setExportBusy(busy) {
  state.exporting = busy;
  setButtonBusy($("#btn-word"), busy, "Generando Word…");
  const previewButton = $("#btn-word-preview");
  setButtonBusy(previewButton, busy, "Generando Word…");
  $("#btn-preview").disabled = busy || !state.activeProjectId;
}

function markExportProblems(errors, photos) {
  const missingDescription = errors.some((error) => error.includes("descripción"));
  if (!missingDescription && !photos.some((photo) => !String(photo.description || "").trim())) {
    return;
  }
  state.invalidPhotoIds.clear();
  photos.forEach((photo) => {
    if (!String(photo.description || "").trim()) state.invalidPhotoIds.add(photo.id);
  });
  renderGallery();
  const firstInvalid = $(".photo-card__description[aria-invalid='true']");
  if (firstInvalid) {
    firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
    firstInvalid.focus({ preventScroll: true });
  }
}

async function exportWord() {
  if (state.exporting) return;

  if (!state.activeProjectId) {
    showAlert({
      title: "No hay un proyecto activo",
      message: "Crea y guarda un proyecto antes de generar el anexo fotográfico.",
      tone: "warning",
    });
    return;
  }

  if (state.projectDirty) {
    const saved = await saveProjectData({ quiet: true });
    if (!saved) return;
  }

  await flushPhotoSaves();

  const project = getActiveProject();
  const photos = sortedPhotos();
  const errors = validateExportData(project, photos);

  if (errors.length) {
    validateProjectForm();
    markExportProblems(errors, photos);
    showAlert({
      kicker: "Exportación detenida",
      title: "No se puede generar el Word",
      message:
        "Corrige los siguientes campos o fotografías. No se generó ningún archivo para evitar un anexo incompleto.",
      details: errors,
      tone: "error",
    });
    return;
  }

  setExportBusy(true);
  setStatus("saving", "Generando archivo Word…");

  try {
    // Permite que la interfaz pinte el estado antes de comprimir y empaquetar.
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    const { blob, fileName } = await buildDocx(project, photos);
    downloadBlob(blob, fileName);
    setStatus("saved", "Word generado");
    toast(`Word generado: ${fileName}`, "success", 8000);
  } catch (error) {
    console.error("No se pudo generar el DOCX:", error);
    setStatus("error", "Error al generar Word");
    if (error instanceof ExportValidationError) {
      showAlert({
        kicker: "Exportación detenida",
        title: "Faltan datos para el Word",
        details: error.errors,
        tone: "error",
      });
    } else {
      showAlert({
        title: "No se pudo generar el archivo Word",
        message:
          "Ocurrió un problema al crear el documento. Revisa que las imágenes estén disponibles y vuelve a intentarlo.",
        details: ["Detalle técnico registrado en la consola del navegador."],
        tone: "error",
      });
    }
  } finally {
    setExportBusy(false);
  }
}

async function updateStorageInfo() {
  const info = await db.getStorageInfo();
  if (!info || !Number.isFinite(info.usage)) return;
  $("#storage-note").textContent = `Uso local aproximado: ${formatBytes(info.usage)}. La fecha de incorporación no certifica la fecha de captura original.`;
}

function renderAll() {
  renderProjectSelect();
  updateProjectUi();
  renderGallery();
  renderInspector();
}

/* ---------- Eventos ---------- */

function bindEvents() {
  $("#btn-new-project").addEventListener("click", () => startNewProject());
  $("#btn-save-project").addEventListener("click", () => saveProjectData());
  $("#project-select").addEventListener("change", handleProjectSelect);

  $("#project-form").addEventListener("input", (event) => {
    if (!event.target.matches("input")) return;
    event.target.removeAttribute("aria-invalid");
    markProjectDirty();
  });

  $("#project-form").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveProjectData();
    }
  });

  $("#btn-camera").addEventListener("click", () => {
    if (!state.activeProjectId) return;
    const input = $("#input-camera");
    input.value = "";
    input.click();
  });

  $("#btn-files").addEventListener("click", () => {
    if (!state.activeProjectId) return;
    const input = $("#input-files");
    input.value = "";
    input.click();
  });

  ["#input-camera", "#input-files"].forEach((selector) => {
    const input = $(selector);
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.value = "";
      if (files.length) handleSelectedFiles(files);
    });
    input.addEventListener("cancel", () => {
      toast("Se canceló la selección. No se agregaron imágenes.", "info", 3500);
    });
  });

  $("#btn-confirm-files").addEventListener("click", confirmFileIncorporation);

  $("#dialog-files").addEventListener("close", () => {
    if (state.processingFiles) return;
    if (state.pendingEntries.length) {
      state.pendingEntries.forEach((entry) => URL.revokeObjectURL(entry.previewUrl));
      state.pendingEntries = [];
    }
    $("#file-preview-list").replaceChildren();
    $("#file-preview-count").textContent = "";
  });

  $("#dialog-files").addEventListener("cancel", (event) => {
    if (state.processingFiles) event.preventDefault();
  });

  $("#btn-preview").addEventListener("click", () => {
    if (!state.activeProjectId) return;
    renderAnexoPreview();
    openDialog($("#dialog-preview"));
  });

  $("#btn-word").addEventListener("click", exportWord);
  $("#btn-word-preview").addEventListener("click", () => {
    closeDialog($("#dialog-preview"));
    exportWord();
  });

  $("#btn-confirm-action").addEventListener("click", () => closeDialog($("#dialog-confirm"), "confirm"));
  $$("[data-cancel-confirm]").forEach((button) => {
    button.addEventListener("click", () => closeDialog($("#dialog-confirm"), "cancel"));
  });

  $$("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = button.closest("dialog");
      closeDialog(dialog);
    });
  });

  window.addEventListener("beforeunload", (event) => {
    const pendingSaves = state.descriptionTimers.size > 0 || state.photoSavePromises.size > 0;
    if (state.projectDirty || state.photoDirty || pendingSaves) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPhotoSaves();
  });

  window.addEventListener("db-versionchange", () => {
    state.ready = false;
    setStatus("error", "Almacenamiento actualizado en otra pestaña");
    updateProjectUi();
    showAlert({
      title: "La base de datos cambió en otra pestaña",
      message: "Recarga esta página para seguir trabajando sin perder datos.",
      tone: "warning",
    });
  });
}

async function init() {
  bindEvents();
  $("#fecha").value = todayValue();
  $("#btn-save-project").disabled = true;
  updateProjectUi();
  setStatus("saving", "Iniciando almacenamiento…");

  try {
    await db.openDatabase();
    state.ready = true;
    await refreshProjects();

    const lastProjectId = readLastProjectId();
    const target =
      state.projects.find((project) => project.id === lastProjectId) || state.projects[0] || null;

    if (target) {
      await loadProject(target.id, { skipPrompt: true, silent: true });
    } else {
      startNewProject({ skipPrompt: true, focus: false });
    }

    updateProjectUi();
    updateStorageInfo();
  } catch (error) {
    console.error("No se pudo iniciar IndexedDB:", error);
    state.ready = false;
    setStatus("error", "Almacenamiento no disponible");
    updateProjectUi();
    showAlert({
      kicker: "Almacenamiento no disponible",
      title: "No se pudo acceder a IndexedDB",
      message: db.formatDatabaseError(error),
      details: [
        "La aplicación necesita IndexedDB para guardar proyectos y fotografías.",
        "Si estás en una ventana privada, prueba en una ventana normal. También revisa que el navegador permita datos para este sitio.",
      ],
      tone: "error",
    });
  }
}

init();

