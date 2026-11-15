'use strict';

/* =========================================================
   Хранилище
   state = {
     days:  { 'YYYY-MM-DD': [{ id, text, status: 'todo'|'done'|'missed', time: 'morning'|'midday'|'evening' }] },
     tasks: [{ id, text, done }],
     goals: [{ id, title, deadline: 'YYYY-MM-DD'|'', done, steps: [{ id, text, done }] }]
   }
   Порядок элементов в массивах = порядок на экране.
   ========================================================= */
const STORAGE_KEY = 'planner.v1';
const TAB_KEY = 'planner.tab';

const SLOTS = [
  { id: 'morning', label: 'Утро' },
  { id: 'midday', label: 'День' },
  { id: 'evening', label: 'Вечер' },
];
const SLOT_IDS = SLOTS.map(s => s.id);

function loadState() {
  let s = { days: {}, tasks: [], goals: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      s = { days: d.days || {}, tasks: d.tasks || [], goals: d.goals || [] };
    }
  } catch (e) { /* хранилище недоступно — работаем в памяти */ }
  // Миграция: у дел из первой версии нет времени суток
  for (const items of Object.values(s.days)) {
    for (const it of items) if (!SLOT_IDS.includes(it.time)) it.time = 'midday';
  }
  return s;
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

const state = loadState();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* =========================================================
   Даты
   ========================================================= */
const DAY_NAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
  'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const pad = n => String(n).padStart(2, '0');
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
function startOfWeek(d) {
  const shift = (d.getDay() + 6) % 7; // понедельник = 0
  return addDays(d, -shift);
}
const fmtDay = d => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* =========================================================
   DOM-хелперы
   ========================================================= */
const $ = sel => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

/** Превращает текстовый элемент в поле редактирования по двойному клику. */
function makeEditable(span, getValue, setValue) {
  span.title = 'Двойной клик — редактировать';
  span.addEventListener('dblclick', () => {
    const input = el('input', { type: 'text', class: 'edit-input', maxlength: 200 });
    input.value = getValue();
    let finished = false;
    const finish = save => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      if (save && v) setValue(v);
      commit();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    span.replaceWith(input);
    input.focus();
    input.select();
  });
}

function refocus(dataKey) {
  const again = document.querySelector(`[data-input="${dataKey}"]`);
  if (again) again.focus();
}

function addForm(placeholder, onAdd, dataKey) {
  const input = el('input', { type: 'text', placeholder, maxlength: 200, autocomplete: 'off', 'data-input': dataKey });
  return el('form', {
    class: 'add-form',
    onsubmit: e => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      onAdd(v);
      commit();
      refocus(dataKey);
    }
  }, input, el('button', { type: 'submit', class: 'btn', 'aria-label': 'Добавить', text: '+' }));
}

function progressBar(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = el('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 });
  bar.append(el('span', { style: `width:${pct}%` }));
  return bar;
}

const dragHandle = () => el('button', {
  type: 'button', class: 'handle', text: '⠿', tabindex: -1,
  title: 'Перетащите, чтобы переместить', 'aria-label': 'Переместить'
});

function commit() { saveState(); render(); }

/* =========================================================
   Перетаскивание (pointer events — работает и мышью, и пальцем)
   Каждый список-приёмник помечен data-list="<id списка>",
   каждый элемент — data-id. Схема id списков:
     day:<YYYY-MM-DD>:<morning|midday|evening>,  tasks,  goals,  goal:<goalId>
   ========================================================= */
const listKind = listId => listId.startsWith('day:') ? 'day' : listId;

function resolveList(listId) {
  const [kind, a, b] = listId.split(':');
  if (kind === 'day') return { arr: state.days[a] || (state.days[a] = []), patch: { time: b } };
  if (kind === 'tasks') return { arr: state.tasks };
  if (kind === 'goals') return { arr: state.goals };
  if (kind === 'goal') { const g = state.goals.find(x => x.id === a); return g && { arr: g.steps }; }
  return null;
}

function moveItem(fromId, itemId, toId, beforeId) {
  const from = resolveList(fromId), to = resolveList(toId);
  if (!from || !to) return;
  const idx = from.arr.findIndex(x => x.id === itemId);
  if (idx < 0) return;
  const [item] = from.arr.splice(idx, 1);
  if (to.patch) Object.assign(item, to.patch);
  const at = beforeId ? to.arr.findIndex(x => x.id === beforeId) : -1;
  if (at >= 0) to.arr.splice(at, 0, item); else to.arr.push(item);
  for (const k of Object.keys(state.days)) if (!state.days[k].length) delete state.days[k];
  commit();
}

let drag = null;

function makeDraggable(node, handle, listId, id) {
  node.dataset.id = id;
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = node.getBoundingClientRect();
    const ghost = node.cloneNode(true);
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    document.body.append(ghost);
    node.classList.add('dragging');
    document.body.classList.add('is-dragging');
    drag = { node, ghost, listId, id, dx: e.clientX - rect.left, dy: e.clientY - rect.top, target: null };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  });
}

