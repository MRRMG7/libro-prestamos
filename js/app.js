/* =========================================================
   Libro de Préstamos — lógica de la aplicación
   Los datos viven en Firebase Firestore (se sincronizan solos
   entre todos los celulares/computadoras que abran el sitio).
   Interés siempre se calcula por mes completo sobre el CAPITAL
   PENDIENTE (no proporcional a los días, y baja según abonos).
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  writeBatch,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const dbFs = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

// Permite seguir viendo los datos aunque se pierda la conexión un momento.
enableIndexedDbPersistence(dbFs).catch(() => { /* varias pestañas abiertas: se ignora */ });

let db = { clientes: [], prestamos: [], pagos: [], retiros: [] };

function nuevoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function fmt(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------- Estado de sincronización ---------- */
function setEstadoSync(texto, ok) {
  const el = document.getElementById("sync-status");
  if (!el) return;
  el.textContent = texto;
  el.style.color = ok ? "var(--green)" : "var(--red)";
}
setEstadoSync("Conectando…", true);
window.addEventListener("offline", () => setEstadoSync("Sin conexión — se sincroniza al volver", false));
window.addEventListener("online", () => setEstadoSync("Conectado", true));

/* ---------- Tema claro / oscuro ---------- */
function aplicarTema(tema) {
  document.documentElement.setAttribute("data-theme", tema);
  const icono = tema === "light" ? "☀️" : "🌙";
  document.querySelectorAll(".btn-theme").forEach(btn => { btn.textContent = icono; });
  try { localStorage.setItem("tema", tema); } catch (e) { /* modo privado: se ignora */ }
}
(function initTema() {
  let tema = "dark";
  try { tema = localStorage.getItem("tema") || "dark"; } catch (e) { /* se ignora */ }
  aplicarTema(tema);
})();
document.querySelectorAll(".btn-theme").forEach(btn => {
  btn.addEventListener("click", () => {
    const actual = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    aplicarTema(actual === "light" ? "dark" : "light");
  });
});

/* ---------- Acceso: solo la familia entra ---------- */
let desuscribirListeners = [];

function detenerSuscripciones() {
  desuscribirListeners.forEach(fn => fn());
  desuscribirListeners = [];
  db = { clientes: [], prestamos: [], pagos: [], retiros: [] };
}

function iniciarSuscripciones() {
  const unsubClientes = onSnapshot(collection(dbFs, "clientes"), snap => {
    db.clientes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (navigator.onLine) {
      setEstadoSync("Conectado", true);
    } else {
      setEstadoSync("Sin conexión — mostrando la última copia", false);
    }
    renderClientes();
  }, err => {
    console.error(err);
    setEstadoSync("Error de conexión con Firebase (revisá firebase-config.js)", false);
  });

  const unsubPrestamos = onSnapshot(collection(dbFs, "prestamos"), snap => {
    db.prestamos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderClientes();
  });

  const unsubPagos = onSnapshot(collection(dbFs, "pagos"), snap => {
    db.pagos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderClientes();
    // si el modal de historial está abierto, lo refrescamos también
    const modalHist = document.getElementById("modal-historial");
    if (modalHist.classList.contains("open")) {
      const prestamoId = modalHist.dataset.prestamoId;
      if (prestamoId) pintarHistorial(prestamoId);
    }
  });

  const unsubRetiros = onSnapshot(collection(dbFs, "retiros"), snap => {
    db.retiros = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFondos();
  });

  desuscribirListeners = [unsubClientes, unsubPrestamos, unsubPagos, unsubRetiros];
}

onAuthStateChanged(auth, user => {
  const loginScreen = document.getElementById("login-screen");
  const appRoot = document.getElementById("app-root");
  const btnLogout = document.getElementById("btn-logout");

  if (user) {
    loginScreen.style.display = "none";
    appRoot.hidden = false;
    btnLogout.hidden = false;
    setEstadoSync("Conectando…", true);
    iniciarSuscripciones();
  } else {
    loginScreen.style.display = "flex";
    appRoot.hidden = true;
    btnLogout.hidden = true;
    detenerSuscripciones();
  }
});

document.getElementById("btn-login").addEventListener("click", async () => {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.hidden = true;

  if (!email || !password) return;

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    console.error(e);
    errorEl.textContent = `Error: ${e.code || e.message}`;
    errorEl.hidden = false;
  }
});

document.getElementById("login-password").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("btn-login").click();
});

document.getElementById("btn-logout").addEventListener("click", () => signOut(auth));

/* ---------- Cálculo de interés ---------- */
// El interés de un mes siempre es el mes completo sobre el capital
// que esté pendiente en ese momento (sin prorratear por días).
function interesDelMes(prestamo) {
  return prestamo.capitalPendiente * (prestamo.tasa / 100);
}

/* ---------- Interés acumulado por fechas de aniversario ---------- */
// Suma n meses a una fecha "YYYY-MM-DD", ajustando el día si el mes
// destino tiene menos días (ej. 31 de enero + 1 mes = 28/29 de febrero).
function sumarMeses(fechaStr, n) {
  const [y, m, d] = fechaStr.split("-").map(Number);
  const indiceMesDestino = (m - 1) + n;
  const anioDestino = y + Math.floor(indiceMesDestino / 12);
  const mesDestino = ((indiceMesDestino % 12) + 12) % 12;
  const ultimoDiaMes = new Date(anioDestino, mesDestino + 1, 0).getDate();
  const dia = Math.min(d, ultimoDiaMes);
  const mm = String(mesDestino + 1).padStart(2, "0");
  const dd = String(dia).padStart(2, "0");
  return `${anioDestino}-${mm}-${dd}`;
}

// Fechas de cobro (aniversarios mensuales) desde el inicio del préstamo
// hasta una fecha límite, sin pasarse de esa fecha.
function obtenerAniversarios(prestamo, fechaHasta) {
  const aniversarios = [];
  let n = 1;
  let fecha = sumarMeses(prestamo.fecha, n);
  while (fecha <= fechaHasta) {
    aniversarios.push(fecha);
    n++;
    fecha = sumarMeses(prestamo.fecha, n);
  }
  return aniversarios;
}

// Capital pendiente que tenía el préstamo justo en una fecha de corte,
// reconstruido a partir de los abonos ya registrados hasta esa fecha (inclusive).
function capitalPendienteEnFecha(prestamo, fechaCorte) {
  const totalAbonado = db.pagos
    .filter(pg => pg.prestamoId === prestamo.id && pg.fecha <= fechaCorte)
    .reduce((s, pg) => s + (pg.abonoCapital || 0), 0);
  return Math.max(0, prestamo.capitalOriginal - totalAbonado);
}

