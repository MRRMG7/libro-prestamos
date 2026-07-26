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

let db = { clientes: [], prestamos: [], pagos: [] };

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
  el.style.color = ok ? "#BFE3C9" : "#E3B3AE";
}
setEstadoSync("Conectando…", true);
window.addEventListener("offline", () => setEstadoSync("Sin conexión — se sincroniza al volver", false));
window.addEventListener("online", () => setEstadoSync("Conectado", true));

/* ---------- Acceso: solo la familia entra ---------- */
onAuthStateChanged(auth, user => {
  const loginScreen = document.getElementById("login-screen");
  const appRoot = document.getElementById("app-root");
  const btnLogout = document.getElementById("btn-logout");

  if (user) {
    loginScreen.style.display = "none";
    appRoot.hidden = false;
    btnLogout.hidden = false;
  } else {
    loginScreen.style.display = "flex";
    appRoot.hidden = true;
    btnLogout.hidden = true;
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
    errorEl.textContent = "Correo o contraseña incorrectos.";
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

/* =========================================================
   SUSCRIPCIONES EN TIEMPO REAL A FIRESTORE
   Cualquier cambio (propio o de otro familiar) llega aquí y
   se vuelve a dibujar la pantalla automáticamente.
   ========================================================= */
onSnapshot(collection(dbFs, "clientes"), snap => {
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

onSnapshot(collection(dbFs, "prestamos"), snap => {
  db.prestamos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderClientes();
});

onSnapshot(collection(dbFs, "pagos"), snap => {
  db.pagos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderClientes();
  // si el modal de historial está abierto, lo refrescamos también
  const modalHist = document.getElementById("modal-historial");
  if (modalHist.classList.contains("open")) {
    const prestamoId = modalHist.dataset.prestamoId;
    if (prestamoId) pintarHistorial(prestamoId);
  }
});

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
}

/* =========================================================
   RENDER: lista de clientes y sus préstamos
   ========================================================= */
function renderClientes() {
  const cont = document.getElementById("lista-clientes");
  const emptyHint = document.getElementById("empty-clientes");
  cont.innerHTML = "";

  if (db.clientes.length === 0) {
    emptyHint.hidden = false;
    renderTotales();
    return;
  }
  emptyHint.hidden = true;

  db.clientes.forEach(cliente => {
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

    const btnPrestar = document.createElement("button");
    btnPrestar.className = "btn btn-ghost btn-small";
    btnPrestar.textContent = "+ Préstamo";
    btnPrestar.addEventListener("click", () => abrirModalPrestamo(cliente.id));
    acciones.appendChild(btnPrestar);

    const btnBorrarCliente = document.createElement("button");
    btnBorrarCliente.className = "btn btn-danger btn-small";
    btnBorrarCliente.textContent = "Borrar cliente";
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
  info.innerHTML = `
    <span class="prestamo-capital mono">${fmt(prestamo.capitalPendiente)} pendiente
      <span class="badge ${saldado ? "badge-saldado" : "badge-pendiente"}">${saldado ? "Saldado" : "Activo"}</span>
    </span>
    <span class="prestamo-meta">Capital original ${fmt(prestamo.capitalOriginal)} · prestado ${prestamo.fecha}</span>
    ${!saldado ? `<span class="prestamo-meta">Interés de este mes: ${fmt(interesDelMes(prestamo))}</span>` : ""}
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

  const btnBorrarPrestamo = document.createElement("button");
  btnBorrarPrestamo.className = "btn btn-danger btn-small";
  btnBorrarPrestamo.textContent = "Borrar préstamo";
  btnBorrarPrestamo.addEventListener("click", () => borrarPrestamo(prestamo.id));
  acciones.appendChild(btnBorrarPrestamo);

  ticket.appendChild(stamp);
  ticket.appendChild(info);
  ticket.appendChild(acciones);
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
  document.getElementById("input-nombre-cliente").value = "";
  abrirModal("modal-cliente");
});

document.getElementById("btn-guardar-cliente").addEventListener("click", async () => {
  const nombre = document.getElementById("input-nombre-cliente").value.trim();
  if (!nombre) return;
  try {
    const ref = doc(collection(dbFs, "clientes"));
    await setDoc(ref, { nombre });
    cerrarModal("modal-cliente");
  } catch (e) {
    alert("No se pudo guardar el cliente. Revisá tu conexión o la configuración de Firebase.");
    console.error(e);
  }
});

/* =========================================================
   PRÉSTAMO: crear
   ========================================================= */
function abrirModalPrestamo(clienteId) {
  document.getElementById("prestamo-cliente-id").value = clienteId;
  document.getElementById("input-capital-prestamo").value = "";
  document.getElementById("input-fecha-prestamo").value = hoyISO();
  setRateToggle("prestamo-rate-toggle", 8);
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

  if (!capital || capital <= 0) return;

  try {
    const ref = doc(collection(dbFs, "prestamos"));
    await setDoc(ref, {
      clienteId,
      capitalOriginal: capital,
      capitalPendiente: capital,
      tasa,
      fecha,
      estado: "activo"
    });
    cerrarModal("modal-prestamo");
  } catch (e) {
    alert("No se pudo guardar el préstamo. Revisá tu conexión o la configuración de Firebase.");
    console.error(e);
  }
});

/* =========================================================
   PAGO: registrar
   ========================================================= */
function abrirModalPago(prestamoId) {
  const prestamo = db.prestamos.find(p => p.id === prestamoId);
  if (!prestamo) return;

  document.getElementById("pago-prestamo-id").value = prestamoId;
  document.getElementById("input-fecha-pago").value = hoyISO();
  document.getElementById("input-interes-pago").value = interesDelMes(prestamo).toFixed(2);
  document.getElementById("input-capital-pago").value = "0";
  document.getElementById("pago-resumen").innerHTML = `
    Capital pendiente actual: <b>${fmt(prestamo.capitalPendiente)}</b> · Tasa: <b>${prestamo.tasa}%</b><br>
    Interés sugerido para este mes: <b>${fmt(interesDelMes(prestamo))}</b>
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
      interesCalculado: interesDelMes({ ...prestamo, capitalPendiente: capitalAntes }),
      interesPagado,
      abonoCapital,
      capitalPendienteDespues: nuevoPendiente
    });

    cerrarModal("modal-pago");
  } catch (e) {
    alert("No se pudo registrar el pago. Revisá tu conexión o la configuración de Firebase.");
    console.error(e);
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
    body.innerHTML = `<tr><td colspan="4" class="hint">Todavía no hay pagos registrados.</td></tr>`;
  } else {
    pagos.forEach(pago => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${pago.fecha}</td>
        <td class="mono">${fmt(pago.interesPagado)}</td>
        <td class="mono">${fmt(pago.abonoCapital)}</td>
        <td class="mono">${fmt(pago.capitalPendienteDespues)}</td>
      `;
      body.appendChild(tr);
    });
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