function onDragMove(e) {
  if (!drag) return;
  drag.ghost.style.left = `${e.clientX - drag.dx}px`;
  drag.ghost.style.top = `${e.clientY - drag.dy}px`;

  // автопрокрутка у краёв окна
  if (e.clientY < 60) window.scrollBy(0, -12);
  else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 12);

  const kind = listKind(drag.listId);
  let zone = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-list]');
  while (zone && listKind(zone.dataset.list) !== kind) zone = zone.parentElement?.closest('[data-list]');
  if (!zone) return; // вне подходящего списка — оставляем последнюю позицию

  if (drag.zoneEl !== zone) {
    drag.zoneEl?.classList.remove('drop-target');
    zone.classList.add('drop-target');
    drag.zoneEl = zone;
  }
  const container = zone.querySelector(':scope > [data-items]') || zone;
  const siblings = [...container.children].filter(c => c.dataset.id && c !== drag.node);
  const before = siblings.find(c => {
    const r = c.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  }) || null;
  if (drag.node.parentElement !== container || drag.node.nextElementSibling !== before) {
    container.insertBefore(drag.node, before);
  }
  drag.target = { listId: zone.dataset.list, beforeId: before ? before.dataset.id : null };
}

function onDragEnd() {
  if (!drag) return;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  const { ghost, node, listId, id, target, zoneEl } = drag;
  drag = null;
  ghost.remove();
  zoneEl?.classList.remove('drop-target');
  node.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  if (target) moveItem(listId, id, target.listId, target.beforeId);
  else render();
}

/* =========================================================
   Неделя
   ========================================================= */
let weekOffset = 0;
const pendingSlot = {}; // выбранное время суток в форме каждого дня

function renderWeek() {
  const now = today();
  const monday = addDays(startOfWeek(now), weekOffset * 7);
  const sunday = addDays(monday, 6);

  $('#week-label').textContent = monday.getFullYear() === sunday.getFullYear()
    ? `${fmtDay(monday)} — ${fmtDay(sunday)} ${sunday.getFullYear()}`
    : `${fmtDay(monday)} ${monday.getFullYear()} — ${fmtDay(sunday)} ${sunday.getFullYear()}`;

  const grid = $('#week-grid');
  grid.replaceChildren();
  let total = 0, done = 0, missed = 0;

  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const key = dateKey(date);
    const items = state.days[key] || [];
    const dDone = items.filter(t => t.status === 'done').length;
    const dMissed = items.filter(t => t.status === 'missed').length;
    total += items.length; done += dDone; missed += dMissed;

    const isToday = key === dateKey(now);

    const slots = el('div', { class: 'slots' });
    for (const slot of SLOTS) {
      const slotItems = items.filter(t => t.time === slot.id);
      const list = el('ul', { class: 'item-list', 'data-items': '' });
      slotItems.forEach(item => list.append(dayItem(key, item)));
      // Вся секция (вместе с заголовком) — зона сброса, чтобы можно было бросить в пустую секцию
      slots.append(el('div', { class: `slot ${slot.id}${slotItems.length ? '' : ' empty'}`, 'data-list': `day:${key}:${slot.id}` },
        el('div', { class: 'slot-head', text: slot.label }),
        list
      ));
    }

    grid.append(el('section', { class: `day${isToday ? ' today' : ''}` },
      el('div', { class: 'day-head' },
        el('div', {},
          el('div', { class: 'day-name' }, DAY_NAMES[i], isToday ? el('span', { class: 'today-badge', text: 'сегодня' }) : null),
          el('div', { class: 'day-date', text: fmtDay(date) })
        ),
        el('div', { class: 'day-count', text: items.length ? `${dDone} из ${items.length}` : '' })
      ),
      items.length ? progressBar(dDone, items.length) : null,
      slots,
      dayAddForm(key)
    ));
  }

  $('#week-stats').replaceChildren(
    el('span', { class: 'pill', text: `Всего: ${total}` }),
    el('span', { class: 'pill done', text: `Сделано: ${done}` }),
    el('span', { class: 'pill missed', text: `Не сделано: ${missed}` }),
    el('span', { class: 'pill', text: `В планах: ${total - done - missed}` })
  );
}