// Interés devengado, pagado y pendiente (acumulado de todos los meses
// vencidos) hasta una fecha dada. Un abono a capital solo reduce el
// interés a partir del mes SIGUIENTE a cuando se registró.
function calcularInteresAcumulado(prestamo, fechaHasta) {
  fechaHasta = fechaHasta || hoyISO();
  const aniversarios = obtenerAniversarios(prestamo, fechaHasta);
  const boundaries = [prestamo.fecha, ...aniversarios];

  let devengado = 0;
  for (let i = 1; i < boundaries.length; i++) {
    const capitalInicioPeriodo = capitalPendienteEnFecha(prestamo, boundaries[i - 1]);
    devengado += capitalInicioPeriodo * (prestamo.tasa / 100);
  }

  const pagado = db.pagos
    .filter(pg => pg.prestamoId === prestamo.id)
    .reduce((s, pg) => s + (pg.interesPagado || 0), 0);

  const pendiente = Math.max(0, devengado - pagado);
  const interesMensualActual = prestamo.capitalPendiente * (prestamo.tasa / 100);
  const mesesAtrasados = interesMensualActual > 0.005 ? Math.max(1, Math.round(pendiente / interesMensualActual)) : 0;

  return { devengado, pagado, pendiente, mesesAtrasados, boundaries };
}

/* =========================================================
   NAVEGACIÓN DE TABS
   ========================================================= */
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

/* =========================================================
   MODALES genéricos
   ========================================================= */
function abrirModal(id) { document.getElementById(id).classList.add("open"); }
function cerrarModal(id) { document.getElementById(id).classList.remove("open"); }

document.querySelectorAll("[data-close-modal]").forEach(btn => {
  btn.addEventListener("click", () => btn.closest(".modal").classList.remove("open"));
});
document.querySelectorAll(".modal").forEach(modal => {
  modal.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("open"); });
});

/* =========================================================
   RENDER: totales de la portada
   ========================================================= */
function renderTotales() {
  const activos = db.prestamos.filter(p => p.estado === "activo");
  const totalActivo = activos.reduce((s, p) => s + p.capitalPendiente, 0);
  const totalInteresMes = activos.reduce((s, p) => s + interesDelMes(p), 0);

  document.getElementById("total-activo").textContent = fmt(totalActivo);
  document.getElementById("total-interes-mes").textContent = fmt(totalInteresMes);
  document.getElementById("total-prestamos").textContent = activos.length;

  renderFondos();
}

function renderFondos() {
  const contTab = document.getElementById("fondos-resumen");
  const emptyHint = document.getElementById("empty-fondos");
  const contDashboard = document.getElementById("total-capital-disponible");
  if (!contTab) return;

  const prestamos = db.prestamos;

  const orden = ["Papa", "Mauricio", "Adela", "Moises"];
  const duenosSet = new Set(prestamos.map(p => p.dueno || "Papa"));
  const duenos = [
    ...orden.filter(d => duenosSet.has(d)),
    ...[...duenosSet].filter(d => !orden.includes(d)).sort()
  ];

  const totalFijo = prestamos.reduce((s, p) => s + p.capitalOriginal, 0);
  const totalRetirado = retirosTotal();

  if (contDashboard) {
    contDashboard.textContent = fmt(totalFijo - totalRetirado);
  }

  if (prestamos.length === 0) {
    contTab.innerHTML = "";
    if (emptyHint) emptyHint.hidden = false;
    renderRetiros();
    return;
  }
  if (emptyHint) emptyHint.hidden = true;

  let tablaHTML = `
    <div class="calc-card resumen-card fondos-disponible-card">
      <div class="fondos-disponible-titulo">
        <h3>Capital disponible por dueño</h3>
        <span class="total-sub">Capital fijo − sacadas = disponible</span>
      </div>
      <table class="tabla-historial">
        <thead>
          <tr>
            <th>Dueño</th>
            <th>Capital fijo</th>
            <th>Sacado</th>
            <th>Capital disponible</th>
          </tr>
        </thead>
        <tbody>
  `;
  duenos.forEach(d => {
    const loans = prestamos.filter(p => (p.dueno || "Papa") === d);
    const fijo = loans.reduce((s, p) => s + p.capitalOriginal, 0);
    const retirado = retirosDe(d);
    tablaHTML += `
      <tr>
        <td><b>${escapeHtml(d)}</b></td>
        <td class="mono">${fmt(fijo)}</td>
        <td class="mono">${fmt(retirado)}</td>
        <td class="mono fondos-disponible-value">${fmt(fijo - retirado)}</td>
      </tr>
    `;
  });
  tablaHTML += `
        <tr class="fondos-row-total">
          <td><b>Total</b></td>
          <td class="mono"><b>${fmt(totalFijo)}</b></td>
          <td class="mono"><b>${fmt(totalRetirado)}</b></td>
          <td class="mono fondos-disponible-value"><b>${fmt(totalFijo - totalRetirado)}</b></td>
        </tr>
      </tbody>
      </table>
    </div>
  `;
  contTab.innerHTML = tablaHTML;

  renderRetiros();
}

function retirosDe(d) {
  return (db.retiros || []).filter(r => (r.dueno || "Papa") === d).reduce((s, r) => s + Number(r.monto || 0), 0);
}

function retirosTotal() {
  return (db.retiros || []).reduce((s, r) => s + Number(r.monto || 0), 0);
}

function renderRetiros() {
  const cont = document.getElementById("retiros-lista");
  if (!cont) return;
  const retiros = [...(db.retiros || [])].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  if (retiros.length === 0) {
    cont.innerHTML = `<p class="empty-hint">Todavía no registraste ninguna sacada del capital.</p>`;
    return;
  }

  let html = `
    <div class="calc-card resumen-card">
      <table class="tabla-historial">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Dueño</th>
            <th>Monto</th>
            <th>Nota</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
  `;
  retiros.forEach(r => {
    html += `
      <tr>
        <td class="mono">${formatFecha(r.fecha)}</td>
        <td>${escapeHtml(r.dueno || "Papa")}</td>
        <td class="mono">${fmt(r.monto)}</td>
        <td>${r.nota ? escapeHtml(r.nota) : ""}</td>
        <td>
          <button class="btn btn-danger btn-small" data-borrar-retiro="${r.id}">Borrar</button>
        </td>
      </tr>
    `;
  });
  html += `</tbody></table></div>`;
  cont.innerHTML = html;

  cont.querySelectorAll("[data-borrar-retiro]").forEach(btn => {
    btn.addEventListener("click", () => borrarRetiro(btn.dataset.borrarRetiro));
  });
}

async function borrarRetiro(id) {
  if (!confirm("¿Borrar esta sacada del capital?")) return;
  try {
    await deleteDoc(doc(dbFs, "retiros", id));
  } catch (e) {
    alert("No se pudo borrar. Revisá tu conexión.");
    console.error(e);
  }
}

