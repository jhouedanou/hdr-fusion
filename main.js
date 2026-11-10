const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const exifr = require('exifr');

const RAW_EXT = new Set(['.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.pef', '.srw']);
const HDRMERGE_CANDIDATES = [
  '/Applications/HDRMerge.app/Contents/MacOS/hdrmerge',
  '/opt/homebrew/bin/hdrmerge',
  '/usr/local/bin/hdrmerge',
];

const lightcraft = require('./lightcraft');

let win;
let lcSession = null;
let cancelled = false;
const running = new Set();

function findHdrmerge() {
  return HDRMERGE_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#20252b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  killAll();
  app.quit();
});

function killAll() {
  cancelled = true;
  for (const child of running) child.kill('SIGTERM');
  if (lcSession) lcSession.stop();
}

// A file that is itself a merge result must not be fed back into a bracket.
const isMergeOutput = (name) => /[-_]HDR\.[a-z0-9]+$/i.test(name);

async function expand(paths, depth = 0) {
  const out = [];
  for (const p of paths) {
    let st;
    try {
      st = await fsp.stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (depth > 3) continue;
      const names = (await fsp.readdir(p)).filter((n) => !n.startsWith('.'));
      out.push(...(await expand(names.map((n) => path.join(p, n)), depth + 1)));
    } else if (RAW_EXT.has(path.extname(p).toLowerCase()) && !isMergeOutput(path.basename(p))) {
      out.push(p);
    }
  }
  return out;
}

async function readMeta(file) {
  let d = null;
  try {
    d = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ExposureTime', 'FNumber', 'ISO', 'Model'],
    });
  } catch {
    /* unreadable EXIF: the file is still listed, just ungrouped */
  }
  const date = d && (d.DateTimeOriginal || d.CreateDate);
  let time = date instanceof Date && !isNaN(date) ? date.getTime() : null;
  if (time === null) {
    try {
      time = (await fsp.stat(file)).mtimeMs;
    } catch {
      time = 0;
    }
  }
  return {
    path: file,
    name: path.basename(file),
    dir: path.dirname(file),
    time,
    exp: (d && d.ExposureTime) || null,
    fnum: (d && d.FNumber) || null,
    iso: (d && d.ISO) || null,
    model: (d && d.Model) || '',
  };
}

// Paths given on the command line (npm start -- /dossier) are loaded at launch.
ipcMain.handle('env', () => ({
  hdrmerge: findHdrmerge(),
  lightcraft: lightcraft.available(),
  initial: process.argv.slice(2).filter((a) => !a.startsWith('-') && fs.existsSync(a)),
}));

ipcMain.handle('pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Ajouter des images RAW ou des dossiers',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('chooseDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Dossier de sortie',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('scan', async (_e, paths) => {
  const files = [...new Set(await expand(paths))];
  const metas = [];
  for (let i = 0; i < files.length; i += 16) {
    metas.push(...(await Promise.all(files.slice(i, i + 16).map(readMeta))));
  }
  return metas;
});

ipcMain.handle('thumb', async (_e, file) => {
  // Electron's Quick Look thumbnails come back blank for DNG, so sips decodes the raw.
  // Results are cached on disk, keyed by path and modification time.
  const read = (p) => {
    try {
      const buf = fs.readFileSync(p);
      return buf.length ? 'data:image/jpeg;base64,' + buf.toString('base64') : null;
    } catch {
      return null;
    }
  };
  let key;
  try {
    const st = await fsp.stat(file);
    key = crypto.createHash('sha1').update(`${file}:${st.mtimeMs}:${st.size}`).digest('hex');
  } catch {
    return null;
  }
  const dir = path.join(app.getPath('userData'), 'thumbs');
  const cached = path.join(dir, `${key}.jpg`);
  const hit = read(cached);
  if (hit) return hit;
  await fsp.mkdir(dir, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '192', file, '--out', cached]);
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(read(cached)));
  });
});

