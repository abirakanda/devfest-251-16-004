'use strict';

const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MAX_FILES = 30;
const MAX_BYTES = 50 * 1024 * 1024;
const FOOTER_H = 28; // points added below every page for the footer strip

const state = {
  lang: 'en',
  tender: null,
  reqs: [],          // sorted by order
  files: [],         // {id, name, size, pages, hash, bytes}
  match: {},         // reqId -> fileId
  expiry: {},        // reqId -> 'YYYY-MM-DD'
  fileMsgs: []       // {type, key, vars}
};
let nextId = 1;

const $ = (s) => document.querySelector(s);

// ---------- i18n ----------
function t(key, vars = {}) {
  let s = (I18N[state.lang] && I18N[state.lang][key]) || I18N.en[key] || key;
  for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(v);
  return s;
}
function setLang(lang) {
  state.lang = lang;
  try { localStorage.setItem('tpb-lang', lang); } catch (e) {}
  document.documentElement.lang = lang;
  document.body.classList.toggle('bn', lang === 'bn');
  $('#lang-en').classList.toggle('active', lang === 'en');
  $('#lang-bn').classList.toggle('active', lang === 'bn');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  renderAll();
}
function docTitle(r) {
  return state.lang === 'bn' ? (r.title_bn || r.title_en) : (r.title_en || r.title_bn);
}

// ---------- helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}
function toBool(v) { return v === true || v === 'true' || v === 1 || v === 'yes'; }
function normDate(s) {
  if (!s) return '';
  const m = String(s).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return String(s).trim();
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function sha256(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const fileById = (id) => state.files.find((f) => f.id === id);
const reqForFile = (fid) => Object.keys(state.match).find((rid) => state.match[rid] === fid);
const reqById = (rid) => state.reqs.find((r) => r.id === rid);

// ---------- Step 1: requirements.json ----------
$('#req-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const box = $('#req-msg');
  try {
    const data = JSON.parse(await f.text());
    if (!data || typeof data.tender !== 'object' || !Array.isArray(data.requirements)) {
      throw new Error('"tender" or "requirements" is missing');
    }
    const tender = { ...data.tender, submission_deadline: normDate(data.tender.submission_deadline) };
    const reqs = data.requirements.map((r, i) => ({
      id: String(r.id ?? 'R' + (i + 1)),
      order: Number(r.order),
      title_en: r.title_en || '',
      title_bn: r.title_bn || '',
      mandatory: toBool(r.mandatory),
      has_expiry: toBool(r.has_expiry),
      _i: i
    }));
    reqs.sort((a, b) => (a.order - b.order) || (a._i - b._i));
    state.tender = tender;
    state.reqs = reqs;
    state.match = {};
    state.expiry = {};
    box.className = 'msg ok';
    box.textContent = t('okJson', { n: reqs.length });
    box.hidden = false;
  } catch (err) {
    box.className = 'msg err';
    box.textContent = t('errJson', { err: err.message });
    box.hidden = false;
  }
  renderAll();
});

// ---------- Step 2: PDF upload ----------
$('#pdf-input').addEventListener('change', (e) => {
  addFiles(Array.from(e.target.files));
  e.target.value = '';
});
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  addFiles(Array.from(e.dataTransfer.files));
});

async function inspectPdf(bytes) {
  // returns {pages} or {error: key}
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024));
  if (!head.includes('%PDF-')) return { error: 'errFakePdf' };
  try {
    const task = pdfjsLib.getDocument({ data: bytes.slice(), password: '' });
    const doc = await task.promise;
    await doc.getPage(1);
    await doc.destroy();
  } catch (err) {
    if (err && err.name === 'PasswordException') return { error: 'errEncrypted' };
    return { error: 'errDamaged' };
  }
  try {
    const doc = await PDFDocument.load(bytes);
    const pages = doc.getPageCount();
    if (!pages) return { error: 'errDamaged' };
    return { pages };
  } catch (err) {
    if (err && /encrypt/i.test(err.message || '')) return { error: 'errEncrypted' };
    return { error: 'errDamaged' };
  }
}