function abrirModalRetiro() {
  document.getElementById("editar-retiro-id").value = "";
  document.getElementById("input-dueno-retiro").value = "Papa";
  document.getElementById("input-monto-retiro").value = "";
  document.getElementById("input-fecha-retiro").value = hoyISO();
  document.getElementById("input-nota-retiro").value = "";
  document.getElementById("modal-retiro-titulo").textContent = "Sacar del capital";
  abrirModal("modal-retiro");
}

document.getElementById("btn-nuevo-retiro").addEventListener("click", () => abrirModalRetiro());

document.getElementById("btn-guardar-retiro").addEventListener("click", async () => {
  const monto = parseFloat(document.getElementById("input-monto-retiro").value);
  const fecha = document.getElementById("input-fecha-retiro").value || hoyISO();
  const nota = document.getElementById("input-nota-retiro").value.trim();
  const dueno = document.getElementById("input-dueno-retiro").value || "Papa";
  const editarId = document.getElementById("editar-retiro-id").value;

  if (!monto || monto <= 0) return;

  try {
    if (editarId) {
      await updateDoc(doc(dbFs, "retiros", editarId), { dueno, monto, fecha, nota });
    } else {
      const ref = doc(collection(dbFs, "retiros"));
      await setDoc(ref, { dueno, monto, fecha, nota });
    }
    cerrarModal("modal-retiro");
  } catch (e) {
    alert("No se pudo guardar. Revisá tu conexión.");
    console.error(e);
  }
});

/* =========================================================
   RENDER: lista de clientes y sus préstamos
   ========================================================= */
function renderClientes() {
  const cont = document.getElementById("lista-clientes");
  const emptyHint = document.getElementById("empty-clientes");
  cont.innerHTML = "";

  const filtro = (document.getElementById("input-buscar-clientes")?.value || "").toLowerCase().trim();
  let clientesFiltrados = db.clientes;
  if (filtro) {
    clientesFiltrados = db.clientes.filter(c => c.nombre.toLowerCase().includes(filtro));
  }

  if (clientesFiltrados.length === 0) {
    emptyHint.hidden = false;
    if (filtro && db.clientes.length > 0) {
      emptyHint.textContent = `No se encontraron clientes que coincidan con "${filtro}".`;
    } else {
      emptyHint.textContent = "Todavía no hay clientes. Agregá el primero para empezar a llevar el control.";
    }
    renderTotales();
    return;
  }
  emptyHint.hidden = true;
  emptyHint.textContent = "Todavía no hay clientes. Agregá el primero para empezar a llevar el control.";

  clientesFiltrados.forEach(cliente => {
    const prestamosCliente = db.prestamos.filter(p => p.clienteId === cliente.id);

    const card = document.createElement("div");
    card.className = "cliente-card";

    const head = document.createElement("div");
    head.className = "cliente-head";
    head.innerHTML = `
      <span class="cliente-nombre">${escapeHtml(cliente.nombre)}</span>
    `;
    const acciones = document.createElement("div");
    acciones.className = "cliente-acciones";

    const btnEditar = document.createElement("button");
    btnEditar.className = "btn btn-ghost btn-small";
    btnEditar.textContent = "Editar";
    btnEditar.addEventListener("click", () => abrirEditarCliente(cliente.id));
    acciones.appendChild(btnEditar);

    const btnPrestar = document.createElement("button");
    btnPrestar.className = "btn btn-ghost btn-small";
    btnPrestar.textContent = "+ Préstamo";
    btnPrestar.addEventListener("click", () => abrirModalPrestamo(cliente.id));
    acciones.appendChild(btnPrestar);

    const btnBorrarCliente = document.createElement("button");
    btnBorrarCliente.className = "btn btn-danger btn-small";
    btnBorrarCliente.textContent = "Borrar";
    btnBorrarCliente.addEventListener("click", () => borrarCliente(cliente.id, cliente.nombre));
    acciones.appendChild(btnBorrarCliente);

    head.appendChild(acciones);
    card.appendChild(head);

    if (prestamosCliente.length === 0) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Sin préstamos todavía.";
      card.appendChild(p);
    }

    prestamosCliente.forEach(prestamo => {
      card.appendChild(renderTicketPrestamo(prestamo));
    });

    cont.appendChild(card);
  });

  renderTotales();
  renderResumenSelect();
}

/* =========================================================
   RESUMEN: control mensual por préstamo
   ========================================================= */