ipcMain.handle('reveal', (_e, p) => {
  if (fs.existsSync(p)) shell.showItemInFolder(p);
  else shell.openPath(path.dirname(p));
});

ipcMain.handle('cancel', () => killAll());

function runJob(bin, job, opts, send) {
  return new Promise((resolve) => {
    if (fs.existsSync(job.out) && !opts.overwrite) {
      send({ id: job.id, state: 'skipped', msg: 'Le fichier existe déjà' });
      return resolve();
    }
    try {
      fs.mkdirSync(path.dirname(job.out), { recursive: true });
    } catch (err) {
      send({ id: job.id, state: 'error', msg: `Dossier de sortie inaccessible : ${err.message}` });
      return resolve();
    }

    const args = ['-v', '-o', job.out, '-b', String(opts.bits), '-r', String(opts.radius), '-p', 'none'];
    if (!opts.align) args.push('--no-align');
    if (opts.keepSize) args.push('--no-crop');
    args.push(...job.files);

    send({ id: job.id, state: 'running', pct: 0, msg: 'Démarrage' });
    const child = spawn(bin, args);
    running.add(child);

    let writing = false;
    let tail = [];
    const onData = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line.trim());
        if (tail.length > 6) tail.shift();
        if (/^Writing/.test(line)) writing = true;
        const m = line.match(/^\[\s*(\d+)%\]\s*(.*)$/);
        if (m) {
          const p = Number(m[1]);
          // Loading fills the first half of the bar, rendering and writing the second.
          const pct = writing ? 50 + p / 2 : p / 2;
          send({ id: job.id, state: 'running', pct, msg: m[2] });
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      running.delete(child);
      send({ id: job.id, state: 'error', msg: err.message });
      resolve();
    });
    child.on('close', (code) => {
      running.delete(child);
      const ok = code === 0 && fs.existsSync(job.out) && fs.statSync(job.out).size > 0;
      if (ok) {
        send({ id: job.id, state: 'done', out: job.out });
      } else {
        if (fs.existsSync(job.out)) fs.rmSync(job.out, { force: true });
        send({
          id: job.id,
          state: cancelled ? 'cancelled' : 'error',
          msg: cancelled ? 'Arrêté' : tail.slice(-2).join(' / ') || `HDRMerge a quitté avec le code ${code}`,
        });
      }
      resolve();
    });
  });
}

async function mergeWithLightcraft(jobs, opts, send) {
  if (!lightcraft.available()) return { error: 'LightCraft introuvable dans Applications' };
  cancelled = false;
  lcSession = new lightcraft.Session();
  try {
    send({ id: jobs[0].id, state: 'running', pct: 0, msg: 'Démarrage de LightCraft' });
    await lcSession.start();
    for (const job of jobs) {
      if (cancelled) break;
      if (fs.existsSync(job.out) && !opts.overwrite) {
        send({ id: job.id, state: 'skipped', msg: 'Le fichier existe déjà' });
        continue;
      }
      try {
        await lightcraft.runJob(lcSession, job, opts, send);
      } catch (err) {
        send({ id: job.id, state: cancelled ? 'cancelled' : 'error', msg: cancelled ? 'Arrêté' : err.message });
      }
    }
  } catch (err) {
    if (!cancelled) return { error: err.message };
  } finally {
    await lcSession.stop();
    lcSession = null;
  }
  return { cancelled };
}

ipcMain.handle('merge', async (_e, { jobs, opts }) => {
  const sendJob = (m) => win && !win.isDestroyed() && win.webContents.send('job', m);
  if (opts.engine === 'lightcraft') return mergeWithLightcraft(jobs, opts, sendJob);
  const bin = findHdrmerge();
  if (!bin) return { error: 'HDRMerge introuvable' };
  cancelled = false;
  const send = (m) => win && !win.isDestroyed() && win.webContents.send('job', m);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !cancelled) {
      await runJob(bin, jobs[next++], opts, send);
    }
  };
  const n = Math.max(1, Math.min(3, opts.parallel || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return { cancelled };
});
