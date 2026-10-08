// The Library panel's list: every source (the preset sets, the snippets, the
// example scores — and the reference, later) is one array of items, shown
// through one search box and one set of filters. This file is the list and
// nothing else: what an item is, how it sounds and what inserting it writes
// are the page's (index.html), passed in on the items.
//
// An item:
//   { key, source, group, groupLabel, name, kind, about,
//     track: 'voice' | 'sample' | 'macro' | null,   // what a track takes it as
//     audition: () => …   | null,                    // ▶ and Space
//     actions: [{ label, title, run }],              // buttons; [0] is Enter's
//   }
// A group may carry its own actions (a preset set's Import set), given as
// groupActions: { [group]: [{ label, title, run }] }.
//
// With no query the list is grouped, every group folded until opened; a query
// or A–Z order makes it one flat list, ranked as the completion ranks names:
// a prefix of the name, then anywhere in the name, then the description.

export function createCatalogList({ list, note, hint = () => '', onHighlight = () => {} }) {
  let items = [];
  let groupActions = {};
  let filter = { source: 'all', kinds: new Set(), fits: null, order: 'group', query: '' };
  const open = new Set(); // groups unfolded by hand
  let rows = []; // what is on screen, in order: { el, item } or { el, group }
  let at = -1;

  function setItems(next, nextGroupActions = {}) {
    items = next;
    groupActions = nextGroupActions;
    render();
  }

  function setFilter(patch) {
    filter = { ...filter, ...patch };
    render();
  }

  function visible() {
    return items.filter((it) =>
      (filter.source === 'all' || it.source === filter.source)
      && (filter.kinds.size === 0 || filter.kinds.has(it.kind))
      && (!filter.fits || filter.fits(it)));
  }

  function ranked(list, q) {
    const out = [];
    for (const it of list) {
      const name = it.name.toLowerCase();
      let rank;
      if (!q) rank = 0;
      else if (name.startsWith(q)) rank = 0;
      else if (name.includes(q)) rank = 1;
      else if ((it.about ?? '').toLowerCase().includes(q)) rank = 2;
      else continue;
      out.push([rank, it]);
    }
    return out.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([, it]) => it);
  }

  function button(label, title, run) {
    const b = document.createElement('button');
    b.className = 'lib-mini';
    b.textContent = label;
    if (title) b.title = title;
    b.onclick = (e) => { e.stopPropagation(); run(); };
    return b;
  }

  function itemRow(it, showGroup) {
    const el = document.createElement('div');
    el.className = 'lib-row';
    if (it.audition) el.appendChild(button('▶', 'Play', it.audition));
    const name = document.createElement('span');
    name.className = 'lib-name';
    name.textContent = it.name;
    const kind = document.createElement('span');
    kind.className = 'lib-kind';
    kind.textContent = showGroup ? `${it.kind} · ${it.groupLabel}` : it.kind;
    el.append(name, kind);
    for (const a of it.actions) el.appendChild(button(a.label, a.title, a.run));
    return el;
  }

  function groupRow(group, label, count, unfolded) {
    const el = document.createElement('div');
    el.className = 'lib-group' + (unfolded ? ' open' : '');
    const name = document.createElement('span');
    name.className = 'lib-name';
    name.textContent = label;
    const n = document.createElement('span');
    n.className = 'lib-kind';
    n.textContent = String(count);
    el.append(name, n);
    for (const a of groupActions[group] ?? []) el.appendChild(button(a.label, a.title, a.run));
    return el;
  }

  function render() {
    const keep = rows[at]?.item?.key ?? rows[at]?.group;
    list.innerHTML = '';
    rows = [];
    const q = filter.query.trim().toLowerCase();
    const shown = visible();
    if (q || filter.order === 'az') {
      for (const it of ranked(shown, q)) rows.push({ el: itemRow(it, true), item: it });
    } else {
      const groups = new Map();
      for (const it of shown) {
        if (!groups.has(it.group)) groups.set(it.group, []);
        groups.get(it.group).push(it);
      }
      for (const [group, members] of groups) {
        const unfolded = open.has(group);
        rows.push({ el: groupRow(group, members[0].groupLabel, members.length, unfolded), group });
        if (unfolded) for (const it of members) rows.push({ el: itemRow(it, false), item: it });
      }
    }
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lib-empty';
      empty.textContent = items.length ? 'Nothing matches.' : 'Loading…';
      list.appendChild(empty);
    }
    rows.forEach((r, i) => {
      r.el.addEventListener('click', () => {
        highlight(i);
        if (r.group) toggle(r.group);
      });
      list.appendChild(r.el);
    });
    const again = rows.findIndex((r) => (r.item?.key ?? r.group) === keep);
    at = -1;
    highlight(again >= 0 ? again : 0, false);
  }

  function highlight(i, scroll = true) {
    if (rows.length === 0) { at = -1; note.textContent = hint(null); onHighlight(null); return; }
    at = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, n) => r.el.classList.toggle('active', n === at));
    if (scroll) rows[at].el.scrollIntoView({ block: 'nearest' });
    const item = rows[at].item ?? null;
    note.textContent = item?.about || hint(item);
    onHighlight(item);
  }

  function toggle(group, unfold = !open.has(group)) {
    if (unfold) open.add(group);
    else open.delete(group);
    render();
  }

  // The keys a list takes, from the search box as from the list itself;
  // `typing` is true in the search box, where Space and ←→ stay text.
  // Returns true when the key was the list's.
  function key(e, typing) {
    const r = rows[at];
    switch (e.key) {
      case 'ArrowDown': highlight(at + 1); return true;
      case 'ArrowUp': highlight(at - 1); return true;
      case 'ArrowRight':
        if (typing || !r?.group) return false;
        toggle(r.group, true); return true;
      case 'ArrowLeft':
        if (typing) return false;
        if (r?.group) toggle(r.group, false);
        else if (r?.item && !filter.query && filter.order === 'group') {
          toggle(r.item.group, false);
          highlight(rows.findIndex((x) => x.group === r.item.group));
        }
        return true;
      case ' ':
        if (typing) return false;
        if (!e.repeat) r?.item?.audition?.();
        return true;
      case 'Enter':
        if (r?.group) toggle(r.group);
        else r?.item?.actions[0]?.run();
        return true;
      default: return false;
    }
  }

  return { setItems, setFilter, key, refresh: render, get filter() { return filter; } };
}