function renderResumenSelect() {
  const select = document.getElementById("resumen-select-prestamo");
  const emptyHint = document.getElementById("empty-resumen");
  if (!select || !emptyHint) return;

  const valorPrevio = select.value;
  select.innerHTML = "";

  if (db.prestamos.length === 0) {
    const grid = document.getElementById("resumen-grid");
    if (grid) grid.innerHTML = "";
    emptyHint.hidden = false;
    return;
  }
  emptyHint.hidden = true;

  db.prestamos.forEach(p => {
    const cliente = db.clientes.find(c => c.id === p.clienteId);
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${cliente ? cliente.nombre : "?"} — ${fmt(p.capitalOriginal)} al ${p.tasa}% (${formatFecha(p.fecha)})${p.estado === "saldado" ? " · Saldado" : ""}`;
    select.appendChild(opt);
  });

  const idASeleccionar = db.prestamos.some(p => p.id === valorPrevio) ? valorPrevio : db.prestamos[0].id;
  select.value = idASeleccionar;
  renderResumenTabla(idASeleccionar);
}

function renderResumenTabla(prestamoId) {
  const grid = document.getElementById("resumen-grid");
  const emptyHint = document.getElementById("empty-resumen");
  if (!grid) return;
  grid.innerHTML = "";

  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) {
    emptyHint.hidden = false;
    return;
  }
  emptyHint.hidden = true;

  const meses = obtenerMesesGrid(prestamoId);
  if (meses.length === 0) {
    grid.innerHTML = `<p class="empty-hint">Todavía no se cumple el primer mes de este préstamo.</p>`;
    return;
  }

  const filtro = (document.getElementById("input-buscar-resumen")?.value || "").toLowerCase().trim();
  let mesesFiltrados = meses;
  if (filtro) {
    const cliente = db.clientes.find(c => c.id === prestamo.clienteId);
    const clienteMatch = cliente && cliente.nombre.toLowerCase().includes(filtro);

    mesesFiltrados = meses.filter(m => {
      const [anio, mesNum] = m.finPeriodo.split("-");
      const nombreMes = nombreMesLargo(Number(mesNum)).toLowerCase();
      const mesAnio = `${nombreMes} ${anio}`;
      return mesAnio.includes(filtro) || clienteMatch;
    });

    if (mesesFiltrados.length === 0) {
      grid.innerHTML = `<p class="empty-hint">No se encontraron meses que coincidan con "${filtro}".</p>`;
      return;
    }
  }

  mesesFiltrados.forEach(mes => {
    const card = document.createElement("div");
    card.className = "month-card";

    const [anio, mesNum] = mes.finPeriodo.split("-");
    const nombreMes = nombreMesLargo(Number(mesNum));

    const statusClass = mes.estado === "Saldado" ? "status-saldado"
      : mes.estado === "Al día" ? "status-aldia" : "status-deuda";

    card.innerHTML = `
      <div class="month-card-head">
        <span class="month-card-name">${nombreMes} ${anio}</span>
        <span class="month-card-status ${statusClass}">${mes.estado}</span>
      </div>
      <div class="month-card-body">
        <div class="month-card-row">
          <span>Capital inicial</span><span class="mono">${fmt(mes.capitalInicial)}</span>
        </div>
        <div class="month-card-row">
          <span>Interés del mes</span><span class="mono">${fmt(mes.interesDelMes)}</span>
        </div>
        <div class="month-card-row">
          <span>Interés cobrado</span><span class="mono">${fmt(mes.interesCobrado)}</span>
        </div>
        <div class="month-card-row">
          <span>Capital cobrado</span><span class="mono">${fmt(mes.capitalCobrado)}</span>
        </div>
        <div class="month-card-row total">
          <span>Total cobrado</span>
          <span class="mono">${fmt(mes.interesCobrado + mes.capitalCobrado)}</span>
        </div>
      </div>
      <div class="month-card-actions">
        <button class="btn btn-primary btn-small month-card-detail" data-finperiodo="${mes.finPeriodo}">
          Ver Detalle
        </button>
        <button class="btn btn-ghost btn-small month-card-edit" data-finperiodo="${mes.finPeriodo}">
          Editar
        </button>
      </div>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll(".month-card-detail").forEach(btn => {
    btn.addEventListener("click", () => {
      abrirDetalleMes(prestamoId, btn.dataset.finperiodo);
    });
  });
  grid.querySelectorAll(".month-card-edit").forEach(btn => {
    btn.addEventListener("click", () => {
      abrirEditarPagoMes(prestamoId, btn.dataset.finperiodo);
    });
  });
}

document.getElementById("resumen-select-prestamo")?.addEventListener("change", e => {
  renderResumenTabla(e.target.value);
});

document.getElementById("input-buscar-resumen")?.addEventListener("input", () => {
  const prestamoId = document.getElementById("resumen-select-prestamo").value;
  if (prestamoId) renderResumenTabla(prestamoId);
});

function nombreMesLargo(num) {
  const meses = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
                 "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  return meses[num - 1] || "";
}

function formatFecha(fechaISO) {
  if (!fechaISO) return "";
  const [y, m, d] = fechaISO.split("-");
  return `${d}/${m}/${y}`;
}

function obtenerMesesGrid(prestamoId) {
  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) return [];

  const hoy = hoyISO();
  const aniversarios = obtenerAniversarios(prestamo, hoy);
  const boundaries = [prestamo.fecha, ...aniversarios];
  if (boundaries.length < 2) return [];

  const pagosPrestamo = db.pagos.filter(pg => pg.prestamoId === prestamoId);
  const meses = [];
  let devengadoAcum = 0;
  let pagadoInteresAcum = 0;

  for (let i = 1; i < boundaries.length; i++) {
    const inicioPeriodo = boundaries[i - 1];
    const finPeriodo = boundaries[i];

    const capitalInicial = capitalPendienteEnFecha(prestamo, inicioPeriodo);
    const interesDelMesPeriodo = capitalInicial * (prestamo.tasa / 100);
    const interesAtrasadoAntes = Math.max(0, devengadoAcum - pagadoInteresAcum);

    const pagosDelPeriodo = pagosPrestamo.filter(pg =>
      pg.fecha > inicioPeriodo && pg.fecha <= finPeriodo
    );
    const interesCobrado = pagosDelPeriodo.reduce((s, pg) => s + (pg.interesPagado || 0), 0);
    const capitalCobrado = pagosDelPeriodo.reduce((s, pg) => s + (pg.abonoCapital || 0), 0);

    devengadoAcum += interesDelMesPeriodo;
    pagadoInteresAcum += interesCobrado;

    const pendienteAlCierre = Math.max(0, devengadoAcum - pagadoInteresAcum);
    const capitalPendienteAlCierre = capitalPendienteEnFecha(prestamo, finPeriodo);

    let estado;
    if (capitalPendienteAlCierre <= 0.005) {
      estado = "Saldado";
    } else if (pendienteAlCierre <= 0.005) {
      estado = "Al día";
    } else {
      const mesesDeuda = interesDelMesPeriodo > 0.005
        ? Math.max(1, Math.round(pendienteAlCierre / interesDelMesPeriodo))
        : 1;
      estado = `Debiendo ${mesesDeuda} mes(es)`;
    }

    meses.push({
      finPeriodo,
      capitalInicial,
      interesDelMes: interesDelMesPeriodo,
      interesAtrasado: interesAtrasadoAntes,
      interesCobrado,
      capitalCobrado,
      pendienteInteres: pendienteAlCierre,
      capitalPendiente: capitalPendienteAlCierre,
      estado,
      pagos: pagosDelPeriodo
    });
  }
  return meses;
}

function abrirDetalleMes(prestamoId, finPeriodo) {
  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) return;
  const cliente = db.clientes.find(c => c.id === prestamo.clienteId);
  const meses = obtenerMesesGrid(prestamoId);
  const mes = meses.find(m => m.finPeriodo === finPeriodo);
  if (!mes) return;

  const [anio, mesNum] = finPeriodo.split("-");
  const nombreMes = nombreMesLargo(Number(mesNum));

  document.getElementById("detalle-mes-titulo").textContent =
    `Reporte de Cobros — ${nombreMes} ${anio}`;

  const contenido = document.getElementById("detalle-mes-contenido");
  contenido.innerHTML = `
    <p class="hint" style="margin:0 0 12px">
      Préstamo de <b>${cliente ? escapeHtml(cliente.nombre) : "?"}</b>
      — ${fmt(prestamo.capitalOriginal)} al ${prestamo.tasa}%
    </p>

    <h4 class="detail-subtitle">Control Mensual</h4>
    <div class="tabla-wrap">
      <table class="tabla-historial detail-table">
        <thead>
          <tr>
            <th>Capital inicial</th>
            <th>Interés del mes</th>
            <th>Interés atrasado</th>
            <th>Cobrado interés</th>
            <th>Cobrado capital</th>
            <th>Capital restante</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="mono">${fmt(mes.capitalInicial)}</td>
            <td class="mono">${fmt(mes.interesDelMes)}</td>
            <td class="mono">${fmt(mes.interesAtrasado)}</td>
            <td class="mono">${fmt(mes.interesCobrado)}</td>
            <td class="mono">${fmt(mes.capitalCobrado)}</td>
            <td class="mono">${fmt(mes.capitalPendiente)}</td>
            <td class="${mes.estado.startsWith("Debiendo") ? "deuda-alerta" : ""}">${mes.estado}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h4 class="detail-subtitle">Transacciones del mes</h4>
    <div class="tabla-wrap">
      <table class="tabla-historial detail-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Interés pagado</th>
            <th>Abono capital</th>
            <th>Capital restante</th>
          </tr>
        </thead>
        <tbody>
          ${mes.pagos.length === 0
            ? `<tr><td colspan="4" class="hint">Sin pagos registrados este mes.</td></tr>`
            : mes.pagos.map(pg => `
              <tr>
                <td>${formatFecha(pg.fecha)}</td>
                <td class="mono">${fmt(pg.interesPagado)}</td>
                <td class="mono">${fmt(pg.abonoCapital)}</td>
                <td class="mono">${fmt(pg.capitalPendienteDespues)}</td>
              </tr>
            `).join("")
          }
        </tbody>
      </table>
    </div>
  `;

  abrirModal("modal-detalle-mes");
}