function dayAddForm(key) {
  const dataKey = `day-${key}`;
  const current = pendingSlot[key] || 'morning';
  const input = el('input', { type: 'text', placeholder: 'Что нужно сделать?', maxlength: 200, autocomplete: 'off', 'data-input': dataKey });

  const picker = el('div', { class: 'slot-picker', role: 'group', 'aria-label': 'Время суток' });
  for (const slot of SLOTS) {
    picker.append(el('button', {
      type: 'button', class: `slot-btn ${slot.id}`, text: slot.label,
      'aria-pressed': String(slot.id === current),
      onclick: () => {
        pendingSlot[key] = slot.id;
        picker.querySelectorAll('.slot-btn').forEach(b => b.setAttribute('aria-pressed', String(b === picker.querySelector(`.${slot.id}`))));
        input.focus();
      }
    }));
  }

  return el('form', {
    class: 'add-form day-add',
    onsubmit: e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      (state.days[key] = state.days[key] || []).push({ id: uid(), text, status: 'todo', time: pendingSlot[key] || 'morning' });
      commit();
      refocus(dataKey);
    }
  },
    input,
    el('div', { class: 'day-add-row' },
      picker,
      el('button', { type: 'submit', class: 'btn', 'aria-label': 'Добавить', text: '+' })
    )
  );
}

function dayItem(key, item) {
  const setStatus = s => { item.status = item.status === s ? 'todo' : s; commit(); };
  const text = el('span', { class: 'item-text', text: item.text });
  makeEditable(text, () => item.text, v => { item.text = v; });
  const handle = dragHandle();

  const li = el('li', { class: `item ${item.status}` },
    handle,
    el('button', {
      class: `mark ok${item.status === 'done' ? ' on' : ''}`, text: '✓',
      title: 'Сделано', 'aria-label': 'Отметить как сделанное', 'aria-pressed': String(item.status === 'done'),
      onclick: () => setStatus('done')
    }),
    el('button', {
      class: `mark no${item.status === 'missed' ? ' on' : ''}`, text: '✕',
      title: 'Не сделано', 'aria-label': 'Отметить как несделанное', 'aria-pressed': String(item.status === 'missed'),
      onclick: () => setStatus('missed')
    }),
    text,
    el('button', {
      class: 'del', text: '×', title: 'Удалить', 'aria-label': 'Удалить',
      onclick: () => {
        state.days[key] = state.days[key].filter(t => t.id !== item.id);
        if (!state.days[key].length) delete state.days[key];
        commit();
      }
    })
  );
  makeDraggable(li, handle, `day:${key}:${item.time}`, item.id);
  return li;
}

/* =========================================================
   Глобальные задачи
   ========================================================= */
function checkItem(item, listId, onDelete) {
  const text = el('span', { class: 'item-text', text: item.text });
  makeEditable(text, () => item.text, v => { item.text = v; });
  const handle = dragHandle();
  const li = el('li', { class: `item${item.done ? ' done' : ''}` },
    handle,
    el('button', {
      class: `mark ok${item.done ? ' on' : ''}`, text: '✓',
      'aria-label': 'Выполнено', 'aria-pressed': String(item.done),
      onclick: () => { item.done = !item.done; commit(); }
    }),
    text,
    el('button', { class: 'del', text: '×', title: 'Удалить', 'aria-label': 'Удалить', onclick: onDelete })
  );
  makeDraggable(li, handle, listId, item.id);
  return li;
}

function renderTasks() {
  const list = $('#task-list');
  list.replaceChildren();
  list.dataset.list = 'tasks';
  if (!state.tasks.length) list.append(el('li', { class: 'empty', text: 'Глобальных задач пока нет' }));
  state.tasks.forEach(task => {
    list.append(checkItem(task, 'tasks', () => {
      state.tasks = state.tasks.filter(t => t.id !== task.id);
      commit();
    }));
  });
}

