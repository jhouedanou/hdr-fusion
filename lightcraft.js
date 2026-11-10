// Drives LightCraft over its JSON-lines control channel: merge a bracket, develop it
// with the Theta day or night settings, export the result.
// The app is started in a throwaway session (--memory), so the user's library is untouched.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const APP = '/Applications/LightCraft.app';
const BIN = `${APP}/Contents/MacOS/LightCraft`;

// Tuned on Theta Z1 brackets merged by LightCraft. Sharpening and noise reduction are off:
// denoising happens later, on an unsharpened image.
const COMMON = {
  detail: { sharpen_amount: 0, nr_luminance: 0, nr_color: 0 },
  optics: { remove_ca: true, defringe_purple_amount: 6 },
};
const LOOKS = {
  day: {
    light: { exposure: 0.55, contrast: 6, highlights: -90, shadows: 80, whites: 5, blacks: -5 },
    effects: { clarity: 6, texture: 10, dehaze: 5 },
    color: { vibrance: 12 },
  },
  night: {
    light: { exposure: 0.2, contrast: 5, highlights: -100, shadows: 50, whites: 0, blacks: -5 },
    effects: { clarity: 4, texture: 0, dehaze: 0 },
    color: { vibrance: 8 },
  },
};

const available = () => fs.existsSync(BIN);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

class Session {
  constructor() {
    this.child = null;
    this.port = 0;
    this.stopped = false;
  }

  async start() {
    this.port = await freePort();
    this.child = spawn(BIN, ['--memory', '--no-demo', '--control', String(this.port)], { stdio: 'ignore' });
    this.child.on('exit', () => (this.child = null));
    for (let i = 0; i < 60; i++) {
      if (this.stopped) throw new Error('Arrêté');
      if (!this.child) throw new Error("LightCraft s'est fermé au démarrage");
      try {
        await this.request('engine.execute', { command: 'library.info', params: {} }, 3000);
        await this.activate();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error('LightCraft ne répond pas sur son canal de contrôle');
  }

  request(method, params, timeout = 15 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port });
      let buf = '';
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        fn(v);
      };
      sock.setTimeout(timeout, () => finish(reject, new Error('LightCraft ne répond plus')));
      sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method, params }) + '\n'));
      sock.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          if (msg.ok) finish(resolve, msg.result);
          else finish(reject, new Error(msg.error || 'Commande refusée par LightCraft'));
        } catch (err) {
          finish(reject, err);
        }
      });
      sock.on('error', (err) => finish(reject, err));
      sock.on('close', () => finish(reject, new Error('Connexion à LightCraft interrompue')));
    });
  }

  // LightCraft answers control requests while drawing frames, and macOS stops drawing a
  // window that is fully covered. Bringing it to the front gets it going again.
  activate() {
    return new Promise((resolve) => {
      const p = spawn('/usr/bin/open', ['-a', APP], { stdio: 'ignore' });
      p.on('error', resolve);
      p.on('close', () => setTimeout(resolve, 800));
    });
  }

  async exec(command, params = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request('engine.execute', { command, params });
      } catch (err) {
        const stalled = /drew no frame|^timeout$/i.test(err.message);
        if (!stalled || attempt >= 3 || this.stopped) throw err;
        await this.activate();
      }
    }
  }

  async stop() {
    this.stopped = true;
    if (!this.child) return;
    const child = this.child;
    try {
      await this.request('engine.execute', { command: 'app.quit', params: {} }, 2000);
    } catch {
      /* already gone or busy: the kill below settles it */
    }
    setTimeout(() => child.kill('SIGTERM'), 1500).unref();
  }
}

function moveFile(from, to) {
  if (from === to) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from);
  }
}

// job: { id, files, out, scene }   opts: { align, deghost, develop, exportFormat, overwrite }
async function runJob(session, job, opts, send) {
  const step = (pct, msg) => send({ id: job.id, state: 'running', pct, msg });
  const outDir = path.dirname(job.out);
  const base = path.basename(job.out, path.extname(job.out));

  step(3, 'Import des vues');
  const imp = await session.exec('library.import', { paths: job.files, mode: 'add' });
  const ids = [...imp.imported, ...imp.duplicates.map((d) => d.existing)];
  if (ids.length < 2) throw new Error("LightCraft n'a pas pu lire les vues de cette série");

  step(10, 'Fusion HDR');
  const merged = await session.exec('merge.hdr', {
    ids,
    align: !!opts.align,
    deghost: opts.deghost || 'none',
    autoSettings: false,
    stack: false,
  });
  let dng = merged.path;
  let sidecar = null;

  try {
    if (opts.develop) {
      step(60, 'Développement');
      await session.exec('library.select', { ids: [merged.id] });
      const look = LOOKS[job.scene === 'day' ? 'day' : 'night'];
      await session.exec('develop.merge', { settings: { ...COMMON, ...look }, label: 'Theta HDR' });
      await session.exec('develop.wb', { mode: 'auto' });
      const saved = await session.exec('photo.saveMetadataToFile', { ids: [merged.id] });
      sidecar = [...saved.written, ...saved.merged][0] || null;
    }

    const files = [];
    if (opts.exportFormat && opts.exportFormat !== 'none') {
      step(75, 'Export');
      const params = {
        ids: [merged.id],
        dir: outDir,
        destinationMode: 'specificFolder',
        format: opts.exportFormat,
        naming: base,
        longEdge: 0,
        colorSpace: 'srgb',
        metadata: 'all',
        sharpen: 'none',
        conflict: opts.overwrite ? 'overwrite' : 'unique',
        background: false,
      };
      if (opts.exportFormat === 'tiff') Object.assign(params, { bitDepth: 16, tiffCompression: 'None' });
      if (opts.exportFormat === 'jpeg') params.quality = 95;
      fs.mkdirSync(outDir, { recursive: true });
      const res = await session.exec('app.export', params);
      files.push(...res.files.map((f) => f.path));
    }

    step(95, 'Rangement');
    moveFile(dng, job.out);
    dng = job.out;
    if (sidecar && fs.existsSync(sidecar)) {
      const target = path.join(outDir, `${base}.xmp`);
      moveFile(sidecar, target);
      sidecar = target;
    }
    send({ id: job.id, state: 'done', out: files[0] || job.out });
  } catch (err) {
    // Leave nothing half-made beside the sources.
    for (const f of [merged.path, sidecar]) {
      if (f && f !== job.out && fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
    throw err;
  }
}

module.exports = { available, Session, runJob, LOOKS, COMMON };
