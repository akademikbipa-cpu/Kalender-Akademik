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
  setupTahunAjaranHandlers();
  setupExportHandler();

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

  const selTahun = document.getElementById("filter-tahun");
  const selSem   = document.getElementById("filter-semester");

  // Tentukan tahun ajaran awal, prioritas:
  //  1) pilihan terakhir user (localStorage) — biar refresh tidak reset
  //  2) default dari config, jika memang ada di daftar
  //  3) entri pertama daftar TA (samakan dengan halaman export)
  const savedTahun = localStorage.getItem("ka_filter_tahun");
  const savedSem   = localStorage.getItem("ka_filter_semester");

  let initTahun = "";
  if (savedTahun && State.tahunAjaran.includes(savedTahun)) {
    initTahun = savedTahun;
  } else if (State.tahunAjaran.includes(CONFIG.DEFAULT_TAHUN_AJARAN)) {
    initTahun = CONFIG.DEFAULT_TAHUN_AJARAN;
  } else {
    initTahun = State.tahunAjaran[0] || "";
  }

  selTahun.value = initTahun;
  selSem.value   = savedSem || CONFIG.DEFAULT_SEMESTER;

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
  gotoSemesterStart(State.filter.tahun, State.filter.semester);
  showLoading(false);

  // Filter diterapkan hanya lewat tombol "Terapkan" (bukan on-change),
  // agar bulan yang tampil selalu cocok dengan filter dan tidak salah baca.
  const btnApply = document.getElementById("filter-apply");
  if (btnApply) {
    btnApply.addEventListener("click", () => {
      State.filter.tahun    = selTahun.value;
      State.filter.semester = selSem.value;
      localStorage.setItem("ka_filter_tahun", selTahun.value);
      localStorage.setItem("ka_filter_semester", selSem.value);

      // Lompat ke bulan awal semester supaya tampilan sesuai filter
      gotoSemesterStart(selTahun.value, selSem.value);
      State.calendar.refetchEvents();
      showToast(`Menampilkan ${selTahun.value || "semua TA"} — ${selSem.value || "semua semester"}.`, "success");
    });
  }
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
    // Normalisasi ke "YYYY-MM-DD" agar cocok walau API/override memberi
    // format tanpa zero-pad (mis. "2025-1-1").
    const normDate = (v) => {
      if (!v) return "";
      const s = String(v).slice(0, 10);
      const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (!m) return s;
      return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    };
    const hideDates = new Set(
      State.overrides.filter(o => o.action === "hide").map(o => normDate(o.tanggal))
    );
    const addOverrides = State.overrides.filter(o => o.action === "add");

    State.holidays.forEach(h => {
      if (hideDates.has(normDate(h.holiday_date))) return; // di-hide
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
  const isAdmin    = isLoggedIn && State.user && State.user.role === "admin_baak";

  document.getElementById("state-public").style.display    = isLoggedIn ? "none"  : "flex";
  document.getElementById("state-logged-in").style.display = isLoggedIn ? "flex"  : "none";
  document.getElementById("toolbar-admin").style.display   = isLoggedIn ? "flex"  : "none";

  // Tombol pengelolaan master data & verifikasi khusus admin BAAK
  const adminOnlyBtns = ["btn-manage-kategori", "btn-export-pdf", "btn-manage-tahun", "btn-manage-override"];
  adminOnlyBtns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isAdmin ? "" : "none";
  });
  const verifBtn = document.getElementById("btn-verifikasi");
  if (verifBtn) verifBtn.style.display = isAdmin ? "" : "none";

  // Kontributor: tombol tambah berubah jadi "Ajukan Kegiatan"
  const addBtn = document.getElementById("btn-add-event");
  if (addBtn) {
    addBtn.innerHTML = isAdmin
      ? '<span class="iconify" data-icon="mdi:plus"></span> Tambah Kegiatan'
      : '<span class="iconify" data-icon="mdi:send-outline"></span> Ajukan Kegiatan';
  }

  if (isLoggedIn && State.user) {
    const badge = document.getElementById("admin-name");
    if (badge) {
      badge.textContent = isAdmin
        ? "Administrator BAAK"
        : (State.user.nama || State.user.username) + (State.user.unit ? " — " + State.user.unit : "");
    }
    if (isAdmin) refreshVerifBadge();
  }
}