function renderTicketPrestamo(prestamo) {
  const saldado = prestamo.estado === "saldado";
  const ticket = document.createElement("div");
  ticket.className = "prestamo-ticket" + (saldado ? " saldado" : "");

  const stamp = document.createElement("div");
  stamp.className = "stamp";
  stamp.textContent = prestamo.tasa + "%";

  const info = document.createElement("div");
  info.className = "prestamo-info";

  let lineaDeuda = "";
  if (!saldado) {
    const acumulado = calcularInteresAcumulado(prestamo, hoyISO());
    const anivPasados = obtenerAniversarios(prestamo, hoyISO());
    const proximoVencimiento = sumarMeses(prestamo.fecha, anivPasados.length + 1);
    const interesProximoMes = prestamo.capitalPendiente * (prestamo.tasa / 100);

    if (acumulado.pendiente > 0.005) {
      const etiquetaMeses = acumulado.mesesAtrasados > 1 ? ` (${acumulado.mesesAtrasados} meses)` : "";
      lineaDeuda = `
        <span class="prestamo-meta deuda-alerta">Debe: ${fmt(acumulado.pendiente)}${etiquetaMeses}</span>
        <span class="prestamo-meta">Vence: ${formatFecha(proximoVencimiento)}</span>
      `;
    } else {
      lineaDeuda = `
        <span class="prestamo-meta">Al día · Vence: <b>${formatFecha(proximoVencimiento)}</b></span>
        <span class="prestamo-meta">A cobrar el próximo mes: ${fmt(interesProximoMes)}</span>
      `;
    }
  }

  info.innerHTML = `
    <span class="prestamo-capital mono">${fmt(prestamo.capitalPendiente)} pendiente
      <span class="badge ${saldado ? "badge-saldado" : "badge-pendiente"}">${saldado ? "Saldado" : "Activo"}</span>
    </span>
    <span class="prestamo-meta">Capital original ${fmt(prestamo.capitalOriginal)} · prestado ${formatFecha(prestamo.fecha)}</span>
    <span class="prestamo-meta">Dueño: ${escapeHtml(prestamo.dueno || "Papa")}</span>
    ${lineaDeuda}
  `;

  const acciones = document.createElement("div");
  acciones.className = "prestamo-acciones";

  if (!saldado) {
    const btnPago = document.createElement("button");
    btnPago.className = "btn btn-primary btn-small";
    btnPago.textContent = "Registrar pago";
    btnPago.addEventListener("click", () => abrirModalPago(prestamo.id));
    acciones.appendChild(btnPago);
  }

  const btnHist = document.createElement("button");
  btnHist.className = "btn btn-ghost btn-small";
  btnHist.textContent = "Historial";
  btnHist.addEventListener("click", () => abrirHistorial(prestamo.id));
  acciones.appendChild(btnHist);

  const btnEditarPrestamo = document.createElement("button");
  btnEditarPrestamo.className = "btn btn-ghost btn-small";
  btnEditarPrestamo.textContent = "Editar";
  btnEditarPrestamo.addEventListener("click", () => abrirEditarPrestamo(prestamo.id));
  acciones.appendChild(btnEditarPrestamo);

  const btnBorrarPrestamo = document.createElement("button");
  btnBorrarPrestamo.className = "btn btn-danger btn-small";
  btnBorrarPrestamo.textContent = "Borrar préstamo";
  btnBorrarPrestamo.addEventListener("click", () => borrarPrestamo(prestamo.id));
  acciones.appendChild(btnBorrarPrestamo);

  ticket.appendChild(stamp);
  ticket.appendChild(info);

  const notaContainer = document.createElement("div");
  notaContainer.className = "prestamo-nota-container";
  if (prestamo.notas) {
    notaContainer.innerHTML = `
      <span class="prestamo-nota-texto">📝 ${escapeHtml(prestamo.notas)}</span>
      <button class="prestamo-nota-editar" data-prestamo-id="${prestamo.id}">✏️</button>
    `;
  } else {
    notaContainer.innerHTML = `
      <button class="prestamo-nota-agregar" data-prestamo-id="${prestamo.id}">+ Agregar nota</button>
    `;
  }
  ticket.appendChild(notaContainer);

  ticket.appendChild(acciones);

  notaContainer.querySelectorAll(".prestamo-nota-editar, .prestamo-nota-agregar").forEach(btn => {
    btn.addEventListener("click", () => editarNotaPrestamo(btn.dataset.prestamoId));
  });

  return ticket;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* =========================================================
   CLIENTE: crear
   ========================================================= */
document.getElementById("btn-nuevo-cliente").addEventListener("click", () => {
  document.getElementById("editar-cliente-id").value = "";
  document.getElementById("input-nombre-cliente").value = "";
  document.getElementById("modal-cliente-titulo").textContent = "Nuevo cliente";
  abrirModal("modal-cliente");
});

document.getElementById("btn-guardar-cliente").addEventListener("click", async () => {
  const nombre = document.getElementById("input-nombre-cliente").value.trim();
  if (!nombre) return;
  const editarId = document.getElementById("editar-cliente-id").value;
  try {
    if (editarId) {
      await updateDoc(doc(dbFs, "clientes", editarId), { nombre });
    } else {
      const ref = doc(collection(dbFs, "clientes"));
      await setDoc(ref, { nombre });
    }
    cerrarModal("modal-cliente");
  } catch (e) {
    alert("No se pudo guardar el cliente. Revisá tu conexión o la configuración de Firebase.");
    console.error(e);
  }
});

function abrirEditarCliente(clienteId) {
  const cliente = db.clientes.find(c => c.id === clienteId);
  if (!cliente) return;
  document.getElementById("editar-cliente-id").value = clienteId;
  document.getElementById("input-nombre-cliente").value = cliente.nombre;
  document.getElementById("modal-cliente-titulo").textContent = "Editar cliente";
  abrirModal("modal-cliente");
}

document.getElementById("input-buscar-clientes")?.addEventListener("input", () => {
  renderClientes();
});

/* =========================================================
   PRÉSTAMO: crear
   ========================================================= */
function abrirModalPrestamo(clienteId) {
  document.getElementById("editar-prestamo-id").value = "";
  document.getElementById("prestamo-cliente-id").value = clienteId;
  document.getElementById("input-capital-prestamo").value = "";
  document.getElementById("input-fecha-prestamo").value = hoyISO();
  document.getElementById("input-nota-prestamo").value = "";
  document.getElementById("input-dueno-prestamo").value = "Papa";
  setRateToggle("prestamo-rate-toggle", 8);
  document.getElementById("modal-prestamo-titulo").textContent = "Nuevo préstamo";
  abrirModal("modal-prestamo");
}

function setRateToggle(containerId, rate) {
  const cont = document.getElementById(containerId);
  cont.querySelectorAll(".rate-btn").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.rate) === rate);
  });
}

