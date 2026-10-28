# Fiscalización fotográfica · Anexo Word

Aplicación web para registrar fiscalizaciones de práctica y generar un **anexo fotográfico en Word** (`.docx`) con las fotografías de cada proyecto. Funciona por completo en el navegador: no tiene backend, autenticación ni servicios en la nube.

## Contenido

- [Qué hace](#qué-hace)
- [Requisitos](#requisitos)
- [Instalación y ejecución](#instalación-y-ejecución)
- [Cómo se usa](#cómo-se-usa)
- [Dónde se guardan los datos](#dónde-se-guardan-los-datos)
- [Tratamiento de las imágenes](#tratamiento-de-las-imágenes)
- [Formato del documento Word](#formato-del-documento-word)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Pruebas realizadas](#pruebas-realizadas)
- [Limitaciones y advertencias](#limitaciones-y-advertencias)
- [Créditos](#créditos)

---

## Qué hace

- Crea **proyectos independientes** con estos datos obligatorios:
  - código de práctica,
  - fecha de fiscalización,
  - fiscalizador,
  - lugar,
  - establecimiento o unidad fiscalizada (denominación ficticia).
- Incorpora fotografías desde la cámara del dispositivo o desde archivos.
- Muestra una **vista previa antes de confirmar** la incorporación; permite quitar imágenes y escribir una descripción inicial.
- Permite editar la descripción de cada foto, con **guardado automático**.
- Permite **reordenar** y **eliminar** fotografías con confirmación; la numeración (`Foto N.º 01`, `02`, …) se recalcula sola.
- Conserva las fotografías de cada proyecto en **IndexedDB**, incluso al recargar o cerrar el navegador.
- Valida todos los datos antes de exportar y bloquea la generación si falta algo.
- Genera un **DOCX real** con las imágenes incrustadas, listo para abrir en Microsoft Word.
- Se adapta a escritorio, tableta y teléfono.

## Requisitos

- **Node.js 20.19+ o 22.12+** (requisito de Vite 8). Desarrollado y probado con Node.js 22.23.2.
- npm 10+.
- Navegador moderno con soporte de IndexedDB (Chrome, Edge, Firefox o Safari recientes).
- Para usar la cámara en un teléfono, la app debe servirse por **HTTPS** o desde `localhost`. Los navegadores no permiten acceder a la cámara desde una IP HTTP en producción.

> El proyecto no incluye `node_modules`. Instálalos con `npm install`.

## Instalación y ejecución

```bash
npm install
npm run dev
```

Vite mostrará la URL local, normalmente `http://localhost:5173`.

Para probar desde un teléfono en la misma red:

```bash
npm run dev
# abrir la URL "Network" que muestra Vite
```

La cámara puede no estar disponible por HTTP; en ese caso usa «Agregar imágenes» o publica la app con HTTPS.

### Compilar para producción

```bash
npm run build     # genera dist/
npm run preview   # sirve dist/ localmente
```

El resultado de `dist/` es estático: puede alojarse en cualquier servidor de archivos, sin backend.

## Cómo se usa

1. **Completa los datos** del proyecto y pulsa «Crear proyecto». El proyecto queda guardado en el navegador.
2. Pulsa **«Tomar foto»** (móvil) o **«Agregar imágenes»** (galería/archivos).
3. En la ventana de revisión puedes:
   - quitar imágenes de la selección,
   - escribir una descripción inicial,
   - confirmar la incorporación.
4. Edita las descripciones en las tarjetas. El estado «Guardado» indica que el cambio se escribió en IndexedDB.
5. Usa las flechas **↑ / ↓** para cambiar el orden y **✕** para eliminar (siempre pide confirmación).
6. Pulsa **«Vista previa»** para ver cómo se repartirán las fotos, dos por página.
7. Pulsa **«Generar Word»**. Si falta un dato o una descripción, la exportación se detiene y se indica qué corregir.
8. El archivo se descarga como `Anexo-fotografico-<código>.docx`.

Para volver a un proyecto anterior, selecciónalo en la lista «Proyecto». La app recuerda el último proyecto abierto.

## Dónde se guardan los datos

Todo se guarda **solo en este navegador**:

| Dato | Ubicación |
| --- | --- |
| Proyectos (datos del formulario) | IndexedDB, base `fiscalizacion-fotografica`, almacén `projects` |
| Fotografías y miniaturas | IndexedDB, almacén `photos` |
| Último proyecto abierto | `localStorage`, clave `fiscalizacion-fotografica:ultimo-proyecto` (solo el id) |

Consecuencias importantes:

- Los datos **no se sincronizan** entre dispositivos ni navegadores.
- Si borras los datos del sitio, usas una ventana privada o el navegador limpia el almacenamiento, **se pierden los proyectos y las fotos**. Descarga el Word de cada práctica cuando termines.
- Cada perfil de navegador tiene su propia base. Abrir la app en otro navegador equivale a empezar de cero.
- IndexedDB tiene una cuota; si se llena, la app muestra un error y sugiere eliminar fotografías o proyectos antiguos.
- La base **no está cifrada**. Cualquier persona con acceso al perfil del navegador puede leerla.

## Tratamiento de las imágenes

- Se aceptan archivos que el navegador pueda decodificar y que no superen **25 MB**.
- Antes de guardar, cada imagen se normaliza:
  - se reduce para que su lado mayor no pase de **1600 px**,
  - se convierte a **JPEG** con calidad 0.86,
  - se genera una **miniatura** de 420 px para la galería.
- Se conservan las dimensiones y los metadatos del archivo original (nombre, tipo y tamaño), pero **no se guarda el archivo original**.
- Al pasar por un `canvas`, se pierden los metadatos EXIF (incluida la fecha de captura y la geolocalización).
- La fecha que muestra la app es la de **incorporación a la aplicación**, no la de captura. La interfaz lo advierte de forma explícita.
- La app **no certifica** que una foto haya sido tomada en la fecha de fiscalización.
- Formatos como HEIC dependen del soporte del navegador; en algunos equipos deberán convertirse antes de subirlos.
- Las imágenes se incrustan en el DOCX; el archivo Word no depende de las rutas del dispositivo.

## Formato del documento Word

El DOCX se construye con la librería [`docx`](https://docx.js.org/) y cumple lo solicitado:

- **A4 vertical** (210 × 297 mm).
- Márgenes de **2.54 cm** en los cuatro lados.
- Tipografía **Poppins 8 pt** para el cuerpo (título a 14 pt).
- Tabla continua de **dos columnas**:
  - numeración: **3 cm**,
  - descripción: **12.92 cm**,
  - ancho total: 15.94 cm (21 − 2 × 2.54).
- Fila de imagen combinada (las dos columnas) con alto fijo de **77 mm**.
- Las imágenes se escalan sin deformarse (máximo 565 × 278 px dentro de la celda).
- La fila de cabecera `FOTOGRAFÍAS DE FECHA …` se repite en cada página.
- `cantSplit` y `keepNext` evitan que una imagen quede separada de su descripción.
- Se incluyen **dos fotografías por página**; con 6 fotos se obtienen 3 páginas (comprobado en Word).
- Se añade un bloque inicial con título y datos de la fiscalización (código, fecha, fiscalizador, lugar y establecimiento), porque el formato de referencia solo contenía la cabecera de fecha y esos datos habrían quedado fuera del documento.
- Las imágenes se incrustan como JPEG; el DOCX no enlaza archivos externos.

### Sobre la fuente Poppins

El DOCX declara la fuente **Poppins**, pero **no incrusta el archivo de la fuente** (Word no lo requiere y `docx` no la embebe). Si el equipo donde se abre el documento no tiene Poppins instalada, Word sustituirá la fuente y el aspecto puede variar ligeramente.

- La interfaz web sí incluye Poppins mediante `@fontsource`, así que la pantalla se ve correcta sin instalar nada.
- Para que el Word se vea exactamente igual, instala Poppins en el sistema desde [Google Fonts](https://fonts.google.com/specimen/Poppins).

### Diferencias con `referencias/formato_anexo.docx`

- La referencia usa márgenes de 2.5 / 3 cm; aquí se aplican **2.54 cm** porque así se pidió de forma explícita.
- La referencia solo tiene la cabecera de fecha. Se agregó el bloque de datos porque el enunciado exige registrar código, fecha, lugar, fiscalizador y establecimiento.
- La columna de numeración se estrechó a 3 cm y la de descripción se amplió en consecuencia.

Los archivos de `referencias/` **no se modificaron**.

## Estructura del proyecto

```
.
├─ index.html              Interfaz y diálogos
├─ css/
│  └─ estilos.css          Diseño responsive (escritorio, tableta, móvil)
├─ js/
│  ├─ app.js               Estado, eventos, galería, vista previa y exportación
│  ├─ db.js                IndexedDB: proyectos, fotos, orden y errores
│  ├─ images.js            Validación, compresión, miniaturas y dimensiones
│  └─ word.js              Validación y construcción del DOCX
├─ pruebas/
│  └─ e2e.mjs              Prueba de extremo a extremo con Playwright
├─ referencias/            Material de referencia (solo lectura)
├─ package.json
└─ README.md
```

## Pruebas realizadas

### Prueba automatizada de extremo a extremo

```bash
npm run test:e2e
```

Si es la primera vez que se usa Playwright en el equipo:

```bash
npx playwright install chromium
```

La prueba:

- inicia Vite en el puerto 4319 (o reutiliza uno ya activo),
- abre Chromium en modo headless con un perfil limpio,
- genera **imágenes sintéticas en memoria** (no hay fotos reales ni archivos de prueba en el repositorio),
- recorre el flujo completo y comprueba el DOCX descargado leyendo su ZIP interno, sin dependencias adicionales.

Verificaciones incluidas:

| # | Verificación |
| --- | --- |
| 1 | Estado inicial: proyecto nuevo, fecha de hoy y acciones de fotos deshabilitadas |
| 2 | Validación de los 5 campos obligatorios |
| 3 | Creación y guardado del proyecto |
| 4 | Vista previa de archivos: quitar imágenes y cancelar sin incorporar |
| 5 | Incorporación de 6 fotos con numeración 01–06 |
| 6 | Descripciones con guardado automático |
| 7 | Persistencia de proyecto, fotos y descripciones al recargar |
| 8 | Reordenamiento persistente y numeración recalculada |
| 9 | Cancelar y confirmar la eliminación; numeración continua |
| 10 | Añadir otra foto y completar su descripción |
| 11 | Segundo proyecto sin fotos heredadas |
| 12 | Exportación bloqueada si no hay fotografías |
| 13 | Exportación bloqueada si falta una descripción, con el campo marcado |
| 14 | Aislamiento al reabrir cada proyecto |
| 15 | Vista previa: 3 páginas, 6 imágenes, numeración correcta |
| 16 | DOCX válido: 6 imágenes incrustadas, A4, márgenes de 2.54 cm, Poppins 8 pt, cabecera repetida y filas de 77 mm |
| 17 | Vista móvil a 390 px sin desbordamiento horizontal ni huecos en la barra |
| 18 | Sin errores de JavaScript ni de consola durante el recorrido |

**Resultado de la última ejecución (27/10/2026): 18/18 verificaciones superadas**, con Node.js 22.23.2, Playwright 1.64.1 y Chromium 156 en Windows.

El DOCX de la prueba se guarda en la carpeta temporal del sistema (`%TEMP%\fiscalizacion-fotografica-e2e`) y no forma parte del proyecto.

### Comprobaciones manuales

- Se abrió el DOCX generado con **Microsoft Word** (Office 16) y se exportó a PDF: **3 páginas para 6 fotos**, dos fotos por página.
- Se revisó visualmente que cada imagen quede junto a su número y descripción, que la cabecera de fecha se repita y que no haya recortes ni deformaciones.
- Se inspeccionó el ZIP del DOCX: 6 archivos en `word/media/`, XML con `pgSz` A4, `pgMar` de 1440 twips (2.54 cm), fuente Poppins, `tblHeader`, `cantSplit` y filas de 4365 twips.
- Se compiló con `npm run build` y se repitió una creación + exportación desde `npm run preview` (build de producción): sin errores de consola y DOCX de una página para 2 fotos.

### Lo que no se probó

- Safari, Firefox ni dispositivos móviles reales.
- Lectores de pantalla ni auditorías formales de accesibilidad.
- Cámara real en un teléfono (solo se probó la selección de archivos).
- Cuota de almacenamiento agotada, modo privado y varias pestañas con versiones distintas.
- Apertura del DOCX en LibreOffice u otras suites.

## Limitaciones y advertencias

- **Sin backend, sin cuentas y sin sincronización.** Cada navegador es un mundo.
- **No hay papelera de proyectos.** Se pueden eliminar fotografías, pero no proyectos completos desde la interfaz.
- **Dos fotos por página en condiciones normales.** Descripciones muy largas (el límite es 600 caracteres) pueden hacer que una foto pase a la página siguiente para no separarse de su texto. La app prioriza que la imagen y su descripción queden juntas.
- **La fecha de incorporación no es la fecha de captura.** No se leen metadatos EXIF ni se certifica la autenticidad de la foto.
- **Poppins no está incrustada en el DOCX.** Sin la fuente instalada, Word puede sustituirla.
- **El aspecto final depende de Word.** Márgenes, saltos de página y ajustes de texto pueden variar mínimamente entre versiones o impresoras.
- **No se deben usar datos personales reales** en una práctica si no está autorizado. La denominación del establecimiento debe ser ficticia.
- La aplicación no cifra el almacenamiento local.

## Créditos

- Construida con HTML5, CSS3 y JavaScript moderno (sin framework).
- Persistencia con IndexedDB.
- Generación de Word con [`docx`](https://docx.js.org/).
- Empaquetado y servidor de desarrollo con [Vite](https://vite.dev/).
- Tipografía [Poppins](https://fonts.google.com/specimen/Poppins), distribuida con `@fontsource` bajo SIL Open Font License.
- Pruebas de navegador con [Playwright](https://playwright.dev/).