// ============================================================
//  EVENT MODAL (Tambah / Edit)
// ============================================================
function setupEventModalHandlers() {
  document.getElementById("btn-add-event").addEventListener("click", () => openEventModal(null, null));
  const btnVerif = document.getElementById("btn-verifikasi");
  if (btnVerif) btnVerif.addEventListener("click", openVerifikasi);
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

  // End date: FullCalendar end bersifat eksklusif (+1), kembalikan ke tanggal asli.
  // Pakai endStr (string "YYYY-MM-DD") + shiftYMD berbasis UTC agar tidak mundur
  // sehari akibat konversi timezone (WIB = UTC+7).
  if (isEdit && eventData.endStr) {
    document.getElementById("event-selesai").value = shiftYMD(eventData.endStr, -1);
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
  _hideForceButton();
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

    if (res.status === "conflict") {
      // Tampilkan warning bentrok
      const list = res.conflicts.map(c =>
        `• ${c.nama} (${c.mulai} s/d ${c.selesai})`
      ).join("\n");
      showError(errEl, `⚠️ Tanggal bentrok dengan event berikut:\n${list}\n\nKlik "Simpan Paksa" jika ingin tetap menyimpan.`);
      errEl.style.whiteSpace = "pre-line";

      // Tampilkan tombol simpan paksa
      _showForceButton(payload);

    } else if (res.status === "ok") {
      closeModal("modal-event");
      State.calendar.refetchEvents();
      showToast(res.message || (isEdit ? "Kegiatan berhasil diupdate." : "Kegiatan berhasil ditambahkan."), "success");
      _hideForceButton();
      if (State.user && State.user.role === "admin_baak") refreshVerifBadge();
    } else {
      showError(errEl, res.message);
    }
  } catch (e) {
    showError(errEl, "Gagal menyimpan data.");
  }
  setLoading("btn-save-event", false);
}

function _showForceButton(payload) {
  let btn = document.getElementById("btn-force-save");
  if (!btn) {
    btn = document.createElement("button");
    btn.id        = "btn-force-save";
    btn.className = "btn btn-warning";
    btn.innerHTML = '<span class="iconify" data-icon="mdi:alert-outline"></span> Simpan Paksa';
    document.querySelector(".modal-footer").insertBefore(
      btn,
      document.getElementById("btn-save-event")
    );
  }
  btn.style.display = "inline-flex";
  btn.onclick = async () => {
    payload.force = true;
    setLoading("btn-force-save", true);
    try {
      const res = await apiPost(payload);
      if (res.status === "ok") {
        closeModal("modal-event");
        State.calendar.refetchEvents();
        showToast("Event disimpan (override bentrok).", "success");
        _hideForceButton();
      }
    } catch(e) {}
    setLoading("btn-force-save", false);
  };
}

function _hideForceButton() {
  const btn = document.getElementById("btn-force-save");
  if (btn) btn.style.display = "none";
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
      action:         "addOverride",  // router backend
      tanggal,
      ov_action:       action,        // tipe override: "hide" | "add"
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
//  EXPORT PDF
// ============================================================
function setupExportHandler() {
  document.getElementById("btn-export-pdf").addEventListener("click", () => {
    const tahun = State.filter.tahun || CONFIG.DEFAULT_TAHUN_AJARAN;
    const url   = `print.html?tahun=${encodeURIComponent(tahun)}`;
    window.open(url, "_blank");
  });
}

// ============================================================
//  TAHUN AJARAN MANAGEMENT
// ============================================================
function setupTahunAjaranHandlers() {
  document.getElementById("btn-manage-tahun").addEventListener("click", () => {
    renderTahunAjaranTable();
    openModal("modal-tahun");
  });
  document.getElementById("btn-add-tahun").addEventListener("click", addTahunAjaran);
  document.getElementById("ta-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTahunAjaran();
  });
}