function getRateToggle(containerId) {
  const active = document.querySelector(`#${containerId} .rate-btn.active`);
  return active ? Number(active.dataset.rate) : 8;
}

document.querySelectorAll("#prestamo-rate-toggle .rate-btn").forEach(btn => {
  btn.addEventListener("click", () => setRateToggle("prestamo-rate-toggle", Number(btn.dataset.rate)));
});

document.getElementById("btn-guardar-prestamo").addEventListener("click", async () => {
  const clienteId = document.getElementById("prestamo-cliente-id").value;
  const capital = parseFloat(document.getElementById("input-capital-prestamo").value);
  const fecha = document.getElementById("input-fecha-prestamo").value || hoyISO();
  const tasa = getRateToggle("prestamo-rate-toggle");
  const notas = document.getElementById("input-nota-prestamo").value.trim();
  const dueno = document.getElementById("input-dueno-prestamo").value || "Papa";
  const editarId = document.getElementById("editar-prestamo-id").value;

  if (!capital || capital <= 0) return;

  try {
    if (editarId) {
      const prestamo = db.prestamos.find(p => p.id === editarId);
      const diffCapital = capital - (prestamo ? prestamo.capitalOriginal : capital);
      const nuevoPendiente = Math.max(0, (prestamo ? prestamo.capitalPendiente : capital) + diffCapital);
      await updateDoc(doc(dbFs, "prestamos", editarId), {
        capitalOriginal: capital,
        capitalPendiente: nuevoPendiente,
        tasa,
        fecha,
        notas,
        dueno
      });
    } else {
      const ref = doc(collection(dbFs, "prestamos"));
      await setDoc(ref, {
        clienteId,
        capitalOriginal: capital,
        capitalPendiente: capital,
        tasa,
        fecha,
        estado: "activo",
        notas,
        dueno
      });
    }
    cerrarModal("modal-prestamo");
  } catch (e) {
    alert("No se pudo guardar el préstamo. Revisá tu conexión o la configuración de Firebase.");
    console.error(e);
  }
});

function abrirEditarPrestamo(prestamoId) {
  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) return;
  document.getElementById("editar-prestamo-id").value = prestamoId;
  document.getElementById("prestamo-cliente-id").value = prestamo.clienteId;
  document.getElementById("input-capital-prestamo").value = prestamo.capitalOriginal;
  document.getElementById("input-fecha-prestamo").value = prestamo.fecha;
  document.getElementById("input-nota-prestamo").value = prestamo.notas || "";
  document.getElementById("input-dueno-prestamo").value = prestamo.dueno || "Papa";
  setRateToggle("prestamo-rate-toggle", prestamo.tasa);
  document.getElementById("modal-prestamo-titulo").textContent = "Editar préstamo";
  abrirModal("modal-prestamo");
}

async function editarNotaPrestamo(prestamoId) {
  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) return;
  const nuevaNota = prompt("Nota / Observaciones del préstamo:", prestamo.notas || "");
  if (nuevaNota === null) return;
  try {
    await updateDoc(doc(dbFs, "prestamos", prestamoId), { notas: nuevaNota.trim() });
  } catch (e) {
    alert("No se pudo guardar la nota.");
    console.error(e);
  }
}

function abrirEditarPagoMes(prestamoId, finPeriodo) {
  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) return;

  const pagosMes = db.pagos.filter(pg =>
    pg.prestamoId === prestamoId &&
    pg.fecha > (() => {
      const partes = finPeriodo.split("-");
      const d = new Date(Number(partes[0]), Number(partes[1]) - 1, 1);
      d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 10);
    })() &&
    pg.fecha <= finPeriodo
  );

  const [anio, mesNum] = finPeriodo.split("-");
  const nombreMes = nombreMesLargo(Number(mesNum));

  document.getElementById("pago-prestamo-id").value = prestamoId;

  if (pagosMes.length > 0) {
    const pago = pagosMes[0];
    document.getElementById("editar-pago-id").value = pago.id;
    document.getElementById("input-fecha-pago").value = pago.fecha;
    document.getElementById("input-interes-pago").value = pago.interesPagado;
    document.getElementById("input-capital-pago").value = pago.abonoCapital;
    document.getElementById("modal-pago-titulo").textContent = `Editar pago — ${nombreMes} ${anio}`;
  } else {
    document.getElementById("editar-pago-id").value = "";
    document.getElementById("input-fecha-pago").value = finPeriodo;
    document.getElementById("input-interes-pago").value = "";
    document.getElementById("input-capital-pago").value = "0";
    document.getElementById("modal-pago-titulo").textContent = `Registrar pago — ${nombreMes} ${anio}`;
  }

  document.getElementById("pago-resumen").innerHTML = `
    Préstamo de <b>${fmt(prestamo.capitalOriginal)} al ${prestamo.tasa}%</b><br>
    Capital pendiente actual: <b>${fmt(prestamo.capitalPendiente)}</b>
  `;
  abrirModal("modal-pago");
}

/* =========================================================
   PAGO: registrar
   ========================================================= */
