(() => {
  "use strict";

  const STORAGE_KEY = "teacherCalendar.v1";
  const ZONES = [
    { id: "Asia/Yekaterinburg", label: "Екатеринбург" },
    { id: "Europe/Moscow", label: "Москва" }
  ];
  const COLORS = ["#8b74c9", "#ae82c7", "#d58db2", "#e8a58f", "#72a99a", "#75a4c7", "#70558f", "#9790ac"];
  const LESSON_STATUSES = { planned: "Запланирован", confirmed: "Подтверждён", completed: "Проведён", cancelledStudent: "Отменён учеником", cancelledTeacher: "Отменён преподавателем", missed: "Пропущен" };
  const PAYMENT_STATUSES = { unpaid: "Не оплачено", partial: "Частично", paid: "Оплачено", package: "Абонемент" };
  const WEEKDAYS = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
  const el = id => document.getElementById(id);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  let state = loadState();
  let cursorDate = todayInZone(state.settings.timeZone);
  let selectedColor = COLORS[0];
  let selectedStars = 0;
  let lastFocused = null;
  let formSnapshot = "";
  let toastTimer;
  let mobileWeekDay = 0;
  let activeSection = "calendar";
  let filters = { search: "", studentId: "", status: "", unpaidOnly: false };

  function defaultState() {
    return { version: 2, settings: { timeZone: ZONES[0].id, calendarView: "month", workHours: { start: 8, end: 21 } }, students: [], lessons: [], recurrenceSeries: [], recurrenceExceptions: [], initialized: true };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const fresh = defaultState();
        seedDemoData(fresh);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
        return fresh;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || ![1, 2].includes(parsed.version)) throw new Error("Unsupported data version");
      return {
        ...defaultState(), ...parsed,
        version: 2,
        settings: { ...defaultState().settings, ...(parsed.settings || {}) },
        students: Array.isArray(parsed.students) ? parsed.students.filter(x => x && x.id && x.name) : [],
        lessons: Array.isArray(parsed.lessons) ? parsed.lessons.filter(validLesson).map(normalizeLesson) : [],
        recurrenceSeries: Array.isArray(parsed.recurrenceSeries) ? parsed.recurrenceSeries.filter(validSeries).map(normalizeLesson) : [],
        recurrenceExceptions: Array.isArray(parsed.recurrenceExceptions) ? parsed.recurrenceExceptions.filter(x => x && x.seriesId && x.originalStartUtc) : []
      };
    } catch (error) {
      console.warn("Не удалось прочитать календарь, создано безопасное пустое состояние.", error);
      return defaultState();
    }
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (error) { console.error(error); showToast("Не удалось сохранить данные в браузере"); }
  }

  function validLesson(x) { return x && x.id && x.name && !Number.isNaN(Date.parse(x.startUtc)) && x.duration > 0; }
  function validSeries(x) { return x && x.id && x.name && x.startDate && x.startTime && x.untilDate && ["weekly", "biweekly"].includes(x.frequency); }
  function normalizeLesson(x) { return { studentId: "", lessonStatus: "planned", lessonFormat: "online", meetingLink: "", result: "", homework: "", stars: 0, ...x }; }

  function seedDemoData(target) {
    const zone = target.settings.timeZone;
    const today = todayInZone(zone);
    const singleDate = addDays(today, 1);
    const weeklyDate = addDays(today, -(weekdayIndex(today) - 1));
    const biweeklyDate = addDays(today, 3);
    const anna = { id: uid("student"), name: "Анна", parentName: "Елена", subject: "Математика · 8 класс", contact: "", defaultDuration: 60, defaultPriceKopecks: 180000, defaultLink: "", notes: "", color: COLORS[0] };
    target.students.push(anna);
    target.lessons.push(normalizeLesson({ id: uid("lesson"), studentId: anna.id, name: "Анна — математика", startUtc: zonedDateTimeToUtc(singleDate, "16:00", zone), duration: 60, color: COLORS[0], note: "", result: "Квадратные уравнения", homework: "Повторить формулы", priceKopecks: 180000, paymentStatus: "paid", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    target.recurrenceSeries.push(
      { id: uid("series"), name: "Группа B2", startDate: weeklyDate, startTime: "18:00", timeZone: zone, duration: 90, color: COLORS[1], note: "Разговорная практика", priceKopecks: 220000, paymentStatus: "unpaid", frequency: "weekly", untilDate: addDays(weeklyDate, 49), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: uid("series"), name: "Михаил", startDate: biweeklyDate, startTime: "14:30", timeZone: zone, duration: 60, color: COLORS[4], note: "", priceKopecks: 160000, paymentStatus: "paid", frequency: "biweekly", untilDate: addDays(biweeklyDate, 70), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    );
  }

  function dateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
    return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  }

  function zonedDateTimeToUtc(dateString, timeString, timeZone) {
    const [y, m, d] = dateString.split("-").map(Number);
    const [h, min] = timeString.split(":").map(Number);
    const wallUtc = Date.UTC(y, m - 1, d, h, min, 0);
    let guess = wallUtc;
    for (let i = 0; i < 2; i++) {
      const p = dateParts(new Date(guess), timeZone);
      const represented = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      guess += wallUtc - represented;
    }
    return new Date(guess).toISOString();
  }

  function zonedDate(iso, timeZone) { const p = dateParts(new Date(iso), timeZone); return `${p.year}-${p.month}-${p.day}`; }
  function zonedTime(iso, timeZone) { const p = dateParts(new Date(iso), timeZone); return `${p.hour}:${p.minute}`; }
  function todayInZone(zone) { return zonedDate(new Date().toISOString(), zone); }
  function parseDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function dateString(date) { return date.toISOString().slice(0, 10); }
  function addDays(s, amount) { const d = parseDate(s); d.setUTCDate(d.getUTCDate() + amount); return dateString(d); }
  function weekdayIndex(s) { return (parseDate(s).getUTCDay() + 6) % 7; }
  function startOfWeek(s) { return addDays(s, -weekdayIndex(s)); }
  function startOfMonth(s) { return `${s.slice(0, 7)}-01`; }
  function addMonths(s, amount) { const d = parseDate(s); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + amount); return dateString(d); }
  function sameMonth(a, b) { return a.slice(0, 7) === b.slice(0, 7); }
  function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]); }
  function money(kopecks) { return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: kopecks % 100 ? 2 : 0 }).format((kopecks || 0) / 100); }
  function displayDate(s, options = {}) { return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", ...options }).format(parseDate(s)); }

  function getOccurrences(rangeStart, rangeEnd) {
    const result = state.lessons.map(l => ({ ...l, kind: "lesson", occurrenceId: l.id })).filter(x => {
      const d = zonedDate(x.startUtc, state.settings.timeZone); return d >= rangeStart && d <= rangeEnd;
    });
    state.recurrenceSeries.forEach(series => {
      const step = series.frequency === "biweekly" ? 14 : 7;
      for (let date = series.startDate; date <= series.untilDate; date = addDays(date, step)) {
        const originalStartUtc = zonedDateTimeToUtc(date, series.startTime, series.timeZone);
        const exception = state.recurrenceExceptions.find(x => x.seriesId === series.id && x.originalStartUtc === originalStartUtc);
        if (exception?.deleted) continue;
        const item = exception?.override
          ? { ...series, ...exception.override, id: series.id, seriesId: series.id, originalStartUtc, kind: "series" }
          : { ...series, seriesId: series.id, startUtc: originalStartUtc, originalStartUtc, kind: "series" };
        const visibleDate = zonedDate(item.startUtc, state.settings.timeZone);
        if (visibleDate >= rangeStart && visibleDate <= rangeEnd) result.push({ ...item, occurrenceId: `${series.id}:${originalStartUtc}` });
      }
    });
    return result.sort((a, b) => new Date(a.startUtc) - new Date(b.startUtc));
  }

  function visibleOccurrences(start, end) {
    const query = filters.search.toLocaleLowerCase("ru");
    return getOccurrences(start, end).filter(item => {
      if (query && !`${item.name} ${item.note || ""} ${item.homework || ""}`.toLocaleLowerCase("ru").includes(query)) return false;
      if (filters.studentId && item.studentId !== filters.studentId) return false;
      if (filters.status && (item.lessonStatus || "planned") !== filters.status) return false;
      if (filters.unpaidOnly && ["paid", "package"].includes(item.paymentStatus)) return false;
      return true;
    });
  }

  function render() {
    renderStudentOptions();
    renderSections();
    if (activeSection !== "calendar") return;
    $$("[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === state.settings.calendarView));
    const view = state.settings.calendarView;
    el("summary").hidden = view !== "day";
    if (view === "month") renderMonth();
    if (view === "week") renderWeek();
    if (view === "day") renderDay();
    renderPeriodTitle();
  }

  function renderPeriodTitle() {
    const view = state.settings.calendarView;
    if (view === "month") el("periodTitle").textContent = displayDate(startOfMonth(cursorDate), { month: "long", year: "numeric" });
    else if (view === "day") el("periodTitle").textContent = displayDate(cursorDate, { day: "numeric", month: "long", year: "numeric" });
    else {
      const start = startOfWeek(cursorDate), end = addDays(start, 6);
      el("periodTitle").textContent = sameMonth(start, end) ? `${displayDate(start, { day: "numeric" })}–${displayDate(end, { day: "numeric", month: "long", year: "numeric" })}` : `${displayDate(start, { day: "numeric", month: "short" })} — ${displayDate(end, { day: "numeric", month: "short", year: "numeric" })}`;
    }
  }

  function renderStudentOptions() {
    const options = state.students.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
    const lessonSelect = el("studentId"), filterSelect = el("studentFilter");
    if (lessonSelect && lessonSelect.dataset.signature !== options) { const value = lessonSelect.value; lessonSelect.innerHTML = `<option value="">Без карточки ученика</option>${options}`; lessonSelect.value = value; lessonSelect.dataset.signature = options; }
    if (filterSelect && filterSelect.dataset.signature !== options) { const value = filters.studentId; filterSelect.innerHTML = `<option value="">Все ученики</option>${options}`; filterSelect.value = value; filterSelect.dataset.signature = options; }
  }

  function renderSections() {
    ["today", "calendar", "students", "finance"].forEach(name => {
      const section = el(`${name}Section`); if (section) section.hidden = name !== activeSection;
    });
    $$('[data-section]').forEach(b => b.classList.toggle("active", b.dataset.section === activeSection));
    if (activeSection === "today") renderTodayDashboard();
    if (activeSection === "students") renderStudents();
    if (activeSection === "finance") renderFinance();
  }

  function renderTodayDashboard() {
    const today = todayInZone(state.settings.timeZone), tomorrow = addDays(today, 1);
    const items = getOccurrences(today, today), tomorrowItems = getOccurrences(tomorrow, tomorrow);
    const unpaid = items.filter(x => !["paid", "package"].includes(x.paymentStatus));
    const next = items.find(x => new Date(x.startUtc) > new Date() && !String(x.lessonStatus).startsWith("cancelled"));
    el("todaySection").innerHTML = `<div class="section-heading"><div><p class="eyebrow">Рабочий день</p><h2>${displayDate(today, { weekday: "long", day: "numeric", month: "long" })}</h2></div><button class="primary-button" data-dashboard-add>＋ Добавить урок</button></div>
      <div class="dashboard-grid"><article class="hero-card"><div class="hero-content"><span>Следующий урок</span>${next ? `<h3>${escapeHtml(next.name)}</h3><p>${zonedTime(next.startUtc, state.settings.timeZone)} · ${next.duration} мин</p>${next.meetingLink ? `<button class="secondary-button" data-open-link="${escapeHtml(next.meetingLink)}">Начать урок</button>` : ""}` : `<h3>На сегодня всё спокойно</h3><p>Можно немного отдохнуть и набраться вдохновения.</p>`}</div><img class="hero-bouquet" src="референсы/ChatGPT Image 13 авг. 2026 г., 22_41_58.png" alt="" aria-hidden="true"></article>
      <article class="metric-card"><span>Уроков сегодня</span><strong>${items.length}</strong></article><article class="metric-card"><span>Не оплачено</span><strong>${money(unpaid.reduce((n, x) => n + (x.priceKopecks || 0), 0))}</strong></article><article class="metric-card"><span>Ждут подтверждения завтра</span><strong>${tomorrowItems.filter(x => (x.lessonStatus || "planned") === "planned").length}</strong></article></div>
      <div class="section-heading compact"><h3>Расписание сегодня</h3></div><div class="agenda-list">${items.length ? items.map(agendaCard).join("") : emptyIllustration("Свободный день", "Можно запланировать урок или оставить время для отдыха.")}</div>`;
    bindQuickActions(el("todaySection"));
    $('[data-dashboard-add]')?.addEventListener("click", () => openLessonForm({ date: today }));
    $$('[data-open-link]').forEach(b => b.addEventListener("click", () => { if (/^https?:\/\//i.test(b.dataset.openLink)) window.open(b.dataset.openLink, "_blank", "noopener"); else navigator.clipboard?.writeText(b.dataset.openLink); }));
  }

  function agendaCard(item) {
    const status = item.lessonStatus || "planned";
    return `<article class="agenda-card" style="--lesson-color:${item.color}"><div class="agenda-time">${zonedTime(item.startUtc, state.settings.timeZone)}<small>${item.duration} мин</small></div><div class="agenda-main"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(LESSON_STATUSES[status] || status)} · ${item.lessonFormat === "offline" ? "Очно" : "Онлайн"}</p>${item.stars ? `<div class="lesson-stars" aria-label="${item.stars} из 5 звёзд">${"★".repeat(item.stars)}${"☆".repeat(5 - item.stars)}</div>` : ""}${item.homework ? `<small>Д/з: ${escapeHtml(item.homework)}</small>` : ""}</div><div class="quick-actions"><button data-quick="complete" data-id="${escapeHtml(item.occurrenceId)}">✓ Проведён</button><button data-quick="pay" data-id="${escapeHtml(item.occurrenceId)}">₽ Оплачен</button><button data-quick="message" data-id="${escapeHtml(item.occurrenceId)}">Сообщение</button><button data-quick="edit" data-id="${escapeHtml(item.occurrenceId)}">Открыть</button></div></article>`;
  }

  function renderStudents() {
    el("studentsSection").innerHTML = `<div class="section-heading"><div><p class="eyebrow">Справочник</p><h2>Ученики и родители</h2></div><button class="primary-button" data-add-student>＋ Добавить ученика</button></div><div class="student-grid">${state.students.length ? state.students.map(s => `<button class="student-card" data-student-card="${escapeHtml(s.id)}" style="--student-color:${s.color || COLORS[0]}"><span class="student-avatar">${escapeHtml(s.name.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(s.subject || "Предмет не указан")}</small><small>${escapeHtml(s.parentName ? `Родитель: ${s.parentName}` : "")}</small></span><b>${money(s.defaultPriceKopecks)}</b></button>`).join("") : emptyIllustration("Добавьте первого ученика", "Стоимость, длительность и ссылка будут подставляться в урок автоматически.")}</div>`;
    $('[data-add-student]')?.addEventListener("click", () => openStudentForm());
    $$('[data-student-card]').forEach(b => b.addEventListener("click", () => openStudentForm(state.students.find(s => s.id === b.dataset.studentCard))));
  }

  function renderFinance() {
    const month = startOfMonth(cursorDate), end = addDays(addMonths(month, 1), -1), items = getOccurrences(month, end).filter(x => !String(x.lessonStatus).startsWith("cancelled"));
    const expected = items.reduce((n, x) => n + (x.priceKopecks || 0), 0), paid = items.filter(x => ["paid", "package"].includes(x.paymentStatus)).reduce((n, x) => n + (x.priceKopecks || 0), 0);
    const debts = items.filter(x => !["paid", "package"].includes(x.paymentStatus));
    el("financeSection").innerHTML = `<div class="section-heading"><div><p class="eyebrow">Учёт оплат</p><h2>Финансы · ${displayDate(month, { month: "long", year: "numeric" })}</h2></div><button class="secondary-button" data-export-csv>Экспорт CSV</button></div><div class="finance-summary"><article><span>Ожидается</span><strong>${money(expected)}</strong></article><article><span>Получено</span><strong>${money(paid)}</strong></article><article><span>Задолженность</span><strong>${money(expected - paid)}</strong></article></div><div class="table-wrap"><table><thead><tr><th>Дата</th><th>Ученик</th><th>Сумма</th><th>Оплата</th></tr></thead><tbody>${debts.length ? debts.map(x => `<tr><td>${displayDate(zonedDate(x.startUtc, state.settings.timeZone), { day: "numeric", month: "short" })}</td><td>${escapeHtml(x.name)}</td><td>${money(x.priceKopecks)}</td><td><button class="table-action" data-quick="pay" data-id="${escapeHtml(x.occurrenceId)}">Отметить оплату</button></td></tr>`).join("") : `<tr><td colspan="4">Неоплаченных занятий нет</td></tr>`}</tbody></table></div>`;
    bindQuickActions(el("financeSection")); $('[data-export-csv]')?.addEventListener("click", () => exportCsv(items));
  }

  function emptyIllustration(title, text) { return `<div class="empty-illustrated"><div class="lavender-sprig" aria-hidden="true">✦</div><strong>${title}</strong><p>${text}</p></div>`; }

  function renderMonth() {
    const monthStart = startOfMonth(cursorDate), gridStart = startOfWeek(monthStart);
    const nextMonth = addMonths(monthStart, 1), last = addDays(nextMonth, -1);
    const gridEnd = addDays(startOfWeek(last), 6);
    const lessons = visibleOccurrences(gridStart, gridEnd);
    let html = `<div class="weekday-row">${WEEKDAYS.map(x => `<div class="weekday">${x.slice(0, 2)}</div>`).join("")}</div><div class="month-grid">`;
    for (let date = gridStart; date <= gridEnd; date = addDays(date, 1)) {
      const dayLessons = lessons.filter(x => zonedDate(x.startUtc, state.settings.timeZone) === date);
      const classes = ["month-day", !sameMonth(date, monthStart) ? "outside" : "", weekdayIndex(date) > 4 ? "weekend" : "", date === todayInZone(state.settings.timeZone) ? "today" : ""].filter(Boolean).join(" ");
      html += `<div class="${classes}" data-date="${date}" role="button" tabindex="0" aria-label="${displayDate(date, { day: "numeric", month: "long" })}, уроков: ${dayLessons.length}"><span class="day-number">${+date.slice(8)}</span>`;
      dayLessons.slice(0, 3).forEach(item => html += lessonChip(item));
      if (dayLessons.length > 3) html += `<button class="more-lessons" data-open-day="${date}">Ещё ${dayLessons.length - 3}</button>`;
      html += `</div>`;
    }
    el("calendar").innerHTML = html + "</div>";
    $$(".month-day").forEach(day => {
      day.addEventListener("click", e => { if (!e.target.closest(".lesson-chip,.more-lessons")) openLessonForm({ date: day.dataset.date }); });
      day.addEventListener("keydown", e => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); openLessonForm({ date: day.dataset.date }); } });
    });
    bindLessonButtons();
    $$("[data-open-day]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); cursorDate = b.dataset.openDay; setView("day"); }));
  }

  function lessonChip(item) {
    return `<button class="lesson-chip" style="--lesson-color:${item.color}" data-occurrence="${escapeHtml(item.occurrenceId)}" title="${escapeHtml(item.name)}"><time>${zonedTime(item.startUtc, state.settings.timeZone)}</time><span class="chip-name">${escapeHtml(item.name)}</span><span class="payment-dot ${item.paymentStatus === "paid" ? "paid" : ""}" aria-label="${item.paymentStatus === "paid" ? "Оплачено" : "Не оплачено"}"></span></button>`;
  }

  function renderWeek() {
    const start = startOfWeek(cursorDate), end = addDays(start, 6), items = visibleOccurrences(start, end);
    let html = `<div class="time-scroll"><div class="week-mobile-tabs">`;
    for (let i = 0; i < 7; i++) { const d = addDays(start, i); html += `<button data-mobile-day="${i}" class="${i === mobileWeekDay ? "active" : ""}">${WEEKDAYS[i].slice(0, 2)}<br>${+d.slice(8)}</button>`; }
    html += `</div><div class="week-head"><div></div>`;
    for (let i = 0; i < 7; i++) { const d = addDays(start, i); html += `<div class="${d === todayInZone(state.settings.timeZone) ? "today" : ""}"><span>${WEEKDAYS[i].slice(0, 2)}</span><strong>${+d.slice(8)}</strong></div>`; }
    html += `</div><div class="time-grid"><div class="time-labels">${Array.from({ length: 24 }, (_, h) => `<span class="time-label" style="top:${h * 56}px">${String(h).padStart(2, "0")}:00</span>`).join("")}</div>`;
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i), dayItems = items.filter(x => zonedDate(x.startUtc, state.settings.timeZone) === d);
      html += `<div class="day-column ${i === mobileWeekDay ? "mobile-active" : ""}" data-date="${d}">`;
      dayItems.forEach((item, index) => { const [h, m] = zonedTime(item.startUtc, state.settings.timeZone).split(":").map(Number); const top = (h + m / 60) * 56; const height = Math.max(26, item.duration / 60 * 56); const overlap = dayItems.some((other, j) => j < index && Math.abs(new Date(other.startUtc) - new Date(item.startUtc)) < Math.min(other.duration, item.duration) * 60000); html += `<button class="timed-lesson" style="--lesson-color:${item.color};top:${top}px;height:${height}px;left:${overlap ? 48 : 3}%;right:3%" data-occurrence="${escapeHtml(item.occurrenceId)}"><strong>${escapeHtml(item.name)}</strong><span>${zonedTime(item.startUtc, state.settings.timeZone)} · ${item.duration} мин</span></button>`; });
      if (d === todayInZone(state.settings.timeZone)) { const nowTime = zonedTime(new Date().toISOString(), state.settings.timeZone).split(":").map(Number); html += `<div class="current-time-line" style="top:${(nowTime[0] + nowTime[1] / 60) * 56}px"></div>`; }
      html += `</div>`;
    }
    el("calendar").innerHTML = html + `</div></div>`;
    $$(".day-column").forEach(col => col.addEventListener("click", e => { if (!e.target.closest(".timed-lesson")) { const rect = col.getBoundingClientRect(); const minutes = Math.max(0, Math.min(1435, Math.round(((e.clientY - rect.top) / 56 * 60) / 15) * 15)); openLessonForm({ date: col.dataset.date, time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` }); } }));
    $$('[data-mobile-day]').forEach(b => b.addEventListener("click", () => { mobileWeekDay = +b.dataset.mobileDay; renderWeek(); }));
    bindLessonButtons();
    requestAnimationFrame(() => { const scroller = $(".time-scroll"); if (scroller) scroller.scrollTop = 7 * 56; });
  }

  function renderDay() {
    const items = visibleOccurrences(cursorDate, cursorDate);
    const expected = items.reduce((n, x) => n + (x.priceKopecks || 0), 0), paid = items.filter(x => x.paymentStatus === "paid").reduce((n, x) => n + (x.priceKopecks || 0), 0);
    el("summary").innerHTML = `<div class="summary-item"><span>Уроков</span><strong>${items.length}</strong></div><div class="summary-item"><span>Ожидается</span><strong>${money(expected)}</strong></div><div class="summary-item"><span>Оплачено</span><strong>${money(paid)}</strong></div>`;
    let html = `<div class="day-view"><div class="day-view-head"><h3>${displayDate(cursorDate, { weekday: "long", day: "numeric", month: "long" })}</h3></div>`;
    if (!items.length) html += `<div class="empty-state"><div><img class="empty-bouquet" src="референсы/ChatGPT Image 13 авг. 2026 г., 22_41_58.png" alt="Букет лаванды"><strong>Уроков пока нет</strong><p>Нажмите «Добавить урок», чтобы запланировать занятие.</p></div></div>`;
    else { html += `<div class="day-list">`; items.forEach(item => { html += `<button class="day-lesson" style="--lesson-color:${item.color}" data-occurrence="${escapeHtml(item.occurrenceId)}"><div class="lesson-time">${zonedTime(item.startUtc, state.settings.timeZone)}<small>${item.duration} мин</small></div><span class="color-bar"></span><div class="lesson-info"><strong>${escapeHtml(item.name)}</strong>${item.stars ? `<div class="lesson-stars" aria-label="${item.stars} из 5 звёзд">${"★".repeat(item.stars)}${"☆".repeat(5 - item.stars)}</div>` : ""}${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}</div><div class="lesson-meta"><strong>${money(item.priceKopecks)}</strong><span class="${item.paymentStatus === "paid" ? "status-paid" : "status-unpaid"}">${item.paymentStatus === "paid" ? "✓ Оплачено" : "○ Не оплачено"}</span></div></button>`; }); html += `</div>`; }
    el("calendar").innerHTML = html + `</div>`;
    bindLessonButtons();
  }

  function bindLessonButtons() { $$('[data-occurrence]').forEach(b => b.addEventListener("click", e => { e.stopPropagation(); const item = findOccurrence(b.dataset.occurrence); if (item) openLessonForm({ item }); })); }
  function findOccurrence(id) { const broadStart = addDays(cursorDate, -370), broadEnd = addDays(cursorDate, 370); return getOccurrences(broadStart, broadEnd).find(x => x.occurrenceId === id); }

  function openLessonForm({ date = cursorDate, time = "12:00", item = null } = {}) {
    lastFocused = document.activeElement;
    el("lessonForm").reset(); clearErrors();
    el("editingKind").value = item?.kind || ""; el("editingId").value = item?.kind === "series" ? item.seriesId : (item?.id || ""); el("editingOriginalStart").value = item?.originalStartUtc || "";
    el("studentId").value = item?.studentId || "";
    el("studentName").value = item?.name || "";
    el("lessonDate").value = item ? zonedDate(item.startUtc, state.settings.timeZone) : date;
    el("lessonTime").value = item ? zonedTime(item.startUtc, state.settings.timeZone) : time;
    el("duration").value = item?.duration || 60; el("price").value = ((item?.priceKopecks || 0) / 100).toFixed((item?.priceKopecks || 0) % 100 ? 2 : 0); el("paymentStatus").value = item?.paymentStatus || "unpaid"; el("lessonStatus").value = item?.lessonStatus || "planned"; el("lessonFormat").value = item?.lessonFormat || "online"; el("meetingLink").value = item?.meetingLink || ""; el("lessonResult").value = item?.result || ""; el("homework").value = item?.homework || ""; el("note").value = item?.note || "";
    selectedColor = item?.color || COLORS[0]; selectedStars = Math.max(0, Math.min(5, Number(item?.stars) || 0)); renderColorPicker(); renderStarRating();
    el("modalEyebrow").textContent = item ? (item.kind === "series" ? "Повторяющийся урок" : "Одиночный урок") : "Новое событие"; el("modalTitle").textContent = item ? "Редактировать урок" : "Добавить урок";
    el("deleteLesson").hidden = !item; el("editScope").hidden = item?.kind !== "series"; el("recurrenceFields").hidden = !!item;
    el("recurrence").value = "none"; el("recurrenceEndField").hidden = true; el("recurrenceEnd").value = "";
    el("lessonModal").hidden = false; document.body.style.overflow = "hidden";
    formSnapshot = formSignature(); requestAnimationFrame(() => el("studentName").focus());
  }

  function closeLessonModal(force = false) {
    if (!force && formSnapshot && formSignature() !== formSnapshot && !confirm("Закрыть без сохранения изменений?")) return;
    el("lessonModal").hidden = true; document.body.style.overflow = ""; formSnapshot = ""; lastFocused?.focus?.();
  }

  function formSignature() { return JSON.stringify(Object.fromEntries(new FormData(el("lessonForm")))) + selectedColor + selectedStars; }
  function renderColorPicker() { el("colorPicker").innerHTML = COLORS.map((c, i) => `<button type="button" class="color-choice ${c === selectedColor ? "selected" : ""}" style="--choice-color:${c}" data-color="${c}" role="radio" aria-checked="${c === selectedColor}" aria-label="Цвет ${i + 1}"></button>`).join(""); $$('[data-color]').forEach(b => b.addEventListener("click", () => { selectedColor = b.dataset.color; renderColorPicker(); })); }
  function renderStarRating() { el("starRating").innerHTML = `<button type="button" class="star-reset ${selectedStars === 0 ? "selected" : ""}" data-stars="0" role="radio" aria-checked="${selectedStars === 0}">0</button>${[1,2,3,4,5].map(n => `<button type="button" class="star-button ${n <= selectedStars ? "filled" : ""}" data-stars="${n}" role="radio" aria-checked="${n === selectedStars}" aria-label="${n} из 5 звёзд">★</button>`).join("")}`; $$('[data-stars]', el("starRating")).forEach(b => b.addEventListener("click", () => { selectedStars = +b.dataset.stars; renderStarRating(); })); }
  function clearErrors() { $$(".error").forEach(x => x.textContent = ""); }
  function showError(name, message) { $(`[data-error="${name}"]`).textContent = message; }

  function readForm() {
    clearErrors(); let valid = true;
    const name = el("studentName").value.trim(), date = el("lessonDate").value, time = el("lessonTime").value, duration = +el("duration").value, price = Number(el("price").value), recurrence = el("recurrence").value, untilDate = el("recurrenceEnd").value;
    if (!name) { showError("name", "Введите имя ученика или название группы"); valid = false; }
    if (!date) { showError("date", "Выберите дату"); valid = false; }
    if (!time) { showError("time", "Укажите время начала"); valid = false; }
    if (!Number.isFinite(duration) || duration <= 0) { showError("duration", "Длительность должна быть больше нуля"); valid = false; }
    if (!Number.isFinite(price) || price < 0) { showError("price", "Стоимость не может быть отрицательной"); valid = false; }
    if (!el("editingKind").value && recurrence !== "none" && (!untilDate || untilDate < date)) { showError("recurrenceEnd", "Дата окончания должна быть не раньше первого урока"); valid = false; }
    if (!valid) return null;
    return { name, date, time, duration, color: selectedColor, stars: selectedStars, studentId: el("studentId").value, note: el("note").value.trim(), result: el("lessonResult").value.trim(), homework: el("homework").value.trim(), meetingLink: el("meetingLink").value.trim(), lessonStatus: el("lessonStatus").value, lessonFormat: el("lessonFormat").value, priceKopecks: Math.round(price * 100), paymentStatus: el("paymentStatus").value, recurrence, untilDate };
  }

  function submitLesson(event) {
    event.preventDefault(); const data = readForm(); if (!data) return;
    const candidateStart = new Date(zonedDateTimeToUtc(data.date, data.time, state.settings.timeZone));
    const candidateEnd = new Date(candidateStart.getTime() + data.duration * 60000);
    const editingOccurrence = el("editingKind").value === "series" ? `${el("editingId").value}:${el("editingOriginalStart").value}` : el("editingId").value;
    const overlaps = getOccurrences(data.date, data.date).some(x => x.occurrenceId !== editingOccurrence && candidateStart < new Date(new Date(x.startUtc).getTime() + x.duration * 60000) && candidateEnd > new Date(x.startUtc));
    const startHour = +data.time.slice(0, 2), outsideHours = startHour < state.settings.workHours.start || startHour >= state.settings.workHours.end;
    if ((overlaps || outsideHours) && !confirm(`${overlaps ? "Это время пересекается с другим уроком. " : ""}${outsideHours ? "Занятие находится вне обычных рабочих часов. " : ""}Всё равно сохранить?`)) return;
    const now = new Date().toISOString(), kind = el("editingKind").value, id = el("editingId").value;
    if (!kind) {
      if (data.recurrence === "none") state.lessons.push({ id: uid("lesson"), ...lessonFields(data), startUtc: zonedDateTimeToUtc(data.date, data.time, state.settings.timeZone), createdAt: now, updatedAt: now });
      else state.recurrenceSeries.push({ id: uid("series"), ...lessonFields(data), startDate: data.date, startTime: data.time, timeZone: state.settings.timeZone, frequency: data.recurrence, untilDate: data.untilDate, createdAt: now, updatedAt: now });
    } else if (kind === "lesson") {
      const index = state.lessons.findIndex(x => x.id === id); if (index >= 0) state.lessons[index] = { ...state.lessons[index], ...lessonFields(data), startUtc: zonedDateTimeToUtc(data.date, data.time, state.settings.timeZone), updatedAt: now };
    } else {
      const scope = $('input[name="scope"]:checked').value;
      if (scope === "instance") upsertException(id, el("editingOriginalStart").value, { ...lessonFields(data), startUtc: zonedDateTimeToUtc(data.date, data.time, state.settings.timeZone), updatedAt: now });
      else {
        const index = state.recurrenceSeries.findIndex(x => x.id === id);
        if (index >= 0) {
          const existing = state.recurrenceSeries[index], displayedOriginalDate = zonedDate(el("editingOriginalStart").value, existing.timeZone);
          const dateShift = Math.round((parseDate(data.date) - parseDate(displayedOriginalDate)) / 86400000);
          state.recurrenceSeries[index] = { ...existing, ...lessonFields(data), startDate: addDays(existing.startDate, dateShift), untilDate: addDays(existing.untilDate, dateShift), startTime: data.time, timeZone: state.settings.timeZone, updatedAt: now };
          state.recurrenceExceptions = state.recurrenceExceptions.filter(x => x.seriesId !== id);
        }
      }
    }
    saveState(); closeLessonModal(true); render(); showToast("Урок сохранён");
  }

  function lessonFields(data) { return { name: data.name, studentId: data.studentId, duration: data.duration, color: data.color, stars: Math.max(0, Math.min(5, Number(data.stars) || 0)), note: data.note, result: data.result, homework: data.homework, meetingLink: data.meetingLink, lessonStatus: data.lessonStatus, lessonFormat: data.lessonFormat, priceKopecks: data.priceKopecks, paymentStatus: data.paymentStatus }; }
  function upsertException(seriesId, originalStartUtc, override) { const index = state.recurrenceExceptions.findIndex(x => x.seriesId === seriesId && x.originalStartUtc === originalStartUtc); const value = { id: index >= 0 ? state.recurrenceExceptions[index].id : uid("exception"), seriesId, originalStartUtc, override, deleted: false }; if (index >= 0) state.recurrenceExceptions[index] = value; else state.recurrenceExceptions.push(value); }

  function openDeleteModal() {
    const kind = el("editingKind").value, id = el("editingId").value, original = el("editingOriginalStart").value;
    el("deleteText").textContent = kind === "series" ? "Выберите, удалить только выбранное занятие или всю повторяющуюся серию." : "Это действие удалит урок из календаря.";
    const options = [];
    if (kind === "series") {
      options.push(`<button class="danger-button" data-delete-action="instance">Удалить только этот урок</button>`, `<button class="danger-button" data-delete-action="series">Удалить всю серию</button>`);
    } else options.push(`<button class="danger-button" data-delete-action="lesson">Удалить урок</button>`);
    el("deleteOptions").innerHTML = options.join(""); el("deleteModal").hidden = false;
    $$('[data-delete-action]').forEach(b => b.addEventListener("click", () => executeDelete(b.dataset.deleteAction, id, original)));
  }

  function executeDelete(action, id, original) {
    if (action === "lesson") state.lessons = state.lessons.filter(x => x.id !== id);
    if (action === "instance") upsertException(id, original, null), Object.assign(state.recurrenceExceptions.find(x => x.seriesId === id && x.originalStartUtc === original), { deleted: true, override: null });
    if (action === "series") { state.recurrenceSeries = state.recurrenceSeries.filter(x => x.id !== id); state.recurrenceExceptions = state.recurrenceExceptions.filter(x => x.seriesId !== id); }
    saveState(); el("deleteModal").hidden = true; closeLessonModal(true); render(); showToast(action === "series" ? "Серия удалена" : "Урок удалён");
  }

  function updateOccurrence(id, changes) {
    const item = findOccurrence(id); if (!item) return;
    if (item.kind === "lesson") { const index = state.lessons.findIndex(x => x.id === item.id); if (index >= 0) state.lessons[index] = { ...state.lessons[index], ...changes, updatedAt: new Date().toISOString() }; }
    else upsertException(item.seriesId, item.originalStartUtc, { ...lessonFields({ ...item, ...changes }), startUtc: item.startUtc, updatedAt: new Date().toISOString() });
    saveState(); render();
  }

  function bindQuickActions(root = document) {
    $$('[data-quick]', root).forEach(button => button.addEventListener("click", async () => {
      const item = findOccurrence(button.dataset.id); if (!item) return;
      if (button.dataset.quick === "complete") { updateOccurrence(item.occurrenceId, { lessonStatus: "completed" }); showToast("Урок отмечен проведённым"); }
      if (button.dataset.quick === "pay") { updateOccurrence(item.occurrenceId, { paymentStatus: "paid" }); showToast("Оплата отмечена"); }
      if (button.dataset.quick === "edit") openLessonForm({ item });
      if (button.dataset.quick === "message") {
        const student = state.students.find(s => s.id === item.studentId);
        const date = zonedDate(item.startUtc, state.settings.timeZone), start = zonedTime(item.startUtc, state.settings.timeZone);
        const endIso = new Date(new Date(item.startUtc).getTime() + item.duration * 60000).toISOString(), end = zonedTime(endIso, state.settings.timeZone);
        const text = `${student?.parentName ? `${student.parentName}, д` : "Д"}обрый день!\n${item.name}\n${displayDate(date, { day: "numeric", month: "long" })}, ${start}–${end}${item.result ? `\nПрошли: ${item.result}` : ""}${item.homework ? `\nДомашнее задание: ${item.homework}` : ""}${item.stars ? `\nУспеваемость: ${"⭐".repeat(item.stars)}` : ""}\nОплата: ${PAYMENT_STATUSES[item.paymentStatus] || "Не оплачено"}`;
        try { await navigator.clipboard.writeText(text); showToast("Сообщение для родителя скопировано"); } catch { prompt("Скопируйте сообщение", text); }
      }
    }));
  }

  function openStudentForm(student = null) {
    el("studentForm").reset(); el("editingStudentId").value = student?.id || ""; el("studentModalTitle").textContent = student ? "Редактировать ученика" : "Новый ученик";
    el("profileName").value = student?.name || ""; el("parentName").value = student?.parentName || ""; el("studentSubject").value = student?.subject || ""; el("studentContact").value = student?.contact || ""; el("defaultDuration").value = student?.defaultDuration || 60; el("defaultPrice").value = (student?.defaultPriceKopecks || 0) / 100; el("defaultLink").value = student?.defaultLink || ""; el("studentNotes").value = student?.notes || ""; el("deleteStudent").hidden = !student; el("studentModal").hidden = false; document.body.style.overflow = "hidden"; requestAnimationFrame(() => el("profileName").focus());
  }
  function closeStudentForm() { el("studentModal").hidden = true; document.body.style.overflow = ""; }
  function submitStudent(event) {
    event.preventDefault(); const name = el("profileName").value.trim(); if (!name) { showToast("Введите имя ученика или группы"); return; }
    const id = el("editingStudentId").value, old = state.students.find(s => s.id === id), value = { id: id || uid("student"), name, parentName: el("parentName").value.trim(), subject: el("studentSubject").value.trim(), contact: el("studentContact").value.trim(), defaultDuration: Math.max(1, +el("defaultDuration").value || 60), defaultPriceKopecks: Math.max(0, Math.round((+el("defaultPrice").value || 0) * 100)), defaultLink: el("defaultLink").value.trim(), notes: el("studentNotes").value.trim(), color: old?.color || COLORS[state.students.length % COLORS.length] };
    if (old) state.students[state.students.findIndex(s => s.id === id)] = value; else state.students.push(value); saveState(); closeStudentForm(); render(); showToast("Карточка ученика сохранена");
  }

  function exportData() { downloadFile(`calendar-backup-${todayInZone(state.settings.timeZone)}.json`, JSON.stringify(state, null, 2), "application/json"); }
  function downloadFile(name, content, type) { const url = URL.createObjectURL(new Blob([content], { type })), a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 500); }
  function exportCsv(items) { const rows = [["Дата", "Время", "Ученик", "Статус", "Оплата", "Сумма"]].concat(items.map(x => [zonedDate(x.startUtc, state.settings.timeZone), zonedTime(x.startUtc, state.settings.timeZone), x.name, LESSON_STATUSES[x.lessonStatus || "planned"], PAYMENT_STATUSES[x.paymentStatus], (x.priceKopecks || 0) / 100])); downloadFile("calendar-finance.csv", "\ufeff" + rows.map(row => row.map(v => `"${String(v ?? "").replaceAll('"', '""')}"`).join(";")).join("\n"), "text/csv;charset=utf-8"); }
  async function importData(file) { try { const parsed = JSON.parse(await file.text()); if (!parsed || !Array.isArray(parsed.lessons) || !Array.isArray(parsed.recurrenceSeries)) throw new Error(); if (!confirm("Заменить текущие данные содержимым резервной копии?")) return; parsed.version = parsed.version || 1; localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)); state = loadState(); render(); showToast("Резервная копия восстановлена"); } catch { showToast("Не удалось прочитать резервную копию"); } el("importFile").value = ""; }

  function setView(view) { state.settings.calendarView = view; if (view === "week") mobileWeekDay = weekdayIndex(cursorDate); saveState(); render(); }
  function movePeriod(amount) { const view = state.settings.calendarView; cursorDate = view === "month" ? addMonths(cursorDate, amount) : addDays(cursorDate, amount * (view === "week" ? 7 : 1)); render(); }
  function switchZone(direction) { const index = ZONES.findIndex(z => z.id === state.settings.timeZone); state.settings.timeZone = ZONES[(index + direction + ZONES.length) % ZONES.length].id; saveState(); cursorDate = todayInZone(state.settings.timeZone); updateClocks(); render(); showToast(`Часовой пояс: ${ZONES.find(z => z.id === state.settings.timeZone).label}`); }

  function updateClocks() {
    const now = new Date(), zone = ZONES.find(z => z.id === state.settings.timeZone) || ZONES[0];
    el("zoneName").textContent = zone.label; el("localClock").textContent = new Intl.DateTimeFormat("ru-RU", { timeZone: zone.id, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now); el("moscowClock").textContent = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  }

  function showToast(message) { clearTimeout(toastTimer); el("toast").textContent = message; el("toast").classList.add("show"); toastTimer = setTimeout(() => el("toast").classList.remove("show"), 2600); }
  function trapFocus(event, modal) { if (event.key !== "Tab") return; const focusable = $$('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', modal).filter(x => x.offsetParent !== null); if (!focusable.length) return; const first = focusable[0], last = focusable.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }

  el("lessonForm").addEventListener("submit", submitLesson);
  el("studentForm").addEventListener("submit", submitStudent);
  $$('[data-close-student]').forEach(b => b.addEventListener("click", closeStudentForm));
  el("deleteStudent").addEventListener("click", () => { const id = el("editingStudentId").value; if (!id || !confirm("Удалить карточку ученика? Уроки останутся в календаре.")) return; state.students = state.students.filter(s => s.id !== id); saveState(); closeStudentForm(); render(); showToast("Карточка удалена, уроки сохранены"); });
  el("studentId").addEventListener("change", () => { const s = state.students.find(x => x.id === el("studentId").value); if (!s) return; el("studentName").value = s.subject ? `${s.name} — ${s.subject.split("·")[0].trim()}` : s.name; el("duration").value = s.defaultDuration || 60; el("price").value = (s.defaultPriceKopecks || 0) / 100; el("meetingLink").value = s.defaultLink || ""; selectedColor = s.color || COLORS[0]; renderColorPicker(); });
  $$('[data-section]').forEach(b => b.addEventListener("click", () => { activeSection = b.dataset.section; render(); }));
  el("calendarSearch").addEventListener("input", () => { filters.search = el("calendarSearch").value.trim(); render(); });
  el("studentFilter").addEventListener("change", () => { filters.studentId = el("studentFilter").value; render(); });
  el("statusFilter").addEventListener("change", () => { filters.status = el("statusFilter").value; render(); });
  el("unpaidOnly").addEventListener("change", () => { filters.unpaidOnly = el("unpaidOnly").checked; render(); });
  el("exportData").addEventListener("click", exportData); el("importData").addEventListener("click", () => el("importFile").click()); el("importFile").addEventListener("change", () => { if (el("importFile").files[0]) importData(el("importFile").files[0]); });
  el("addLesson").addEventListener("click", () => openLessonForm());
  el("todayButton").addEventListener("click", () => { cursorDate = todayInZone(state.settings.timeZone); render(); });
  el("previousPeriod").addEventListener("click", () => movePeriod(-1)); el("nextPeriod").addEventListener("click", () => movePeriod(1));
  el("tzPrev").addEventListener("click", () => switchZone(-1)); el("tzNext").addEventListener("click", () => switchZone(1));
  $$("[data-view]").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  $$("[data-close-modal]").forEach(b => b.addEventListener("click", () => closeLessonModal()));
  $$("[data-close-delete]").forEach(b => b.addEventListener("click", () => { el("deleteModal").hidden = true; }));
  el("deleteLesson").addEventListener("click", openDeleteModal);
  el("recurrence").addEventListener("change", () => { el("recurrenceEndField").hidden = el("recurrence").value === "none"; if (!el("recurrenceEnd").value) el("recurrenceEnd").value = addDays(el("lessonDate").value || cursorDate, 42); });
  $$('[data-duration]').forEach(b => b.addEventListener("click", () => { el("duration").value = b.dataset.duration; $$('[data-duration]').forEach(x => x.classList.toggle("selected", x === b)); }));
  document.addEventListener("keydown", e => {
    if (!el("deleteModal").hidden) { trapFocus(e, el("deleteModal")); if (e.key === "Escape") el("deleteModal").hidden = true; return; }
    if (!el("lessonModal").hidden) { trapFocus(e, el("lessonModal")); if (e.key === "Escape") closeLessonModal(); }
  });
  el("lessonModal").addEventListener("click", e => { if (e.target === el("lessonModal")) closeLessonModal(); });
  el("deleteModal").addEventListener("click", e => { if (e.target === el("deleteModal")) el("deleteModal").hidden = true; });
  el("studentModal").addEventListener("click", e => { if (e.target === el("studentModal")) closeStudentForm(); });

  updateClocks(); setInterval(updateClocks, 1000); render();
})();