async function addFiles(list) {
  state.fileMsgs = [];
  let added = 0;
  for (const f of list) {
    const isPdfName = /\.pdf$/i.test(f.name);
    if (!isPdfName && f.type !== 'application/pdf') {
      state.fileMsgs.push({ type: 'err', key: 'errNotPdf', vars: { name: f.name } });
      continue;
    }
    if (f.size === 0) { state.fileMsgs.push({ type: 'err', key: 'errEmpty', vars: { name: f.name } }); continue; }
    if (state.files.length >= MAX_FILES) { state.fileMsgs.push({ type: 'err', key: 'errTooMany', vars: { name: f.name } }); continue; }
    const total = state.files.reduce((s, x) => s + x.size, 0);
    if (total + f.size > MAX_BYTES) { state.fileMsgs.push({ type: 'err', key: 'errTooBig', vars: { name: f.name } }); continue; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const info = await inspectPdf(bytes);
    if (info.error) { state.fileMsgs.push({ type: 'err', key: info.error, vars: { name: f.name } }); continue; }
    const hash = await sha256(bytes);
    if (state.files.some((x) => x.hash === hash && x.name === f.name)) {
      state.fileMsgs.push({ type: 'warn', key: 'errSameFile', vars: { name: f.name } });
      continue;
    }
    state.files.push({ id: nextId++, name: f.name, size: f.size, pages: info.pages, hash, bytes });
    added++;
  }
  if (added) state.fileMsgs.unshift({ type: 'ok', key: 'okAdded', vars: { n: added } });
  renderAll();
}

function removeFile(id) {
  const rid = reqForFile(id);
  if (rid) delete state.match[rid];
  const f = fileById(id);
  if (f && f.url) URL.revokeObjectURL(f.url);
  state.files = state.files.filter((x) => x.id !== id);
  renderAll();
}

function viewFile(id) {
  const f = fileById(id);
  if (!f) return;
  if (!f.url) f.url = URL.createObjectURL(new Blob([f.bytes], { type: 'application/pdf' }));
  window.open(f.url, '_blank');
}

// duplicates: other files with the same hash
function dupsOf(f) { return state.files.filter((x) => x.id !== f.id && x.hash === f.hash); }

// Can file fid be matched to requirement rid?
function matchConflict(fid, rid) {
  const f = fileById(fid);
  for (const d of dupsOf(f)) {
    const other = reqForFile(d.id);
    if (other && other !== rid) return d;
  }
  return null;
}

function setMatch(rid, fid) {
  if (!fid) { delete state.match[rid]; renderAll(); return; }
  const conflict = matchConflict(fid, rid);
  if (conflict) { alert(t('dupBlock', { name: conflict.name })); renderAll(); return; }
  const prev = reqForFile(fid);
  if (prev && prev !== rid) delete state.match[prev]; // one file -> one document
  state.match[rid] = fid;
  renderAll();
}

// ---------- Status ----------
function statusOf(r) {
  const fid = state.match[r.id];
  if (!fid) return r.mandatory ? 'missing' : 'notprovided';
  if (r.has_expiry) {
    const exp = state.expiry[r.id];
    if (!exp) return 'expiryneeded';
    if (exp < state.tender.submission_deadline) return 'expired';
  }
  return 'ok';
}
const BLOCKING = new Set(['missing', 'expiryneeded', 'expired']);

// ---------- Auto-match ----------
function tokens(s) {
  return String(s).toLowerCase().replace(/\.pdf$/, '').split(/[^a-z0-9ঀ-৿]+/).filter((w) => w.length > 1);
}
const STOP = new Set(['of', 'and', 'the', 'certificate', 'letter', 'copy', 'doc', 'document', 'scan', 'final']);
function autoMatch() {
  const cands = [];
  for (const r of state.reqs) {
    if (state.match[r.id]) continue;
    const rt = new Set([...tokens(r.title_en), ...tokens(r.title_bn)].filter((w) => !STOP.has(w)));
    const idTok = r.id.toLowerCase();
    for (const f of state.files) {
      if (reqForFile(f.id)) continue;
      const ft = tokens(f.name);
      let score = 0;
      for (const w of ft) {
        if (STOP.has(w)) continue;
        if (rt.has(w)) score += 2;
        else if ([...rt].some((x) => x.length > 3 && (x.startsWith(w) || w.startsWith(x)))) score += 1;
      }
      if (ft.includes(idTok)) score += 3;
      if (score > 0) cands.push({ r, f, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  let n = 0;
  for (const c of cands) {
    if (state.match[c.r.id] || reqForFile(c.f.id)) continue;
    if (matchConflict(c.f.id, c.r.id)) continue;
    state.match[c.r.id] = c.f.id;
    n++;
  }
  renderAll();
  flash($('#summary'), t('autoDone', { n }));
}
$('#auto-match').addEventListener('click', autoMatch);
$('#clear-match').addEventListener('click', () => { state.match = {}; renderAll(); });

function flash(el, text) {
  const d = document.createElement('div');
  d.className = 'msg ok';
  d.textContent = text;
  el.after(d);
  setTimeout(() => d.remove(), 4000);
}

// ---------- CSV ----------
$('#export-csv').addEventListener('click', () => {
  const rows = [['Order', 'ID', 'Document', 'Document (Bangla)', 'Mandatory', 'File name', 'Pages', 'Expiry date', 'Status']];
  for (const r of state.reqs) {
    const f = fileById(state.match[r.id]);
    rows.push([r.order, r.id, r.title_en, r.title_bn, r.mandatory ? 'Yes' : 'No', f ? f.name : '', f ? f.pages : '',
      r.has_expiry ? (state.expiry[r.id] || '') : 'N/A', I18N.en['st_' + statusOf(r)]]);
  }
  const csv = rows.map((row) => row.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `${state.tender.tender_id}_Checklist.csv`);
});

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Render ----------
function renderAll() {
  const has = !!state.tender;
  $('#step2').hidden = !has;
  $('#step3').hidden = !has;
  $('#step4').hidden = !has;
  if (!has) return;
  renderTender();
  renderFiles();
  renderReqs();
  renderBlockers();
}

function renderTender() {
  const tn = state.tender;
  $('#tender-box').hidden = false;
  $('#t-id').textContent = tn.tender_id || '';
  $('#t-title').textContent = tn.title || '';
  $('#t-entity').textContent = tn.procuring_entity || '';
  $('#t-bidder').textContent = tn.bidder || '';
  $('#t-deadline').textContent = tn.submission_deadline || '';
}

function renderFiles() {
  $('#file-msgs').innerHTML = state.fileMsgs
    .map((m) => `<div class="msg ${m.type}">${esc(t(m.key, m.vars))}</div>`).join('');
  const tbl = $('#file-table');
  tbl.hidden = state.files.length === 0;
  tbl.querySelector('tbody').innerHTML = state.files.map((f) => {
    const dups = dupsOf(f);
    const rid = reqForFile(f.id);
    const r = rid && reqById(rid);
    return `<tr class="${dups.length ? 'dup-row' : ''}">
      <td><span class="fname">${esc(f.name)}</span>
        ${dups.length ? `<span class="badge dup">${esc(t('duplicate'))}</span>
        <div class="small">${esc(t('dupOf', { names: dups.map((d) => d.name).join(', ') }))}</div>` : ''}</td>
      <td>${f.pages}</td>
      <td>${fmtSize(f.size)}</td>
      <td>${r ? esc(docTitle(r)) : `<span class="muted">${esc(t('notMatched'))}</span>`}</td>
      <td class="nowrap"><button class="btn sm" data-view="${f.id}">${esc(t('view'))}</button>
        <button class="btn sm danger" data-remove="${f.id}">${esc(t('remove'))}</button></td>
    </tr>`;
  }).join('');
}

function renderReqs() {
  const tbody = $('#req-table tbody');
  tbody.innerHTML = state.reqs.map((r) => {
    const st = statusOf(r);
    const fid = state.match[r.id];
    const opts = [`<option value="">${esc(t('noFile'))}</option>`].concat(state.files.map((f) => {
      const used = reqForFile(f.id);
      const conflict = matchConflict(f.id, r.id);
      const label = f.name + (used && used !== r.id ? ' (→ ' + docTitle(reqById(used)) + ')' : '') +
        (conflict ? ' [' + t('duplicate') + ']' : '');
      return `<option value="${f.id}" ${f.id === fid ? 'selected' : ''} ${conflict ? 'disabled' : ''}>${esc(label)}</option>`;
    })).join('');
    const expCell = r.has_expiry
      ? `<input type="date" class="date" data-exp="${esc(r.id)}" value="${esc(state.expiry[r.id] || '')}" ${fid ? '' : 'disabled'}>`
      : `<span class="muted">${esc(t('notNeeded'))}</span>`;
    return `<tr class="st-${st}">
      <td>${esc(r.order)}</td>
      <td><strong>${esc(docTitle(r))}</strong><div class="small muted">${esc(r.id)}</div></td>
      <td><span class="badge ${r.mandatory ? 'mand' : 'opt'}">${esc(t(r.mandatory ? 'mandatory' : 'optional'))}</span></td>
      <td><select data-req="${esc(r.id)}">${opts}</select></td>
      <td>${expCell}</td>
      <td><span class="status s-${st}">${esc(t('st_' + st))}</span></td>
    </tr>`;
  }).join('');

  let ok = 0, bad = 0, np = 0;
  for (const r of state.reqs) {
    const s = statusOf(r);
    if (s === 'ok') ok++; else if (s === 'notprovided') np++; else bad++;
  }
  $('#summary').innerHTML = `<span>${esc(t('summary', { ok, bad, np }))}</span>`;
}

function renderBlockers() {
  const list = [];
  for (const r of state.reqs) {
    const s = statusOf(r);
    if (BLOCKING.has(s)) {
      list.push(t('blk_' + s, { doc: docTitle(r), date: state.expiry[r.id] || '', deadline: state.tender.submission_deadline }));
    }
  }
  const box = $('#blockers');
  if (list.length) {
    box.innerHTML = `<div class="msg err"><strong>${esc(t('blockersTitle'))}</strong><ul>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  } else {
    box.innerHTML = `<div class="msg ok"><strong>${esc(t('readyTitle'))}</strong></div>`;
  }
  $('#generate').disabled = list.length > 0;
}

// delegated events
document.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) return removeFile(Number(rm.dataset.remove));
  const vw = e.target.closest('[data-view]');
  if (vw) return viewFile(Number(vw.dataset.view));
});
document.addEventListener('change', (e) => {
  if (e.target.matches('select[data-req]')) setMatch(e.target.dataset.req, Number(e.target.value) || null);
  if (e.target.matches('input[data-exp]')) {
    const v = normDate(e.target.value);
    if (v) state.expiry[e.target.dataset.exp] = v; else delete state.expiry[e.target.dataset.exp];
    renderAll();
  }
});

// ---------- Package generation ----------
function ascii(s) {
  // Standard PDF fonts only support Latin characters
  return String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

function wrap(text, font, size, maxW) {
  const words = ascii(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function drawFooter(page, font, tenderId, n, total) {
  const { width } = page.getSize();
  const text = ascii(`${tenderId} | Page ${n} of ${total}`);
  const size = 10;
  const tw = font.widthOfTextAtSize(text, size);
  page.drawRectangle({ x: 0, y: 0, width, height: FOOTER_H, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: 24, y: FOOTER_H - 2 }, end: { x: width - 24, y: FOOTER_H - 2 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  page.drawText(text, { x: (width - tw) / 2, y: 9, size, font, color: rgb(0.1, 0.1, 0.1) });
}

async function buildPackage(withIndex) {
  const tn = state.tender;
  const out = await PDFDocument.create();
  out.setTitle(ascii(`${tn.tender_id} Tender Package`));
  out.setProducer('Tender Document Package Builder');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  const included = state.reqs.filter((r) => state.match[r.id]).map((r) => ({ r, f: fileById(state.match[r.id]) }));
  const front = 1 + (withIndex ? 1 : 0);
  let start = front + 1;
  for (const it of included) { it.start = start; start += it.f.pages; }
  const total = start - 1;

  const W = 595.28, H = 841.89, M = 56; // A4
  // Cover page
  const cover = out.addPage([W, H]);
  let y = H - M;
  cover.drawRectangle({ x: 0, y: H - 110, width: W, height: 110, color: rgb(0.06, 0.32, 0.43) });
  cover.drawText('TENDER SUBMISSION PACKAGE', { x: M, y: H - 60, size: 20, font: bold, color: rgb(1, 1, 1) });
  cover.drawText(ascii(tn.tender_id), { x: M, y: H - 86, size: 13, font, color: rgb(0.85, 0.93, 0.97) });
  y = H - 145;
  const fields = [
    ['Tender ID', tn.tender_id], ['Tender title', tn.title], ['Procuring entity', tn.procuring_entity],
    ['Bidder', tn.bidder], ['Submission deadline', tn.submission_deadline], ['Package created on', todayISO()]
  ];
  for (const [k, v] of fields) {
    cover.drawText(k + ':', { x: M, y, size: 11, font: bold, color: rgb(0.2, 0.2, 0.2) });
    const lines = wrap(v, font, 11, W - M - 200);
    for (const ln of lines) { cover.drawText(ln, { x: 200, y, size: 11, font }); y -= 16; }
    y -= 4;
  }
  y -= 10;
  cover.drawText('Included documents (in order)', { x: M, y, size: 13, font: bold, color: rgb(0.06, 0.32, 0.43) });
  y -= 8;
  cover.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: rgb(0.06, 0.32, 0.43) });
  y -= 18;
  const avail = y - (FOOTER_H + 20);
  const lh = Math.max(9, Math.min(17, avail / Math.max(1, included.length)));
  const fs = Math.min(11, lh - 4);
  included.forEach((it, i) => {
    const label = `${i + 1}. ${it.r.title_en}`;
    const line = wrap(label, font, fs, W - 2 * M - 90)[0];
    cover.drawText(line, { x: M, y, size: fs, font });
    const pg = `${it.f.pages} page${it.f.pages > 1 ? 's' : ''}`;
    cover.drawText(pg, { x: W - M - font.widthOfTextAtSize(pg, fs), y, size: fs, font, color: rgb(0.35, 0.35, 0.35) });
    y -= lh;
  });

  // Index page (bonus)
  if (withIndex) {
    const idx = out.addPage([W, H]);
    let iy = H - M;
    idx.drawText('Index', { x: M, y: iy, size: 20, font: bold, color: rgb(0.06, 0.32, 0.43) });
    iy -= 30;
    idx.drawText('Document', { x: M, y: iy, size: 11, font: bold });
    idx.drawText('Pages', { x: W - M - 150, y: iy, size: 11, font: bold });
    idx.drawText('Starts on page', { x: W - M - 80, y: iy, size: 11, font: bold });
    iy -= 6;
    idx.drawLine({ start: { x: M, y: iy }, end: { x: W - M, y: iy }, thickness: 0.8 });
    iy -= 16;
    const ilh = Math.max(9, Math.min(18, (iy - FOOTER_H - 20) / Math.max(1, included.length)));
    const ifs = Math.min(11, ilh - 4);
    included.forEach((it, i) => {
      const line = wrap(`${i + 1}. ${it.r.title_en}`, font, ifs, W - 2 * M - 170)[0];
      idx.drawText(line, { x: M, y: iy, size: ifs, font });
      idx.drawText(String(it.f.pages), { x: W - M - 150, y: iy, size: ifs, font });
      const sp = String(it.start);
      idx.drawText(sp, { x: W - M - font.widthOfTextAtSize(sp, ifs), y: iy, size: ifs, font: bold });
      iy -= ilh;
    });
  }

  // Document pages: each original page is placed above a footer strip so the footer never covers content
  for (const it of included) {
    const src = await PDFDocument.load(it.f.bytes);
    const indices = src.getPageIndices();
    const embedded = await out.embedPdf(src, indices);
    indices.forEach((pi, k) => {
      const ep = embedded[k];
      const rot = ((src.getPage(pi).getRotation().angle % 360) + 360) % 360;
      const w = ep.width, h = ep.height;
      const sideways = rot === 90 || rot === 270;
      const pw = sideways ? h : w, ph = (sideways ? w : h) + FOOTER_H;
      const page = out.addPage([pw, ph]);
      if (rot === 90) page.drawPage(ep, { x: 0, y: FOOTER_H + w, rotate: degrees(-90) });
      else if (rot === 180) page.drawPage(ep, { x: w, y: FOOTER_H + h, rotate: degrees(180) });
      else if (rot === 270) page.drawPage(ep, { x: h, y: FOOTER_H, rotate: degrees(90) });
      else page.drawPage(ep, { x: 0, y: FOOTER_H });
    });
  }

  const pages = out.getPages();
  pages.forEach((p, i) => drawFooter(p, font, tn.tender_id, i + 1, pages.length));
  if (pages.length !== total) console.warn('page count mismatch', pages.length, total);
  return { bytes: await out.save(), pages: pages.length };
}

$('#generate').addEventListener('click', async () => {
  const btn = $('#generate');
  const msg = $('#gen-msg');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = t('generating');
  msg.hidden = false;
  try {
    const { bytes, pages } = await buildPackage($('#opt-index').checked);
    const name = `${state.tender.tender_id}_Package.pdf`;
    download(new Blob([bytes], { type: 'application/pdf' }), name);
    msg.className = 'msg ok';
    msg.textContent = t('genDone', { file: name, n: pages });
  } catch (err) {
    console.error(err);
    msg.className = 'msg err';
    msg.textContent = t('genFail', { err: err.message });
  }
  renderBlockers();
});

// ---------- init ----------
$('#lang-en').addEventListener('click', () => setLang('en'));
$('#lang-bn').addEventListener('click', () => setLang('bn'));
let saved = 'en';
try { saved = localStorage.getItem('tpb-lang') || 'en'; } catch (e) {}
setLang(saved === 'bn' ? 'bn' : 'en');