function abrirModalPago(prestamoId) {
  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) return;

  document.getElementById("editar-pago-id").value = "";
  document.getElementById("modal-pago-titulo").textContent = "Registrar pago de mes";

  const acumulado = calcularInteresAcumulado(prestamo, hoyISO());
  const etiquetaMeses = acumulado.mesesAtrasados > 1 ? ` (${acumulado.mesesAtrasados} meses)` : "";

  document.getElementById("pago-prestamo-id").value = prestamoId;
  document.getElementById("input-fecha-pago").value = hoyISO();
  document.getElementById("input-interes-pago").value = acumulado.pendiente.toFixed(2);
  document.getElementById("input-capital-pago").value = "0";
  document.getElementById("pago-resumen").innerHTML = `
    Capital pendiente actual: <b>${fmt(prestamo.capitalPendiente)}</b> · Tasa: <b>${prestamo.tasa}%</b><br>
    Interés acumulado pendiente${etiquetaMeses}: <b>${fmt(acumulado.pendiente)}</b>
  `;
  abrirModal("modal-pago");
}

document.getElementById("btn-guardar-pago").addEventListener("click", async () => {
  const prestamoId = document.getElementById("pago-prestamo-id").value;
  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) return;

  const fecha = document.getElementById("input-fecha-pago").value || hoyISO();
  const interesPagado = parseFloat(document.getElementById("input-interes-pago").value) || 0;
  const abonoCapital = parseFloat(document.getElementById("input-capital-pago").value) || 0;
  const editarPagoId = document.getElementById("editar-pago-id").value;
  const acumuladoAlMomento = calcularInteresAcumulado(prestamo, fecha);

  if (editarPagoId) {
    const pagoViejo = db.pagos.find(pg => pg.id === editarPagoId);
    const diffCapital = abonoCapital - (pagoViejo ? pagoViejo.abonoCapital : 0);
    const diffInteres = interesPagado - (pagoViejo ? pagoViejo.interesPagado : 0);
    const capitalAntes = prestamo.capitalOriginal - db.pagos
      .filter(pg => pg.prestamoId === prestamoId && pg.id !== editarPagoId)
      .reduce((s, pg) => s + (pg.abonoCapital || 0), 0);
    const nuevoPendiente = Math.max(0, capitalAntes - abonoCapital);
    const nuevoEstado = nuevoPendiente === 0 ? "saldado" : "activo";

    try {
      await updateDoc(doc(dbFs, "prestamos", prestamoId), {
        capitalPendiente: nuevoPendiente,
        estado: nuevoEstado
      });
      await updateDoc(doc(dbFs, "pagos", editarPagoId), {
        fecha,
        interesCalculado: acumuladoAlMomento.pendiente,
        interesPagado,
        abonoCapital,
        capitalPendienteDespues: nuevoPendiente
      });
      cerrarModal("modal-pago");
    } catch (e) {
      alert("No se pudo editar el pago. Revisá tu conexión.");
      console.error(e);
    }
  } else {
    const capitalAntes = prestamo.capitalPendiente;
    const nuevoPendiente = Math.max(0, capitalAntes - abonoCapital);
    const nuevoEstado = nuevoPendiente === 0 ? "saldado" : "activo";

    try {
      await updateDoc(doc(dbFs, "prestamos", prestamoId), {
        capitalPendiente: nuevoPendiente,
        estado: nuevoEstado
      });
      const pagoRef = doc(collection(dbFs, "pagos"));
      await setDoc(pagoRef, {
        prestamoId,
        fecha,
        interesCalculado: acumuladoAlMomento.pendiente,
        interesPagado,
        abonoCapital,
        capitalPendienteDespues: nuevoPendiente
      });
      cerrarModal("modal-pago");
    } catch (e) {
      alert("No se pudo registrar el pago. Revisá tu conexión o la configuración de Firebase.");
      console.error(e);
    }
  }
});

/* =========================================================
   HISTORIAL
   ========================================================= */
function pintarHistorial(prestamoId) {
  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) return;
  const cliente = db.clientes.find(c => c.id === prestamo.clienteId);
  document.getElementById("historial-titulo").textContent =
    `Historial — ${cliente ? cliente.nombre : ""} (${fmt(prestamo.capitalOriginal)} al ${prestamo.tasa}%)`;

  const pagos = db.pagos
    .filter(p => p.prestamoId === prestamoId)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const body = document.getElementById("historial-body");
  body.innerHTML = "";

  if (pagos.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="hint">Todavía no hay pagos registrados.</td></tr>`;
  } else {
    pagos.forEach(pago => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatFecha(pago.fecha)}</td>
        <td class="mono">${fmt(pago.interesPagado)}</td>
        <td class="mono">${fmt(pago.abonoCapital)}</td>
        <td class="mono">${fmt(pago.capitalPendienteDespues)}</td>
        <td><button class="btn btn-danger btn-small" data-borrar-pago="${pago.id}">Borrar</button></td>
      `;
      body.appendChild(tr);
    });
  }
  body.querySelectorAll("[data-borrar-pago]").forEach(btn => {
    btn.addEventListener("click", () => borrarPago(btn.dataset.borrarPago));
  });
}

async function borrarPago(pagoId) {
  const pago = db.pagos.find(pg => pg.id === pagoId);
  if (!pago) return;
  if (!confirm(`¿Borrar el pago del ${formatFecha(pago.fecha)} (interés ${fmt(pago.interesPagado)} + abono ${fmt(pago.abonoCapital)})? Se recalcula el capital pendiente.`)) return;

  try {
    const batch = writeBatch(dbFs);
    batch.delete(doc(dbFs, "pagos", pagoId));

    const prestamo = db.prestamos.find(p => p.id === pago.prestamoId);
    if (prestamo) {
      const restantes = db.pagos
        .filter(pg => pg.prestamoId === pago.prestamoId && pg.id !== pagoId)
        .sort((a, b) => a.fecha.localeCompare(b.fecha));
      let pendiente = prestamo.capitalOriginal;
      restantes.forEach(pg => {
        pendiente = Math.max(0, pendiente - (pg.abonoCapital || 0));
        batch.update(doc(dbFs, "pagos", pg.id), { capitalPendienteDespues: pendiente });
      });
      batch.update(doc(dbFs, "prestamos", pago.prestamoId), {
        capitalPendiente: pendiente,
        estado: pendiente === 0 ? "saldado" : "activo"
      });
    }

    await batch.commit();
  } catch (e) {
    alert("No se pudo borrar el pago. Revisá tu conexión.");
    console.error(e);
  }
}

function abrirHistorial(prestamoId) {
  document.getElementById("modal-historial").dataset.prestamoId = prestamoId;
  pintarHistorial(prestamoId);
  abrirModal("modal-historial");
}

/* =========================================================
   BORRAR: cliente individual / préstamo individual / todo
   ========================================================= */