/* =========================================================
   Цели
   ========================================================= */
function deadlineInfo(goal) {
  if (!goal.deadline) return null;
  const date = parseKey(goal.deadline);
  const days = Math.round((date - today()) / 86400000);
  let label = `до ${fmtDay(date)} ${date.getFullYear()}`;
  if (!goal.done) {
    if (days > 0) label += ` · осталось ${days} ${plural(days, 'день', 'дня', 'дней')}`;
    else if (days === 0) label += ' · сегодня';
    else label += ` · просрочено на ${-days} ${plural(-days, 'день', 'дня', 'дней')}`;
  }
  return el('span', { class: `deadline${!goal.done && days < 0 ? ' overdue' : ''}`, text: label });
}

function renderGoals() {
  const wrap = $('#goal-list');
  wrap.replaceChildren();
  wrap.dataset.list = 'goals';
  if (!state.goals.length) {
    wrap.append(el('div', { class: 'empty', text: 'Добавьте первую цель — например, «Прочитать 12 книг за год»' }));
    return;
  }

  state.goals.forEach(goal => {
    const stepsDone = goal.steps.filter(s => s.done).length;
    const title = el('span', { class: 'goal-title', text: goal.title });
    makeEditable(title, () => goal.title, v => { goal.title = v; });
    const handle = dragHandle();

    const steps = el('ul', { class: 'item-list', 'data-list': `goal:${goal.id}` });
    goal.steps.forEach(step => steps.append(checkItem(step, `goal:${goal.id}`, () => {
      goal.steps = goal.steps.filter(s => s.id !== step.id);
      commit();
    })));

    const card = el('article', { class: `goal${goal.done ? ' complete' : ''}` },
      el('div', { class: 'goal-head' },
        handle,
        el('button', {
          class: `mark ok${goal.done ? ' on' : ''}`, text: '✓',
          title: 'Цель достигнута', 'aria-label': 'Цель достигнута', 'aria-pressed': String(goal.done),
          onclick: () => { goal.done = !goal.done; commit(); }
        }),
        title,
        el('button', {
          class: 'del', text: '×', title: 'Удалить цель', 'aria-label': 'Удалить цель',
          onclick: () => {
            if (!confirm(`Удалить цель «${goal.title}»?`)) return;
            state.goals = state.goals.filter(g => g.id !== goal.id);
            commit();
          }
        })
      ),
      el('div', { class: 'goal-meta' },
        goal.steps.length
          ? el('span', { text: `Шаги: ${stepsDone} из ${goal.steps.length} (${Math.round(stepsDone / goal.steps.length * 100)}%)` })
          : el('span', { text: 'Шагов пока нет' }),
        deadlineInfo(goal)
      ),
      goal.steps.length ? progressBar(stepsDone, goal.steps.length) : null,
      steps,
      addForm('Добавить шаг…', text => {
        goal.steps.push({ id: uid(), text, done: false });
      }, `goal-${goal.id}`)
    );
    makeDraggable(card, handle, 'goals', goal.id);
    wrap.append(card);
  });
}

/* =========================================================
   Вкладки, события, запуск
   ========================================================= */
function setTab(name) {
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
  try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* ignore */ }
}

function render() {
  renderWeek();
  renderTasks();
  renderGoals();
}

document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#prev-week').addEventListener('click', () => { weekOffset--; renderWeek(); });
$('#next-week').addEventListener('click', () => { weekOffset++; renderWeek(); });
$('#this-week').addEventListener('click', () => { weekOffset = 0; renderWeek(); });

$('#task-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#task-input');
  const text = input.value.trim();
  if (!text) return;
  state.tasks.push({ id: uid(), text, done: false });
  input.value = '';
  commit();
});

$('#goal-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#goal-input');
  const title = input.value.trim();
  if (!title) return;
  state.goals.push({ id: uid(), title, deadline: $('#goal-deadline').value, done: false, steps: [] });
  input.value = '';
  $('#goal-deadline').value = '';
  commit();
});

let savedTab = 'week';
try { savedTab = localStorage.getItem(TAB_KEY) || 'week'; } catch (e) { /* ignore */ }
setTab(savedTab === 'goals' ? 'goals' : 'week');
render();