function renderTahunAjaranTable() {
  const tbody = document.getElementById("ta-table-body");
  tbody.innerHTML = "";

  if (!State.tahunAjaran.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="text-center text-muted">Belum ada data.</td></tr>';
    return;
  }

  State.tahunAjaran.forEach(ta => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-family:var(--mono);font-weight:600">${ta}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="deleteTahunAjaran('${ta}')">
          <span class="iconify" data-icon="mdi:trash-can-outline"></span>
          Hapus
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function addTahunAjaran() {
  const input = document.getElementById("ta-input").value.trim();
  const errEl = document.getElementById("ta-error");

  if (!input) { showError(errEl, "Tahun ajaran wajib diisi."); return; }

  // Validasi format
  if (!/^\d{4}\/\d{4}$/.test(input)) {
    showError(errEl, "Format harus YYYY/YYYY, contoh: 2027/2028");
    return;
  }

  // Validasi logika tahun
  const parts = input.split("/");
  if (parseInt(parts[1]) !== parseInt(parts[0]) + 1) {
    showError(errEl, "Tahun kedua harus tahun pertama + 1, contoh: 2027/2028");
    return;
  }

  setLoading("btn-add-tahun", true);
  try {
    const res = await apiPost({ action: "addTahunAjaran", tahun_ajaran: input });
    if (res.status === "ok") {
      document.getElementById("ta-input").value = "";
      hideError(errEl);
      // Reload tahun ajaran
      await reloadTahunAjaran();
      renderTahunAjaranTable();
      showToast(res.message, "success");
    } else {
      showError(errEl, res.message);
    }
  } catch (e) {
    showError(errEl, "Gagal menyimpan.");
  }
  setLoading("btn-add-tahun", false);
}

async function deleteTahunAjaran(ta) {
  // Cek apakah ada event di tahun ajaran ini
  const hasEvents = State.events.some(ev => ev.tahun_ajaran === ta);
  const msg = hasEvents
    ? `"${ta}" memiliki event aktif. Dropdown akan dihapus tapi data event tetap ada. Lanjutkan?`
    : `Hapus tahun ajaran "${ta}" dari dropdown?`;

  openConfirm(msg, async () => {
    const res = await apiPost({ action: "deleteTahunAjaran", tahun_ajaran: ta });
    if (res.status === "ok") {
      await reloadTahunAjaran();
      renderTahunAjaranTable();
      showToast(res.message, "success");
    } else {
      showToast(res.message, "error");
    }
  });
}

async function reloadTahunAjaran() {
  const res = await apiGet({ action: "getTahunAjaran" });
  State.tahunAjaran = res.data || [];
  populateTahunDropdowns();
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

// ============================================================
//  VERIFIKASI USULAN (admin BAAK)
// ============================================================
async function refreshVerifBadge() {
  try {
    const res = await apiPost({ action: "getUsulan" });
    if (res.status !== "ok") return;
    const n = (res.data || []).length;
    const badge = document.getElementById("verif-badge");
    if (badge) {
      badge.textContent = n;
      badge.style.display = n > 0 ? "inline-flex" : "none";
    }
  } catch (e) { /* diam saja */ }
}

async function openVerifikasi() {
  openModal("modal-verifikasi");
  const list  = document.getElementById("verif-list");
  const empty = document.getElementById("verif-empty");
  list.innerHTML = '<div class="verif-empty">Memuat usulan…</div>';
  empty.style.display = "none";

  try {
    const res = await apiPost({ action: "getUsulan" });
    if (res.status !== "ok") {
      list.innerHTML = "";
      empty.textContent = res.message || "Gagal memuat usulan.";
      empty.style.display = "block";
      return;
    }
    renderVerifList(res.data || []);
  } catch (e) {
    list.innerHTML = "";
    empty.textContent = "Gagal terhubung ke server.";
    empty.style.display = "block";
  }
}

function renderVerifList(usulan) {
  const list  = document.getElementById("verif-list");
  const empty = document.getElementById("verif-empty");
  list.innerHTML = "";

  if (!usulan.length) {
    empty.textContent = "Tidak ada usulan yang menunggu verifikasi.";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  usulan.forEach(u => {
    const rentang = u.start === u.end
      ? formatDate(u.start)
      : `${formatDate(u.start)} – ${formatDate(u.end)}`;
    const card = document.createElement("div");
    card.className = "verif-card";
    card.dataset.id = u.id;
    card.innerHTML = `
      <div class="verif-card-top">
        <span class="verif-dot" style="background:${u.color || "#999"}"></span>
        <div class="verif-card-main">
          <div class="verif-card-title">${_esc(u.title)}</div>
          <div class="verif-card-meta">
            <strong>${_esc(rentang)}</strong> · ${_esc(u.kategori_nama || "")}<br>
            ${_esc(u.tahun_ajaran)} — ${_esc(u.semester)} ·
            diajukan oleh <strong>${_esc(u.pengaju_nama || u.diajukan_oleh)}</strong>${u.unit ? " (" + _esc(u.unit) + ")" : ""}
          </div>
          ${u.deskripsi ? `<div class="verif-card-desc">${_esc(u.deskripsi)}</div>` : ""}
          <div class="verif-card-actions">
            <button class="btn btn-primary btn-xs" data-act="approve">Setujui</button>
            <button class="btn btn-secondary btn-xs" data-act="edit">Edit dulu</button>
            <button class="btn btn-danger btn-xs" data-act="reject-open">Tolak</button>
          </div>
          <div class="verif-reject-box">
            <input type="text" placeholder="Alasan penolakan (opsional)" data-role="reject-note" />
            <button class="btn btn-danger btn-xs" data-act="reject-confirm">Kirim</button>
          </div>
        </div>
      </div>`;

    card.querySelector('[data-act="approve"]').addEventListener("click", () => approveUsulan(u.id, false));
    card.querySelector('[data-act="edit"]').addEventListener("click", () => {
      closeModal("modal-verifikasi");
      // Buka modal edit dengan data usulan (start/end di sini masih inklusif)
      openEventModal({
        id: u.id,
        title: u.title,
        startStr: u.start,
        endStr: shiftYMD(u.end, 1), // openEventModal mengurangi 1 lagi → tampil inklusif
        extendedProps: {
          nama_kegiatan: u.title, tahun_ajaran: u.tahun_ajaran, semester: u.semester,
          deskripsi: u.deskripsi, kategori_id: u.kategori_id
        }
      }, null);
    });
    const rejectBox = card.querySelector(".verif-reject-box");
    card.querySelector('[data-act="reject-open"]').addEventListener("click", () => {
      rejectBox.classList.toggle("show");
    });
    card.querySelector('[data-act="reject-confirm"]').addEventListener("click", () => {
      const note = card.querySelector('[data-role="reject-note"]').value.trim();
      rejectUsulan(u.id, note);
    });

    list.appendChild(card);
  });
}

async function approveUsulan(id, force) {
  try {
    const res = await apiPost({ action: "approveEvent", event_id: id, force: !!force });
    if (res.status === "conflict") {
      const list = res.conflicts.map(c => `• ${c.nama} (${c.mulai} s/d ${c.selesai})`).join("\n");
      if (confirm(`⚠️ ${res.message}\n\n${list}\n\nTetap setujui dan publikasikan?`)) {
        return approveUsulan(id, true);
      }
      return;
    }
    if (res.status === "ok") {
      showToast("Usulan disetujui & dipublikasikan.", "success");
      _removeVerifCard(id);
      State.calendar.refetchEvents();
      refreshVerifBadge();
    } else {
      showToast(res.message || "Gagal menyetujui.", "error");
    }
  } catch (e) { showToast("Gagal terhubung ke server.", "error"); }
}

async function rejectUsulan(id, catatan) {
  try {
    const res = await apiPost({ action: "rejectEvent", event_id: id, catatan });
    if (res.status === "ok") {
      showToast("Usulan ditolak.", "success");
      _removeVerifCard(id);
      refreshVerifBadge();
    } else {
      showToast(res.message || "Gagal menolak.", "error");
    }
  } catch (e) { showToast("Gagal terhubung ke server.", "error"); }
}

function _removeVerifCard(id) {
  const card = document.querySelector(`.verif-card[data-id="${id}"]`);
  if (card) card.remove();
  const remaining = document.querySelectorAll(".verif-card").length;
  if (remaining === 0) {
    const empty = document.getElementById("verif-empty");
    empty.textContent = "Tidak ada usulan yang menunggu verifikasi.";
    empty.style.display = "block";
  }
}

function _esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

// Geser tanggal string "YYYY-MM-DD" sebanyak `delta` hari, aman timezone.
// Dibangun & dibaca sama-sama di UTC, jadi offset WIB tidak pernah bocor.
function shiftYMD(ymd, delta) {
  if (!ymd) return ymd;
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// Arahkan tampilan kalender ke bulan awal semester terpilih.
// TA "2026/2027": Ganjil -> September 2026, Genap -> Februari 2027.
function gotoSemesterStart(tahun, semester) {
  if (!State.calendar || !tahun) return;
  const parts = String(tahun).split("/").map(Number);
  const startYear = parts[0];
  const endYear   = parts[1] || startYear;
  let target;
  if (semester === "Genap") {
    target = new Date(endYear, 1, 1);   // Februari
  } else {
    target = new Date(startYear, 8, 1); // September (default/Ganjil)
  }
  if (!isNaN(target.getTime())) State.calendar.gotoDate(target);
}