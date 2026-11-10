const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  files: new Map(), // path -> meta
  manualSplit: new Set(), // a series starts at this file
  manualJoin: new Set(), // this file stays with the previous one
  excluded: new Set(), // series keys the user unticked
  status: new Map(), // series key -> { state, pct, msg, out }
  busy: false,
  hdrmerge: null,
  lightcraft: false,
  customDir: null,
};
let groups = [];
const rowEls = new Map();

/* ---------- formatting ---------- */

const stem = (name) => name.replace(/\.[^.]+$/, '');
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function shutter(t) {
  if (!t) return '?';
  if (t >= 0.3) return `${+t.toFixed(1)} s`.replace('.', ',');
  return `1/${Math.round(1 / t)}`;
}

// Exposure value at ISO 100: high for short, bright-scene exposures.
function ev(f) {
  if (!f.exp || !f.fnum) return null;
  return Math.log2((f.fnum * f.fnum) / f.exp) - Math.log2((f.iso || 100) / 100);
}

function sceneOf(files) {
  const evs = files.map(ev).filter((v) => v !== null).sort((a, b) => a - b);
  if (!evs.length) return null;
  const mid = evs[Math.floor(evs.length / 2)];
  if (mid < 5) return { label: 'Nuit', cls: 'night' };
  if (mid < 10) return { label: 'Faible lumière', cls: 'dim' };
  return { label: 'Jour', cls: 'day' };
}

/* ---------- grouping ---------- */

function computeGroups() {
  const gap = Number($('gap').value);
  const sorted = [...state.files.values()].sort(
    (a, b) => a.dir.localeCompare(b.dir) || a.time - b.time || a.name.localeCompare(b.name)
  );
  const out = [];
  let prev = null;
  for (const f of sorted) {
    let startsNew = !prev || prev.dir !== f.dir;
    if (!startsNew) {
      const pause = (f.time - prev.time) / 1000 - (prev.exp || 0);
      startsNew = pause > gap;
      if (state.manualSplit.has(f.path)) startsNew = true;
      else if (state.manualJoin.has(f.path)) startsNew = false;
    }
    if (startsNew) out.push({ key: f.path, dir: f.dir, files: [] });
    out[out.length - 1].files.push(f);
    prev = f;
  }
  return out;
}

const engine = () => $('engine').querySelector('[aria-checked="true"]').dataset.v;
const engineReady = () => (engine() === 'lightcraft' ? state.lightcraft : !!state.hdrmerge);

function paintEngine() {
  const lc = engine() === 'lightcraft';
  document.body.dataset.engine = engine();
  $('engineHint').textContent = lc
    ? 'Fusionne, développe avec les réglages Theta et exporte. Le traitement se fait en arrière-plan, sans toucher à votre bibliothèque.'
    : 'Fusion seule, en DNG flottant plus léger. Le fichier sort sombre et se développe à la main.';
}

const isSingle = (g) => g.files.length < 2;
const isSelected = (g) => !isSingle(g) && !state.excluded.has(g.key);

function outPath(g) {
  const mode = $('outMode').value;
  const dir = mode === 'custom' && state.customDir ? state.customDir : mode === 'sub' ? `${g.dir}/HDR` : g.dir;
  const name = ($('tpl').value.trim() || '{premier}_HDR')
    .replaceAll('{premier}', stem(g.files[0].name))
    .replaceAll('{dernier}', stem(g.files[g.files.length - 1].name))
    .replaceAll('{n}', String(g.files.length))
    .replace(/[/:]/g, '-');
  return `${dir}/${name}.dng`;
}

/* ---------- thumbnails ---------- */

const thumbCache = new Map();
const thumbQueue = [];
let thumbActive = 0;

function pumpThumbs() {
  while (thumbActive < 4 && thumbQueue.length) {
    const { path, resolve } = thumbQueue.shift();
    thumbActive++;
    window.api.thumb(path).then((url) => {
      thumbActive--;
      resolve(url);
      pumpThumbs();
    });
  }
}

function thumbFor(path) {
  if (!thumbCache.has(path)) {
    thumbCache.set(
      path,
      new Promise((resolve) => {
        thumbQueue.push({ path, resolve });
        pumpThumbs();
      })
    );
  }
  return thumbCache.get(path);
}

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      thumbFor(e.target.dataset.path).then((url) => {
        if (url) {
          e.target.src = url;
          e.target.classList.add('loaded');
        }
      });
    }
  },
  { rootMargin: '300px' }
);