async function borrarCliente(clienteId, nombre) {
  const prestamosCliente = db.prestamos.filter(p => p.clienteId === clienteId);
  const cantidadPrestamos = prestamosCliente.length;
  const mensaje = cantidadPrestamos > 0
    ? `¿Borrar a "${nombre}" junto con ${cantidadPrestamos} préstamo(s) y todo su historial de pagos? Esta acción no se puede deshacer.`
    : `¿Borrar a "${nombre}"? Esta acción no se puede deshacer.`;

  if (!confirm(mensaje)) return;

  try {
    const batch = writeBatch(dbFs);
    prestamosCliente.forEach(p => {
      db.pagos.filter(pg => pg.prestamoId === p.id).forEach(pg => {
        batch.delete(doc(dbFs, "pagos", pg.id));
      });
      batch.delete(doc(dbFs, "prestamos", p.id));
    });
    batch.delete(doc(dbFs, "clientes", clienteId));
    await batch.commit();
  } catch (e) {
    alert("No se pudo borrar. Revisá tu conexión.");
    console.error(e);
  }
}

async function borrarPrestamo(prestamoId) {
  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) return;

  if (!confirm(`¿Borrar este préstamo de ${fmt(prestamo.capitalOriginal)} y todo su historial de pagos? Esta acción no se puede deshacer.`)) return;

  try {
    const batch = writeBatch(dbFs);
    db.pagos.filter(pg => pg.prestamoId === prestamoId).forEach(pg => {
      batch.delete(doc(dbFs, "pagos", pg.id));
    });
    batch.delete(doc(dbFs, "prestamos", prestamoId));
    await batch.commit();
  } catch (e) {
    alert("No se pudo borrar. Revisá tu conexión.");
    console.error(e);
  }
}

document.getElementById("btn-borrar-todo").addEventListener("click", async () => {
  if (!confirm("¿Seguro que querés borrar todos los clientes, préstamos y pagos de TODOS? Esta acción no se puede deshacer.")) return;
  try {
    const batch = writeBatch(dbFs);
    db.clientes.forEach(c => batch.delete(doc(dbFs, "clientes", c.id)));
    db.prestamos.forEach(p => batch.delete(doc(dbFs, "prestamos", p.id)));
    db.pagos.forEach(pg => batch.delete(doc(dbFs, "pagos", pg.id)));
    await batch.commit();
  } catch (e) {
    alert("No se pudo borrar todo. Revisá tu conexión.");
    console.error(e);
  }
});

/* =========================================================
   CALCULADORA RÁPIDA (no usa Firebase, es solo una simulación)
   ========================================================= */
document.querySelectorAll("#calc-rate-toggle .rate-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    setRateToggle("calc-rate-toggle", Number(btn.dataset.rate));
    actualizarCalculadora();
  });
});
document.getElementById("calc-capital").addEventListener("input", actualizarCalculadora);

function actualizarCalculadora() {
  const capital = parseFloat(document.getElementById("calc-capital").value) || 0;
  const tasa = getRateToggle("calc-rate-toggle");
  const interes = capital * (tasa / 100);
  const total = capital + interes;

  document.getElementById("calc-stamp").textContent = tasa + "%";
  document.getElementById("calc-out-capital").textContent = fmt(capital);
  document.getElementById("calc-out-interes").textContent = fmt(interes);
  document.getElementById("calc-out-total").textContent = fmt(total);
}
actualizarCalculadora();

/* ---- simulación de abonos parciales mes a mes ---- */
let simRows = [];

document.getElementById("btn-add-sim-row").addEventListener("click", () => {
  simRows.push({ abono: 0 });
  renderSim();
});

function renderSim() {
  const capitalInicial = parseFloat(document.getElementById("calc-capital").value) || 0;
  const tasa = getRateToggle("calc-rate-toggle");
  const cont = document.getElementById("calc-sim-rows");
  cont.innerHTML = "";

  let pendiente = capitalInicial;

  simRows.forEach((row, idx) => {
    const interesMes = pendiente * (tasa / 100);

    const div = document.createElement("div");
    div.className = "sim-row";
    div.innerHTML = `
      <label>Mes ${idx + 1} — interés
        <span class="sim-out mono">${fmt(interesMes)} (sobre ${fmt(pendiente)})</span>
      </label>
      <label>Abono a capital
        <input type="number" min="0" step="0.01" value="${row.abono}" data-idx="${idx}" class="sim-abono">
      </label>
      <button type="button" class="btn btn-ghost btn-small sim-del" data-idx="${idx}">Quitar</button>
    `;
    cont.appendChild(div);

    pendiente = Math.max(0, pendiente - row.abono);
  });

  cont.querySelectorAll(".sim-abono").forEach(input => {
    input.addEventListener("input", e => {
      const idx = Number(e.target.dataset.idx);
      simRows[idx].abono = parseFloat(e.target.value) || 0;
      renderSim();
    });
  });
  cont.querySelectorAll(".sim-del").forEach(btn => {
    btn.addEventListener("click", e => {
      const idx = Number(e.target.dataset.idx);
      simRows.splice(idx, 1);
      renderSim();
    });
  });
}

/* =========================================================
   RESPALDO: exportar / importar (ahora lee/escribe en Firebase)
   ========================================================= */
document.getElementById("btn-exportar").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `prestamos-${hoyISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("input-importar").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.clientes || !data.prestamos || !data.pagos) throw new Error("Formato inválido");

      if (!confirm("Esto reemplaza TODOS los datos actuales (de todos los familiares) por los del archivo importado. ¿Continuar?")) return;

      const batchBorrar = writeBatch(dbFs);
      db.clientes.forEach(c => batchBorrar.delete(doc(dbFs, "clientes", c.id)));
      db.prestamos.forEach(p => batchBorrar.delete(doc(dbFs, "prestamos", p.id)));
      db.pagos.forEach(pg => batchBorrar.delete(doc(dbFs, "pagos", pg.id)));
      await batchBorrar.commit();

      const batchEscribir = writeBatch(dbFs);
      data.clientes.forEach(c => {
        const { id, ...resto } = c;
        batchEscribir.set(doc(dbFs, "clientes", id || nuevoId()), resto);
      });
      data.prestamos.forEach(p => {
        const { id, ...resto } = p;
        batchEscribir.set(doc(dbFs, "prestamos", id || nuevoId()), resto);
      });
      data.pagos.forEach(pg => {
        const { id, ...resto } = pg;
        batchEscribir.set(doc(dbFs, "pagos", id || nuevoId()), resto);
      });
      await batchEscribir.commit();

      alert("Datos importados correctamente.");
    } catch (err) {
      alert("El archivo no tiene el formato esperado o hubo un error al importar.");
      console.error(err);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

/* =========================================================
   INICIO
   ========================================================= */
renderClientes();
