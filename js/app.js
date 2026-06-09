/**
 * app.js — Frontend Logic Kalender Akademik
 * STMIK Bina Patria Magelang
 */

// ============================================================
//  STATE GLOBAL
// ============================================================
const State = {
  token:        localStorage.getItem("ka_token") || null,
  user:         JSON.parse(localStorage.getItem("ka_user") || "null"),
  tahunAjaran:  [],
  kategori:     [],
  overrides:    [],
  events:       [],
  holidays:     [],
  filter:       { tahun: "", semester: "" },
  calendar:     null,
  editEventId:  null,   // untuk modal event (edit mode)
  confirmCb:    null,   // callback confirm dialog
};

// ============================================================
//  API HELPER
// ============================================================
async function apiGet(params = {}) {
  const url = new URL(CONFIG.GAS_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  return res.json();
}

async function apiPost(body = {}) {
  body.token = State.token || "";
  // GAS Web App harus menggunakan no-cors workaround:
  // Kirim sebagai form parameter "payload" berisi JSON string
  const formData = new FormData();
  formData.append("payload", JSON.stringify(body));
  const res = await fetch(CONFIG.GAS_URL, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

// ============================================================
//  INIT
// ============================================================
document.addEventListener("DOMContentLoaded", async () => {
  setupModalCloseButtons();
  setupLoginHandlers();
  setupEventModalHandlers();
  setupKategoriHandlers();
  setupOverrideHandlers();

  updateAuthUI();
  await loadInitialData();
  initCalendar();
});

async function loadInitialData() {
  showLoading(true);
  try {
    // Load semua data paralel
    const [taRes, katRes, ovRes] = await Promise.all([
      apiGet({ action: "getTahunAjaran" }),
      apiGet({ action: "getKategori" }),
      apiGet({ action: "getOverrides" }),
    ]);

    State.tahunAjaran = taRes.data || [];
    State.kategori    = katRes.data || [];
    State.overrides   = ovRes.data || [];

    populateTahunDropdowns();
    populateLegend();
  } catch (e) {
    showToast("Gagal memuat data awal. Cek koneksi.", "error");
  }
}

// ============================================================
//  CALENDAR INIT
// ============================================================
function initCalendar() {
  const el = document.getElementById("calendar");

  // Tentukan default filter (tahun ajaran & semester berjalan)
  const defaultTahun = CONFIG.DEFAULT_TAHUN_AJARAN;
  const defaultSem   = CONFIG.DEFAULT_SEMESTER;

  // Set filter dropdown ke default
  const selTahun = document.getElementById("filter-tahun");
  const selSem   = document.getElementById("filter-semester");

  // Cari apakah default ada di list
  if (State.tahunAjaran.includes(defaultTahun)) selTahun.value = defaultTahun;
  selSem.value = defaultSem;

  State.filter.tahun    = selTahun.value;
  State.filter.semester = selSem.value;

  State.calendar = new FullCalendar.Calendar(el, {
    initialView:   "dayGridMonth",
    locale:        "id",
    headerToolbar: {
      left:   "prev,next today",
      center: "title",
      right:  "dayGridMonth,dayGridWeek,listMonth",
    },
    buttonText: {
      today:      "Hari Ini",
      month:      "Bulan",
      week:       "Minggu",
      list:       "Agenda",
    },
    height:       "auto",
    eventDisplay: "block",
    events:       fetchCalendarEvents,

    // Klik event
    eventClick: (info) => {
      const ev = info.event;
      const isHoliday = ev.extendedProps.type === "holiday";
      openDetailModal(ev, isHoliday);
    },

    // Klik tanggal kosong (admin saja)
    dateClick: (info) => {
      if (!State.token) return;
      openEventModal(null, info.dateStr);
    },
  });

  State.calendar.render();
  showLoading(false);

  // Filter change
  selTahun.addEventListener("change", () => {
    State.filter.tahun = selTahun.value;
    State.calendar.refetchEvents();
  });
  selSem.addEventListener("change", () => {
    State.filter.semester = selSem.value;
    State.calendar.refetchEvents();
  });
}

// ============================================================
//  FETCH EVENTS (dipanggil FullCalendar)
// ============================================================
async function fetchCalendarEvents(fetchInfo, successCb, failureCb) {
  try {
    const params = { action: "getEvents" };
    if (State.filter.tahun)    params.tahun_ajaran = State.filter.tahun;
    if (State.filter.semester) params.semester     = State.filter.semester;

    // Tahun untuk libur nasional
    const year = fetchInfo.start.getFullYear();

    const [evRes, holRes] = await Promise.all([
      apiGet(params),
      apiGet({ action: "getHolidays", year }),
    ]);

    State.events   = evRes.data  || [];
    State.holidays = holRes.data || [];

    const allEvents = [];

    // Jadwal akademik
    State.events.forEach(ev => {
      allEvents.push({
        id:    ev.id,
        title: ev.title,
        start: ev.start,
        end:   ev.end,
        color: ev.color,
        extendedProps: {
          type:          "event",
          tahun_ajaran:  ev.tahun_ajaran,
          semester:      ev.semester,
          kategori_nama: ev.kategori_nama,
          kategori_id:   ev.kategori_id,
          deskripsi:     ev.deskripsi,
          created_by:    ev.created_by,
        },
      });
    });

    // Libur nasional (dengan override logic)
    const hideDates = new Set(
      State.overrides.filter(o => o.action === "hide").map(o => o.tanggal)
    );
    const addOverrides = State.overrides.filter(o => o.action === "add");

    State.holidays.forEach(h => {
      if (hideDates.has(h.holiday_date)) return; // di-hide
      allEvents.push({
        id:        "hol_" + h.holiday_date,
        title:     "🔴 " + h.holiday_name,
        start:     h.holiday_date,
        allDay:    true,
        classNames: ["holiday-event"],
        extendedProps: { type: "holiday", holiday_name: h.holiday_name },
      });
    });

    // Libur manual (add override)
    addOverrides.forEach(o => {
      allEvents.push({
        id:        "ov_" + o.id,
        title:     "🔴 " + o.nama_pengganti,
        start:     o.tanggal,
        allDay:    true,
        classNames: ["holiday-event"],
        extendedProps: { type: "holiday_manual", keterangan: o.keterangan },
      });
    });

    successCb(allEvents);
  } catch (e) {
    failureCb(e);
  }
}

// ============================================================
//  AUTH
// ============================================================
function setupLoginHandlers() {
  document.getElementById("btn-login-open").addEventListener("click", () => openModal("modal-login"));

  document.getElementById("btn-do-login").addEventListener("click", doLogin);

  document.getElementById("login-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });

  document.getElementById("btn-logout").addEventListener("click", doLogout);
}

async function doLogin() {
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl    = document.getElementById("login-error");

  if (!username || !password) {
    showError(errEl, "Username dan password wajib diisi.");
    return;
  }

  setLoading("btn-do-login", true);
  try {
    const res = await apiPost({ action: "login", username, password });
    if (res.status === "ok") {
      State.token = res.token;
      State.user  = res.user;
      localStorage.setItem("ka_token", res.token);
      localStorage.setItem("ka_user",  JSON.stringify(res.user));
      closeModal("modal-login");
      updateAuthUI();
      showToast("Selamat datang, " + res.user.nama + "!", "success");
      document.getElementById("login-username").value = "";
      document.getElementById("login-password").value = "";
    } else {
      showError(errEl, res.message);
    }
  } catch (e) {
    showError(errEl, "Gagal terhubung ke server.");
  }
  setLoading("btn-do-login", false);
}

async function doLogout() {
  if (State.token) await apiPost({ action: "logout" });
  State.token = null;
  State.user  = null;
  localStorage.removeItem("ka_token");
  localStorage.removeItem("ka_user");
  updateAuthUI();
  showToast("Berhasil keluar.", "success");
}

function updateAuthUI() {
  const isLoggedIn = !!State.token;
  document.getElementById("state-public").style.display    = isLoggedIn ? "none"  : "flex";
  document.getElementById("state-logged-in").style.display = isLoggedIn ? "flex"  : "none";
  document.getElementById("toolbar-admin").style.display   = isLoggedIn ? "flex"  : "none";

  if (isLoggedIn && State.user) {
    document.getElementById("admin-name").textContent = State.user.nama || State.user.username;
  }
}

// ============================================================
//  EVENT MODAL (Tambah / Edit)
// ============================================================
function setupEventModalHandlers() {
  document.getElementById("btn-add-event").addEventListener("click", () => openEventModal(null, null));
  document.getElementById("btn-save-event").addEventListener("click", saveEvent);
  document.getElementById("btn-delete-event").addEventListener("click", () => {
    openConfirm("Yakin ingin menghapus kegiatan ini?", deleteEvent);
  });
}

function openEventModal(eventData, dateStr) {
  const isEdit = !!eventData;
  document.getElementById("modal-event-title").textContent = isEdit ? "Edit Kegiatan" : "Tambah Kegiatan";
  document.getElementById("btn-delete-event").style.display = isEdit ? "inline-flex" : "none";

  // Reset form
  document.getElementById("event-id").value       = isEdit ? eventData.id : "";
  document.getElementById("event-nama").value     = isEdit ? (eventData.extendedProps?.nama_kegiatan || eventData.title) : "";
  document.getElementById("event-tahun").value    = isEdit ? eventData.extendedProps?.tahun_ajaran : (State.filter.tahun || CONFIG.DEFAULT_TAHUN_AJARAN);
  document.getElementById("event-semester").value = isEdit ? eventData.extendedProps?.semester : (State.filter.semester || CONFIG.DEFAULT_SEMESTER);
  document.getElementById("event-mulai").value    = isEdit ? eventData.startStr : (dateStr || "");
  document.getElementById("event-deskripsi").value = isEdit ? (eventData.extendedProps?.deskripsi || "") : "";

  // End date: FullCalendar end sudah +1, kembalikan ke asli
  if (isEdit && eventData.end) {
    const endFixed = new Date(eventData.end);
    endFixed.setDate(endFixed.getDate() - 1);
    document.getElementById("event-selesai").value = endFixed.toISOString().slice(0,10);
  } else {
    document.getElementById("event-selesai").value = dateStr || "";
  }

  // Populate kategori dropdown
  const selKat = document.getElementById("event-kategori");
  selKat.innerHTML = '<option value="">— pilih kategori —</option>';
  State.kategori.forEach(k => {
    const opt = document.createElement("option");
    opt.value = k.id;
    opt.textContent = k.nama;
    if (isEdit && eventData.extendedProps?.kategori_id === k.id) opt.selected = true;
    selKat.appendChild(opt);
  });

  hideError(document.getElementById("event-error"));
  State.editEventId = isEdit ? eventData.id : null;
  openModal("modal-event");
}

async function saveEvent() {
  const id         = document.getElementById("event-id").value;
  const isEdit     = !!id;
  const nama       = document.getElementById("event-nama").value.trim();
  const tahun      = document.getElementById("event-tahun").value;
  const semester   = document.getElementById("event-semester").value;
  const mulai      = document.getElementById("event-mulai").value;
  const selesai    = document.getElementById("event-selesai").value;
  const kategori   = document.getElementById("event-kategori").value;
  const deskripsi  = document.getElementById("event-deskripsi").value.trim();
  const errEl      = document.getElementById("event-error");

  if (!nama || !tahun || !semester || !mulai || !selesai || !kategori) {
    showError(errEl, "Semua field bertanda * wajib diisi.");
    return;
  }
  if (selesai < mulai) {
    showError(errEl, "Tanggal selesai tidak boleh sebelum tanggal mulai.");
    return;
  }

  setLoading("btn-save-event", true);
  try {
    const payload = {
      action:          isEdit ? "updateEvent" : "addEvent",
      tahun_ajaran:    tahun,
      semester,
      nama_kegiatan:   nama,
      tanggal_mulai:   mulai,
      tanggal_selesai: selesai,
      kategori_id:     kategori,
      deskripsi,
    };
    if (isEdit) payload.event_id = id;

    const res = await apiPost(payload);
    if (res.status === "ok") {
      closeModal("modal-event");
      State.calendar.refetchEvents();
      showToast(isEdit ? "Kegiatan berhasil diupdate." : "Kegiatan berhasil ditambahkan.", "success");
    } else {
      showError(errEl, res.message);
    }
  } catch (e) {
    showError(errEl, "Gagal menyimpan data.");
  }
  setLoading("btn-save-event", false);
}

async function deleteEvent() {
  const id = document.getElementById("event-id").value;
  if (!id) return;
  try {
    const res = await apiPost({ action: "deleteEvent", event_id: id });
    if (res.status === "ok") {
      closeModal("modal-event");
      closeModal("modal-detail");
      State.calendar.refetchEvents();
      showToast("Kegiatan berhasil dihapus.", "success");
    } else {
      showToast(res.message, "error");
    }
  } catch (e) {
    showToast("Gagal menghapus.", "error");
  }
}

// ============================================================
//  DETAIL MODAL
// ============================================================
function openDetailModal(ev, isHoliday) {
  const props = ev.extendedProps;

  document.getElementById("detail-title").textContent = isHoliday
    ? (props.holiday_name || ev.title.replace("🔴 ", ""))
    : ev.title;

  // Format tanggal
  const startDate = ev.start ? formatDate(ev.start) : "-";
  const endRaw    = ev.end   ? new Date(ev.end)      : null;
  if (endRaw) endRaw.setDate(endRaw.getDate() - 1);
  const endDate = endRaw ? formatDate(endRaw) : startDate;
  const tanggalStr = startDate === endDate ? startDate : startDate + " s/d " + endDate;

  document.getElementById("detail-tanggal").textContent   = tanggalStr;
  document.getElementById("detail-kategori").textContent  = isHoliday ? "Hari Libur Nasional" : (props.kategori_nama || "-");
  document.getElementById("detail-semester").textContent  = isHoliday ? "-" : (props.semester || "-");
  document.getElementById("detail-tahun").textContent     = isHoliday ? "-" : (props.tahun_ajaran || "-");

  const descRow  = document.getElementById("detail-desc-row");
  const descVal  = document.getElementById("detail-deskripsi");
  if (props.deskripsi || props.keterangan) {
    descVal.textContent = props.deskripsi || props.keterangan;
    descRow.style.display = "grid";
  } else {
    descRow.style.display = "none";
  }

  // Tombol edit hanya untuk admin dan bukan libur nasional
  const adminActions = document.getElementById("detail-admin-actions");
  if (State.token && !isHoliday) {
    adminActions.style.display = "flex";
    document.getElementById("btn-edit-from-detail").onclick = () => {
      closeModal("modal-detail");
      openEventModal(ev, null);
    };
  } else {
    adminActions.style.display = "none";
  }

  openModal("modal-detail");
}

// ============================================================
//  KATEGORI MODAL
// ============================================================
function setupKategoriHandlers() {
  document.getElementById("btn-manage-kategori").addEventListener("click", () => {
    renderKategoriTable();
    openModal("modal-kategori");
  });

  document.getElementById("btn-save-kategori").addEventListener("click", saveKategori);
  document.getElementById("btn-cancel-kat").addEventListener("click", resetKatForm);
}

function renderKategoriTable() {
  const tbody = document.getElementById("kat-table-body");
  tbody.innerHTML = "";

  if (!State.kategori.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Belum ada kategori.</td></tr>';
    return;
  }

  // Reload all kategori (termasuk inactive) khusus untuk table
  apiGet({ action: "getKategori" }).then(res => {
    // Untuk table, kita load ulang semua (state.kategori hanya aktif)
    // Karena API hanya return aktif, kita tampilkan dari state saja
    State.kategori.forEach(k => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="color-swatch" style="background:${k.warna}"></span></td>
        <td>${k.nama}</td>
        <td><span class="badge badge-active">Aktif</span></td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="editKategori('${k.id}','${k.nama}','${k.warna}')">
            Edit
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteKategori('${k.id}','${k.nama}')">
            Hapus
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  });
}

function editKategori(id, nama, warna) {
  document.getElementById("kat-edit-id").value = id;
  document.getElementById("kat-nama").value    = nama;
  document.getElementById("kat-warna").value   = warna;
  document.getElementById("btn-cancel-kat").style.display = "inline-flex";
  document.getElementById("btn-save-kategori").innerHTML  =
    '<span class="iconify" data-icon="mdi:content-save-outline"></span> Update';
}

function resetKatForm() {
  document.getElementById("kat-edit-id").value = "";
  document.getElementById("kat-nama").value    = "";
  document.getElementById("kat-warna").value   = "#3498db";
  document.getElementById("btn-cancel-kat").style.display = "none";
  document.getElementById("btn-save-kategori").innerHTML  =
    '<span class="iconify" data-icon="mdi:plus"></span> Simpan';
}

async function saveKategori() {
  const id    = document.getElementById("kat-edit-id").value;
  const nama  = document.getElementById("kat-nama").value.trim();
  const warna = document.getElementById("kat-warna").value;
  const errEl = document.getElementById("kat-error");

  if (!nama) { showError(errEl, "Nama kategori wajib diisi."); return; }

  setLoading("btn-save-kategori", true);
  try {
    const payload = id
      ? { action: "updateKategori", kategori_id: id, nama_kategori: nama, warna }
      : { action: "addKategori", nama_kategori: nama, warna };

    const res = await apiPost(payload);
    if (res.status === "ok") {
      resetKatForm();
      hideError(errEl);
      // Reload kategori
      const katRes    = await apiGet({ action: "getKategori" });
      State.kategori  = katRes.data || [];
      populateLegend();
      renderKategoriTable();
      State.calendar.refetchEvents();
      showToast(id ? "Kategori diupdate." : "Kategori ditambahkan.", "success");
    } else {
      showError(errEl, res.message);
    }
  } catch (e) {
    showError(errEl, "Gagal menyimpan kategori.");
  }
  setLoading("btn-save-kategori", false);
}

function deleteKategori(id, nama) {
  openConfirm(`Nonaktifkan kategori "${nama}"? Event yang sudah ada tidak terpengaruh.`, async () => {
    const res = await apiPost({ action: "deleteKategori", kategori_id: id });
    if (res.status === "ok") {
      const katRes   = await apiGet({ action: "getKategori" });
      State.kategori = katRes.data || [];
      populateLegend();
      renderKategoriTable();
      showToast("Kategori dinonaktifkan.", "success");
    } else {
      showToast(res.message, "error");
    }
  });
}

// ============================================================
//  OVERRIDE MODAL
// ============================================================
function setupOverrideHandlers() {
  document.getElementById("btn-manage-override").addEventListener("click", () => {
    renderOverrideTable();
    openModal("modal-override");
  });

  document.getElementById("btn-save-override").addEventListener("click", saveOverride);

  document.getElementById("ov-action").addEventListener("change", () => {
    const action = document.getElementById("ov-action").value;
    document.getElementById("ov-nama-wrap").style.display = action === "add" ? "flex" : "none";
  });
  // Initial state
  document.getElementById("ov-nama-wrap").style.display = "none";
}

function renderOverrideTable() {
  const tbody = document.getElementById("ov-table-body");
  tbody.innerHTML = "";

  if (!State.overrides.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Belum ada override.</td></tr>';
    return;
  }

  State.overrides.forEach(o => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span style="font-family:var(--mono);font-size:12px">${o.tanggal}</span></td>
      <td><span class="badge badge-${o.action}">${o.action}</span></td>
      <td>${o.nama_pengganti || "-"}</td>
      <td>${o.keterangan || "-"}</td>
      <td>${o.created_by || "-"}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="deleteOverrideRow('${o.id}')">Hapus</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function saveOverride() {
  const tanggal  = document.getElementById("ov-tanggal").value;
  const action   = document.getElementById("ov-action").value;
  const nama     = document.getElementById("ov-nama").value.trim();
  const ket      = document.getElementById("ov-keterangan").value.trim();
  const pin      = document.getElementById("ov-pin").value;
  const errEl    = document.getElementById("ov-error");

  if (!tanggal)              { showError(errEl, "Tanggal wajib diisi."); return; }
  if (!pin)                  { showError(errEl, "PIN wajib diisi."); return; }
  if (action === "add" && !nama) { showError(errEl, "Nama libur wajib diisi untuk action 'add'."); return; }

  setLoading("btn-save-override", true);
  try {
    const res = await apiPost({
      action:         "addOverride",
      tanggal,
      action:          action,
      nama_pengganti:  nama,
      keterangan:      ket,
      pin,
    });
    if (res.status === "ok") {
      // Reset form
      document.getElementById("ov-tanggal").value    = "";
      document.getElementById("ov-nama").value       = "";
      document.getElementById("ov-keterangan").value = "";
      document.getElementById("ov-pin").value        = "";
      hideError(errEl);

      // Reload overrides
      const ovRes    = await apiGet({ action: "getOverrides" });
      State.overrides = ovRes.data || [];
      renderOverrideTable();
      State.calendar.refetchEvents();
      showToast("Override berhasil disimpan.", "success");
    } else {
      showError(errEl, res.message);
    }
  } catch (e) {
    showError(errEl, "Gagal menyimpan override.");
  }
  setLoading("btn-save-override", false);
}

function deleteOverrideRow(id) {
  const pin = prompt("Masukkan PIN untuk menghapus override:");
  if (pin === null) return;

  openConfirm("Yakin ingin menghapus override ini?", async () => {
    const res = await apiPost({ action: "deleteOverride", override_id: id, pin });
    if (res.status === "ok") {
      const ovRes    = await apiGet({ action: "getOverrides" });
      State.overrides = ovRes.data || [];
      renderOverrideTable();
      State.calendar.refetchEvents();
      showToast("Override dihapus.", "success");
    } else {
      showToast(res.message, "error");
    }
  });
}

// ============================================================
//  LEGEND
// ============================================================
function populateLegend() {
  const wrap = document.getElementById("legend-wrap");
  wrap.innerHTML = "";

  State.kategori.forEach(k => {
    const div = document.createElement("div");
    div.className = "legend-item";
    div.innerHTML = `<span class="legend-dot" style="background:${k.warna}"></span>${k.nama}`;
    wrap.appendChild(div);
  });

  // Libur nasional
  const div = document.createElement("div");
  div.className = "legend-item";
  div.innerHTML = `<span class="legend-dot" style="background:#e05c5c"></span>Libur Nasional`;
  wrap.appendChild(div);
}

// ============================================================
//  POPULATE DROPDOWNS
// ============================================================
function populateTahunDropdowns() {
  const filterSel = document.getElementById("filter-tahun");
  const eventSel  = document.getElementById("event-tahun");

  // Filter dropdown
  filterSel.innerHTML = '<option value="">Semua</option>';
  State.tahunAjaran.forEach(ta => {
    const opt = document.createElement("option");
    opt.value = ta;
    opt.textContent = ta;
    filterSel.appendChild(opt);
  });

  // Event form dropdown
  eventSel.innerHTML = '<option value="">— pilih —</option>';
  State.tahunAjaran.forEach(ta => {
    const opt = document.createElement("option");
    opt.value = ta;
    opt.textContent = ta;
    eventSel.appendChild(opt);
  });
}

// ============================================================
//  MODAL HELPERS
// ============================================================
function setupModalCloseButtons() {
  // Tombol close (×)
  document.querySelectorAll(".modal-close, [data-close]").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.close;
      if (target) closeModal(target);
    });
  });

  // Klik backdrop untuk tutup
  document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });

  // Konfirmasi
  document.getElementById("btn-confirm-yes").addEventListener("click", () => {
    closeModal("modal-confirm");
    if (State.confirmCb) State.confirmCb();
    State.confirmCb = null;
  });
}

function openModal(id)  { document.getElementById(id).style.display = "flex"; }
function closeModal(id) { document.getElementById(id).style.display = "none"; }

function openConfirm(message, cb) {
  document.getElementById("confirm-message").textContent = message;
  State.confirmCb = cb;
  openModal("modal-confirm");
}

// ============================================================
//  UI UTILITIES
// ============================================================
function showLoading(show) {
  const el = document.getElementById("loading-overlay");
  el.classList.toggle("hidden", !show);
}

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = "block";
}

function hideError(el) {
  el.style.display = "none";
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.style.opacity = loading ? ".6" : "1";
}

function showToast(msg, type = "success") {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className   = "toast " + type;
  toast.style.display = "block";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.display = "none"; }, 3200);
}

function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}