/* ---------- rendering ---------- */

function render() {
  groups = computeGroups();
  const list = $('groups');
  list.textContent = '';
  rowEls.clear();

  const has = groups.length > 0;
  $('empty').hidden = has;
  $('scale').hidden = !has;
  $('clear').hidden = !has;

  const allEv = [...state.files.values()].map(ev).filter((v) => v !== null);
  const lo = Math.min(...allEv) - 0.5;
  const hi = Math.max(...allEv) + 0.5;
  const pos = (v) => ((v - lo) / (hi - lo || 1)) * 100;

  groups.forEach((g, i) => {
    const li = el('li', 'group');
    if (isSingle(g)) li.classList.add('single');

    const head = el('div', 'g-head');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = isSelected(g);
    check.disabled = isSingle(g);
    check.setAttribute('aria-label', 'Inclure cette série');
    check.addEventListener('change', () => {
      if (check.checked) state.excluded.delete(g.key);
      else state.excluded.add(g.key);
      li.classList.toggle('off', !check.checked);
      updateFooter();
    });
    li.classList.toggle('off', !check.checked);
    head.append(check);

    const first = stem(g.files[0].name);
    const last = stem(g.files[g.files.length - 1].name);
    head.append(el('strong', 'g-name', isSingle(g) ? first : `${first} à ${last}`));

    const exps = g.files.map((f) => f.exp).filter(Boolean);
    const span = exps.length > 1 ? Math.log2(Math.max(...exps) / Math.min(...exps)) : 0;
    const bits = [plural(g.files.length, 'vue', 'vues')];
    if (span > 0) bits.push(`${Math.round(span * 10) / 10} IL d'écart`.replace('.', ','));
    const f0 = g.files[0];
    if (f0.fnum) bits.push(`f/${f0.fnum}`);
    if (f0.iso) bits.push(`ISO ${f0.iso}`);
    head.append(el('span', 'g-meta', bits.join(', ')));

    const scene = sceneOf(g.files);
    if (scene) head.append(el('span', `tag ${scene.cls}`, scene.label));

    if (i > 0 && groups[i - 1].dir === g.dir) {
      const join = el('button', 'link join', 'Rattacher à la série précédente');
      join.addEventListener('click', () => {
        if (state.manualSplit.has(g.key)) state.manualSplit.delete(g.key);
        else state.manualJoin.add(g.key);
        render();
      });
      head.append(join);
    }

    const st = el('button', 'g-state');
    st.addEventListener('click', () => {
      const s = state.status.get(g.key);
      if (s && s.out) window.api.reveal(s.out);
    });
    head.append(st);
    li.append(head);

    const body = el('div', 'g-body');
    const strip = el('div', 'strip');
    g.files.forEach((f, j) => {
      if (j > 0) {
        const cut = el('button', 'cut');
        cut.title = 'Couper la série ici';
        cut.setAttribute('aria-label', `Couper la série avant ${f.name}`);
        cut.addEventListener('click', () => {
          if (state.manualJoin.has(f.path)) state.manualJoin.delete(f.path);
          else state.manualSplit.add(f.path);
          render();
        });
        strip.append(cut);
      }
      const fig = el('figure', 'frame');
      fig.title = f.name;
      const img = el('img');
      img.alt = '';
      img.dataset.path = f.path;
      thumbObserver.observe(img);
      fig.append(img, el('figcaption', '', shutter(f.exp)));
      strip.append(fig);
    });
    body.append(strip);

    const ladder = el('div', 'ladder');
    const evs = g.files.map(ev).filter((v) => v !== null);
    if (evs.length) {
      const a = pos(Math.min(...evs));
      const b = pos(Math.max(...evs));
      const bar = el('div', 'ladder-span');
      bar.style.left = `${a}%`;
      bar.style.width = `${Math.max(b - a, 0.4)}%`;
      ladder.append(bar);
      for (const v of evs) {
        const tick = el('i', 'tick');
        tick.style.left = `${pos(v)}%`;
        ladder.append(tick);
      }
    }
    body.append(ladder);
    li.append(body);

    const prog = el('div', 'g-progress');
    prog.append(el('div'));
    li.append(prog);

    list.append(li);
    rowEls.set(g.key, li);
    paintStatus(g.key);
  });

  updateFooter();
  updateTplPreview();
}

function paintStatus(key) {
  const li = rowEls.get(key);
  if (!li) return;
  const g = groups.find((x) => x.key === key);
  const s = state.status.get(key);
  const btn = li.querySelector('.g-state');
  const bar = li.querySelector('.g-progress > div');
  li.dataset.state = s ? s.state : '';
  btn.disabled = !(s && s.out);
  btn.title = s && s.msg ? s.msg : '';
  bar.style.width = s && s.state === 'running' ? `${s.pct || 0}%` : '0';

  if (!s) btn.textContent = g && isSingle(g) ? 'Vue seule, non fusionnée' : '';
  else if (s.state === 'queued') btn.textContent = 'En attente';
  else if (s.state === 'running') btn.textContent = `Fusion ${Math.round(s.pct || 0)} %`;
  else if (s.state === 'done') btn.textContent = 'Fusionnée, afficher le fichier';
  else if (s.state === 'skipped') btn.textContent = 'Ignorée, le fichier existe déjà';
  else if (s.state === 'cancelled') btn.textContent = 'Arrêtée';
  else if (s.state === 'error') btn.textContent = `Échec : ${s.msg}`;
}

function updateFooter() {
  const sel = groups.filter(isSelected);
  const go = $('go');
  const text = $('footText');
  $('summary').textContent = groups.length
    ? `${plural(groups.length, 'série', 'séries')}, ${plural(state.files.size, 'vue', 'vues')}`
    : '';

  if (!engineReady()) {
    text.textContent =
      engine() === 'lightcraft'
        ? 'LightCraft est introuvable dans Applications. Installez-le ou choisissez HDRMerge.'
        : 'HDRMerge est introuvable. Installez HDRMerge.app dans Applications ou choisissez LightCraft.';
    text.className = 'warn';
    go.disabled = true;
    return;
  }
  text.className = '';
  if (state.busy) return;

  go.disabled = sel.length === 0;
  go.textContent = sel.length ? `Fusionner ${plural(sel.length, 'série', 'séries')}` : 'Fusionner';

  const done = [...state.status.values()];
  if (done.length && done.every((s) => ['done', 'skipped', 'error', 'cancelled'].includes(s.state))) {
    const count = (st) => done.filter((s) => s.state === st).length;
    const parts = [plural(count('done'), 'série fusionnée', 'séries fusionnées')];
    if (count('skipped')) parts.push(plural(count('skipped'), 'ignorée', 'ignorées'));
    if (count('cancelled')) parts.push(plural(count('cancelled'), 'arrêtée', 'arrêtées'));
    if (count('error')) parts.push(plural(count('error'), 'en échec', 'en échec'));
    text.textContent = parts.join(', ');
  } else {
    text.textContent = sel.length
      ? engine() === 'lightcraft'
        ? $('exportFormat').value === 'none'
          ? 'Chaque série produit un DNG HDR.'
          : `Chaque série produit un DNG HDR et une image ${$('exportFormat').value === 'tiff' ? 'TIFF' : 'JPEG'} développée.`
        : `Chaque série produit un DNG HDR de ${$('bits').querySelector('[aria-checked="true"]').dataset.v} bits.`
      : groups.length
        ? 'Aucune série sélectionnée.'
        : '';
  }
}

function updateTplPreview() {
  const g = groups.find((x) => !isSingle(x)) || groups[0];
  $('tplPreview').textContent = g ? outPath(g).split('/').slice(-2).join('/') : 'Jetons : {premier}, {dernier}, {n}';
}

/* ---------- adding files ---------- */

async function addPaths(paths) {
  if (!paths.length || state.busy) return;
  document.body.classList.add('scanning');
  const metas = await window.api.scan(paths);
  document.body.classList.remove('scanning');
  for (const m of metas) state.files.set(m.path, m);
  state.status.clear();
  render();
}

async function pick() {
  addPaths(await window.api.pick());
}

/* ---------- merging ---------- */

async function merge() {
  const sel = groups.filter(isSelected);
  if (!sel.length || state.busy) return;
  state.busy = true;
  document.body.classList.add('busy');
  state.status.clear();
  const jobs = sel.map((g) => ({
    id: g.key,
    files: g.files.map((f) => f.path),
    out: outPath(g),
    scene: (sceneOf(g.files) || {}).cls === 'day' ? 'day' : 'night',
  }));
  for (const j of jobs) state.status.set(j.id, { state: 'queued' });
  groups.forEach((g) => paintStatus(g.key));

  $('go').hidden = true;
  $('stop').hidden = false;
  $('overallTrack').hidden = false;
  paintOverall();

  const res = await window.api.merge({
    jobs,
    opts: {
      engine: engine(),
      develop: $('develop').checked,
      deghost: $('deghost').value,
      exportFormat: $('exportFormat').value,
      bits: Number($('bits').querySelector('[aria-checked="true"]').dataset.v),
      radius: Number($('radius').value),
      align: $('align').checked,
      keepSize: $('keepSize').checked,
      overwrite: $('overwrite').checked,
      parallel: Number($('parallel').value),
    },
  });

  for (const [k, s] of state.status) {
    if (s.state === 'queued') state.status.set(k, { state: 'cancelled' });
  }
  state.busy = false;
  document.body.classList.remove('busy');
  $('go').hidden = false;
  $('stop').hidden = true;
  $('overallTrack').hidden = true;
  groups.forEach((g) => paintStatus(g.key));
  updateFooter();
  if (res && res.error) {
    $('footText').textContent = res.error;
    $('footText').className = 'warn';
  }
}

function paintOverall() {
  const all = [...state.status.values()];
  const finished = all.filter((s) => !['queued', 'running'].includes(s.state)).length;
  const total = all.reduce((sum, s) => sum + (s.state === 'running' ? s.pct || 0 : s.state === 'queued' ? 0 : 100), 0);
  $('overallBar').style.width = `${all.length ? total / all.length : 0}%`;
  $('footText').textContent = `Fusion en cours, ${finished} sur ${all.length} terminées`;
}

window.api.onJob((m) => {
  const prev = state.status.get(m.id) || {};
  state.status.set(m.id, { ...prev, ...m });
  paintStatus(m.id);
  if (state.busy) paintOverall();
});

/* ---------- wiring ---------- */

$('add').addEventListener('click', pick);
$('add-empty').addEventListener('click', pick);
$('go').addEventListener('click', merge);
$('stop').addEventListener('click', () => window.api.cancel());
$('clear').addEventListener('click', () => {
  if (state.busy) return;
  state.files.clear();
  state.manualSplit.clear();
  state.manualJoin.clear();
  state.excluded.clear();
  state.status.clear();
  render();
});

$('gap').addEventListener('input', () => {
  $('gapOut').textContent = `${$('gap').value} s`;
  render();
});
$('radius').addEventListener('input', () => ($('radiusOut').textContent = `${$('radius').value} px`));
$('parallel').addEventListener('input', () => ($('parallelOut').textContent = $('parallel').value));
$('tpl').addEventListener('input', updateTplPreview);

$('engine').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  for (const x of $('engine').children) x.setAttribute('aria-checked', String(x === b));
  paintEngine();
  updateFooter();
});
$('exportFormat').addEventListener('change', updateFooter);

$('bits').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  for (const x of $('bits').children) x.setAttribute('aria-checked', String(x === b));
  updateFooter();
});

$('outMode').addEventListener('change', async () => {
  if ($('outMode').value === 'custom') {
    const dir = await window.api.chooseDir();
    if (dir) state.customDir = dir;
    else if (!state.customDir) $('outMode').value = 'sub';
  }
  const custom = $('outMode').value === 'custom';
  $('outDirLabel').hidden = !custom;
  $('outDirLabel').textContent = custom ? state.customDir : '';
  updateTplPreview();
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  if (!state.busy) $('drop').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  addPaths([...e.dataTransfer.files].map((f) => window.api.pathFor(f)).filter(Boolean));
});

window.api.env().then((env) => {
  state.hdrmerge = env.hdrmerge;
  state.lightcraft = env.lightcraft;
  if (!env.lightcraft && env.hdrmerge) {
    for (const x of $('engine').children) x.setAttribute('aria-checked', String(x.dataset.v === 'hdrmerge'));
  }
  paintEngine();
  render();
  if (env.initial && env.initial.length) addPaths(env.initial);
});
