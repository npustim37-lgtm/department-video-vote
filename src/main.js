import { createClient } from '@supabase/supabase-js';
import readXlsxFile from 'read-excel-file';
import writeExcelFile from 'write-excel-file/browser';
import { buildExportTables, buildVoteReport, optionCode } from './vote-report.js';
import { votingPhase } from './voting-window.js';
import './style.css';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = Boolean(url && key && !url.includes('YOUR_PROJECT'));
const supabase = configured ? createClient(url, key) : null;
const state = { user: null, profile: null, options: [], votes: [], users: [], settings: { mode: 'open', opens_at: null, closes_at: null }, settingsReady: false, workSchemaReady: false };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const normalizeUsername = (value) => String(value ?? '').trim().normalize('NFC').toLowerCase();
const validName = (value) => {
  const name = String(value ?? '').trim();
  return name.length >= 1 && name.length <= 80 && !/[\p{Cc}@]/u.test(name);
};
const votingOpen = () => votingPhase(state.settings) === 'open';
const taipeiTime = (value) => new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date(value));
const validVideoUrl = (value) => {
  try {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && parsed.hostname && value.length <= 2000;
  } catch { return false; }
};
const validWorkCode = (value) => value.length >= 1 && value.length <= 30 && value === value.trim();
const toLocalInput = (value) => value ? new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T').slice(0, 16) : '';
let selectedOptionId = null;
let bulkDeleteRunning = false;

let toastTimer;
function toast(message, type = '') {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = 'toast'; }, 5500);
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = busy;
}

function openLogin() {
  if (!configured) return toast('請先完成 Supabase 設定，詳見 README。', 'error');
  if (state.user) return document.querySelector('#works').scrollIntoView();
  $('#login-dialog').showModal();
}

async function voterEmail(username) {
  const bytes = new TextEncoder().encode(normalizeUsername(username));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `u-${hex}@accounts.example.com`;
}

async function fetchAll(table, columns, apply = (query) => query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await apply(supabase.from(table).select(columns)).range(offset, offset + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

async function refresh() {
  if (!configured) {
    $('#work-count').textContent = '尚未設定資料庫';
    $('#works-grid').innerHTML = '<div class="error-state"><strong>網站尚未完成連線設定</strong>請依 README 設定 Supabase 專案與 GitHub Pages 環境變數。</div>';
    return;
  }
  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (state.user?.id !== user?.id) selectedOptionId = null;
    state.user = authError ? null : user;
    state.profile = null;
    if (state.user) {
      const { data, error } = await supabase.from('profiles').select('id,name,username,role').eq('id', state.user.id).single();
      if (error) throw error;
      state.profile = data;
    }
    const [{ data: options, error: optionsError }, { data: settings, error: settingsError }] = await Promise.all([
      supabase.from('options').select('*').order('created_at', { ascending: false }),
      supabase.from('voting_settings').select('*').eq('id', 1).single(),
    ]);
    if (optionsError) throw optionsError;
    const settingsMissing = settingsError && ['PGRST205', '42P01'].includes(settingsError.code);
    if (settingsError && !settingsMissing) throw settingsError;
    state.options = options;
    state.settings = { mode: settings?.mode || 'open', opens_at: settings?.opens_at ?? null, closes_at: settings?.closes_at ?? null };
    state.settingsReady = Boolean(settings && 'mode' in settings && 'opens_at' in settings);
    state.workSchemaReady = Boolean(options.length && 'code' in options[0] && 'enabled' in options[0]);
    if (state.profile?.role === 'admin' && !state.workSchemaReady) {
      const { error } = await supabase.from('options').select('code,enabled').limit(0);
      state.workSchemaReady = !error;
    }
    state.votes = [];
    state.users = [];
    if (state.profile?.role === 'voter') {
      state.votes = await fetchAll('votes', 'user_id,option_id', (query) => query.eq('user_id', state.user.id).order('user_id'));
    } else if (state.profile?.role === 'admin') {
      [state.votes, state.users] = await Promise.all([
        fetchAll('votes', 'user_id,option_id,created_at', (query) => query.order('user_id')),
        fetchAll('profiles', 'id,name,username,role', (query) => query.eq('role', 'voter').order('id')),
      ]);
    }
    render();
    syncRealtime();
  } catch (error) {
    console.error(error);
    $('#work-count').textContent = '載入失敗';
    $('#works-grid').innerHTML = '<div class="error-state"><strong>暫時無法載入作品</strong>請確認網路及 Supabase 設定後重新整理。</div>';
    toast(`資料載入失敗：${error.message}`, 'error');
  }
}

function render() {
  const profile = state.profile;
  $('#user-label').hidden = !profile;
  $('#user-label').textContent = profile ? `你好，${profile.name}` : '';
  $('#login-button').hidden = Boolean(profile);
  $('#logout-button').hidden = !profile;
  $('#nav-admin').hidden = profile?.role !== 'admin';
  $('#admin').hidden = profile?.role !== 'admin';
  if (profile?.role !== 'admin') $('#admin-password-form').reset();
  $('#closing-login').textContent = profile ? '返回作品 ↑' : '前往登入 ↗';
  renderVotingStatus();
  renderWorks();
  if (profile?.role === 'admin') renderAdmin();
}

function renderWorks() {
  const available = state.options.filter((option) => option.enabled !== false);
  $('#work-count').textContent = `共 ${available.length} 部作品`;
  const selectedId = state.profile?.role === 'voter' ? state.votes[0]?.option_id : null;
  const canVote = state.profile?.role === 'voter' && !selectedId && votingOpen();
  if (!available.some((option) => option.id === selectedOptionId)) selectedOptionId = null;
  $('#ballot-actions').hidden = !canVote || !available.length;
  $('#submit-vote').disabled = !selectedOptionId;
  if (!available.length) {
    $('#works-grid').innerHTML = '<div class="empty-state"><strong>作品即將登場</strong>主辦單位尚未發布投票選項，請稍後再來。</div>';
    return;
  }
  $('#works-grid').innerHTML = available.map((option) => {
    const safeUrl = validVideoUrl(option.video_url) ? option.video_url : '#';
    const linkLabel = safeUrl === '#' ? '無效的影片連結' : safeUrl;
    const selected = selectedId === option.id;
    return `<article class="work-card ${selected ? 'selected' : ''}">
      <div class="work-visual"><span class="work-number">${escapeHtml(option.code || optionCode(option.id))}</span><span class="work-play"></span>${selected ? '<span class="selected-tag">你的選擇</span>' : ''}</div>
      <div class="work-body"><span class="work-type">FEATURE FILM / 參賽作品</span><h3 class="work-title">${escapeHtml(option.title)}</h3><span class="work-domain" title="${escapeHtml(linkLabel)}">${escapeHtml(linkLabel)}</span>
      <div class="work-actions"><a class="watch-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" ${safeUrl === '#' ? 'aria-disabled="true"' : ''}>觀看影片 ↗</a>${canVote ? `<label class="ballot-choice"><input type="radio" name="ballot" value="${option.id}" ${selectedOptionId === option.id ? 'checked' : ''} /> 選擇此作品</label>` : selected ? '<span class="voted-label">✓ 已投給這部</span>' : ''}</div></div></article>`;
  }).join('');
}

async function authPassword(password) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`department-video-vote-v1:${password}`));
  return `Aa1!${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function renderVotingStatus() {
  const phase = votingPhase(state.settings);
  const { opens_at: opensAt, closes_at: closesAt } = state.settings;
  $('#voting-status').textContent = phase === 'closed' ? '投票已關閉' : phase === 'upcoming'
    ? `投票尚未開始｜開放時間：${taipeiTime(opensAt)}（台灣時間）`
      : phase === 'ended' ? '投票已截止' : closesAt
        ? `投票進行中｜截止時間：${taipeiTime(closesAt)}（台灣時間）` : '投票進行中';
}

function syncScheduleInputs() {
  const mode = $('#voting-mode').value;
  $('#opens-at').disabled = !state.settingsReady || mode !== 'scheduled';
  $('#opens-at').required = mode === 'scheduled';
  $('#closes-at').disabled = !state.settingsReady || mode === 'closed';
  $('#closes-at').required = mode === 'scheduled';
}

function renderAdmin() {
  const report = buildVoteReport(state.options, state.votes, state.users);
  $('#stat-users').textContent = report.totalVoters;
  $('#stat-votes').textContent = report.votedAccounts;
  $('#stat-remaining').textContent = report.remaining;
  $('#stat-turnout').textContent = `${report.turnout.toFixed(2)}%`;
  $('#stats-updated').textContent = `資料更新：${taipeiTime(new Date().toISOString())}（台灣時間）；投票變更會自動更新。`;
  $('#delete-all-users').disabled = bulkDeleteRunning || state.users.length === 0;
  $('#schedule-note').hidden = state.settingsReady;
  for (const control of $('#schedule-form').querySelectorAll('input, select, button')) control.disabled = !state.settingsReady;
  if (!$('#schedule-form').dataset.dirty) {
    $('#voting-mode').value = state.settings.mode;
    $('#opens-at').value = toLocalInput(state.settings.opens_at);
    $('#closes-at').value = toLocalInput(state.settings.closes_at);
  }
  syncScheduleInputs();
  $('#options-note').hidden = state.workSchemaReady;
  for (const control of $('#options-form').querySelectorAll('input, button')) control.disabled = !state.workSchemaReady;
  renderUsers();
  $('#options-list').innerHTML = report.results.length ? report.results.map((option) => {
    return `<div class="list-item"><div class="list-primary"><strong>${escapeHtml(option.code)}｜${escapeHtml(option.title)}</strong><small>${option.enabled ? '開放投票' : '未開放投票'} · ${escapeHtml(option.videoUrl)}</small></div><div class="list-actions"><span class="vote-count">${option.votes} 票｜${option.percent.toFixed(2)}%</span><button class="icon-button" type="button" data-edit-work="${option.id}" ${!state.workSchemaReady ? 'disabled' : ''}>修改</button><button class="icon-button danger" type="button" data-delete-work="${option.id}" ${!state.workSchemaReady ? 'disabled' : ''}>刪除</button></div></div>`;
  }).join('') : '<div class="small-empty">尚未新增作品。</div>';
  renderRecords();
}

function renderUsers() {
  const search = $('#user-search').value.trim().toLowerCase();
  const filtered = state.users.filter((user) => `${user.name} ${user.username}`.toLowerCase().includes(search));
  const voted = new Set(state.votes.map((vote) => vote.user_id));
  $('#users-list').innerHTML = filtered.length ? filtered.map((user) => `<div class="list-item"><div class="list-primary"><strong>${escapeHtml(user.name)}</strong><small>${user.username === normalizeUsername(user.name) ? '姓名登入' : `舊帳號：${escapeHtml(user.username)}`} · ${voted.has(user.id) ? '已投票' : '尚未投票'}</small></div><div class="list-actions"><button class="icon-button" type="button" data-edit="${user.id}">修改</button><button class="icon-button danger" type="button" data-delete="${user.id}">刪除</button></div></div>`).join('') : '<div class="small-empty">沒有符合的使用者。</div>';
  $('#sync-names').hidden = !state.users.some((user) => user.username !== normalizeUsername(user.name));
}

function sortedRecords() {
  return buildVoteReport(state.options, state.votes, state.users).records.map((record) => ({
    ...record, time: taipeiTime(record.createdAt),
  }));
}

function renderRecords() {
  const records = sortedRecords();
  $('#records-list').innerHTML = records.length ? records.map((record) => `<div class="list-item"><div class="list-primary"><strong>${escapeHtml(record.account)}｜${escapeHtml(record.code)} ${escapeHtml(record.title)}</strong><small>${escapeHtml(record.time)}（台灣時間）</small></div></div>`).join('') : '<div class="small-empty">尚無投票紀錄。</div>';
}

function addUserRow() {
  const row = document.createElement('div');
  row.className = 'form-row user-form-row';
  row.innerHTML = '<input name="name" placeholder="姓名" maxlength="80" aria-label="姓名／登入帳號" autocomplete="off" /><input name="password" type="password" placeholder="密碼" aria-label="密碼" autocomplete="new-password" /><button class="remove-row" type="button" aria-label="移除此列">×</button>';
  $('#manual-user-rows').append(row);
  $('#create-users-button').disabled = false;
}

function addOptionRow() {
  const row = document.createElement('div');
  row.className = 'form-row option-form-row';
  row.innerHTML = '<input name="code" placeholder="作品01" maxlength="30" aria-label="作品編號" /><input name="title" placeholder="作品名稱" maxlength="150" aria-label="作品名稱" /><input name="video_url" type="url" placeholder="https://..." aria-label="影片連結" /><label class="row-check"><input name="enabled" type="checkbox" checked aria-label="開放此作品供投票" /></label><button class="remove-row" type="button" aria-label="移除此列">×</button>';
  $('#option-rows').append(row);
}

function validateUsers(rows) {
  if (!rows.length || rows.length > 2000) throw new Error('每次請提供 1 至 2,000 位使用者。');
  return rows.map((row, index) => {
    const name = String(row.name ?? '').trim();
    const username = normalizeUsername(name);
    const password = String(row.password ?? '');
    if (!validName(name) || !validName(username) || !password || password.length > 72) {
      throw new Error(`第 ${index + 1} 筆資料格式不正確。姓名與密碼不可空白，密碼最多 72 字元。`);
    }
    return { name, username, password };
  });
}

async function functionCall(body) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    let message = error.message;
    try { message = (await error.context.json()).error || message; } catch { /* response unavailable */ }
    throw new Error(message);
  }
  if (!data?.ok) throw new Error(data?.error || '管理功能執行失敗。');
  return data;
}

async function createUsers(rows) {
  const validated = validateUsers(rows);
  const seen = new Set();
  const unique = validated.filter((row) => {
    if (seen.has(row.username)) return false;
    seen.add(row.username);
    return true;
  });
  let added = 0;
  let skipped = validated.length - unique.length;
  const errors = [];
  for (let offset = 0; offset < unique.length; offset += 20) {
    const chunk = unique.slice(offset, offset + 20);
    const result = await functionCall({ action: 'create_users', users: chunk });
    added += result.added || 0;
    skipped += result.skipped || 0;
    errors.push(...(result.errors || []));
    toast(`匯入進度：${Math.min(offset + 20, unique.length)} / ${unique.length}`);
  }
  await refresh();
  toast(`完成：新增 ${added} 位、略過 ${skipped} 位${errors.length ? `；失敗 ${errors.length} 位：${errors.slice(0, 3).join('、')}` : ''}。`, errors.length ? 'error' : 'success');
}

function manualRows() {
  return [...document.querySelectorAll('#manual-user-rows .form-row')].map((row) => ({
    name: row.querySelector('[name="name"]').value,
    password: row.querySelector('[name="password"]').value,
  })).filter((row) => row.name || row.password);
}

async function excelRows(file) {
  if (!file || !file.name.toLowerCase().endsWith('.xlsx')) throw new Error('請選擇 .xlsx Excel 檔。');
  if (file.size > 5 * 1024 * 1024) throw new Error('Excel 檔案不可超過 5 MB。');
  const sheet = await readXlsxFile(file);
  if (!sheet.length) throw new Error('Excel 沒有資料。');
  const names = sheet[0].map((value) => String(value ?? '').trim().toLowerCase());
  const aliases = { name: ['帳號', 'account', 'username'], password: ['密碼', '密码', 'password'] };
  const column = Object.fromEntries(Object.entries(aliases).map(([field, values]) => [field, names.findIndex((name) => values.includes(name))]));
  if (Object.values(column).some((index) => index < 0)) throw new Error('第一列必須包含「帳號、密碼」欄位。');
  return sheet.slice(1).map((cells) => ({ name: cells[column.name], password: cells[column.password] }))
    .filter((row) => Object.values(row).some((value) => value != null && String(value).trim()));
}

async function vote(optionId) {
  if (!state.profile) { openLogin(); return false; }
  if (state.profile.role !== 'voter') { toast('管理員帳號不能投票。', 'error'); return false; }
  if (state.votes.length) { toast('此帳號已投過票。', 'error'); return false; }
  if (!votingOpen()) { toast('目前未開放投票。', 'error'); return false; }
  const option = state.options.find((item) => item.id === optionId);
  if (!option || option.enabled === false) { toast('此作品目前無法投票。', 'error'); return false; }
  const { error } = await supabase.from('votes').insert({ user_id: state.user.id, option_id: optionId });
  if (error) { toast(error.code === '23505' ? '此帳號已投過票。' : !votingOpen() ? '目前未開放投票。' : `投票失敗：${error.message}`, 'error'); return false; }
  selectedOptionId = null;
  await refresh();
  return true;
}

function exportData({ includeAccount = true } = {}) {
  const report = buildVoteReport(state.options, state.votes, state.users);
  return buildExportTables(report, taipeiTime, { includeAccount });
}

function csvValue(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(filename, rows) {
  const blob = new Blob([`\uFEFF${rows.map((row) => row.map(csvValue).join(',')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

let voteChannel;
function syncRealtime() {
  if (state.profile?.role === 'admin' && !voteChannel) {
    voteChannel = supabase.channel('admin-vote-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes' }, () => refresh())
      .subscribe();
  } else if (state.profile?.role !== 'admin' && voteChannel) {
    supabase.removeChannel(voteChannel);
    voteChannel = null;
  }
}

$('#year').textContent = new Date().getFullYear();
$('#login-button').addEventListener('click', openLogin);
$('#closing-login').addEventListener('click', openLogin);
$('#logout-button').addEventListener('click', async () => {
  const { error } = await supabase.auth.signOut();
  if (error) return toast(error.message, 'error');
  await refresh();
  toast('已登出。', 'success');
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('.modal').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const account = $('#login-username').value.trim();
  const password = $('#login-password').value;
  if (!account.includes('@') && !validName(account)) return toast('請輸入學號或 Email。', 'error');
  setBusy(form, true);
  try {
    const email = account.includes('@') ? account : await voterEmail(account);
    let { error } = await supabase.auth.signInWithPassword({ email, password: await authPassword(password) });
    if (error && error.status === 400) {
      ({ error } = await supabase.auth.signInWithPassword({ email, password })); // 舊帳號保留原密碼
    }
    if (error) throw new Error('帳號或密碼不正確。');
    $('#login-dialog').close();
    form.reset();
    await refresh();
    toast(`歡迎回來，${state.profile?.name || account}！`, 'success');
    if (state.profile?.role === 'admin') $('#admin').scrollIntoView();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(form, false); }
});

$('#works-grid').addEventListener('change', (event) => {
  if (event.target.name !== 'ballot') return;
  selectedOptionId = Number(event.target.value);
  $('#submit-vote').disabled = false;
});
$('#submit-vote').addEventListener('click', () => {
  const option = state.options.find((item) => item.id === selectedOptionId);
  if (!option || !votingOpen() || state.votes.length) return toast('目前無法送出投票，請重新整理頁面。', 'error');
  $('#vote-confirm-copy').textContent = `您選擇的是「${option.code || optionCode(option.id)}－${option.title}」，投票送出後無法修改，是否確定送出？`;
  $('#vote-confirm-dialog').showModal();
});
$('#back-to-ballot').addEventListener('click', () => $('#vote-confirm-dialog').close());
$('#confirm-vote').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const id = selectedOptionId;
    if (!id) return;
    const success = await vote(id);
    if (success) {
      $('#vote-confirm-dialog').close();
      $('#vote-success-dialog').showModal();
    }
  } catch (error) { toast(`投票失敗：${error.message}`, 'error'); }
  finally { button.disabled = false; }
});
$('#add-user-row').addEventListener('click', addUserRow);
$('#add-option-row').addEventListener('click', addOptionRow);
document.querySelectorAll('.form-rows').forEach((container) => container.addEventListener('click', (event) => {
  if (!event.target.matches('.remove-row')) return;
  const rows = container.querySelectorAll('.form-row');
  if (container.id === 'manual-user-rows') {
    event.target.closest('.form-row').remove();
    $('#create-users-button').disabled = !container.querySelector('.form-row');
  } else if (rows.length > 1) event.target.closest('.form-row').remove();
  else rows[0].querySelectorAll('input').forEach((input) => { if (input.type === 'checkbox') input.checked = true; else input.value = ''; });
}));

$('#manual-users-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true);
  try { await createUsers(manualRows()); form.reset(); $('#manual-user-rows').innerHTML = ''; }
  catch (error) { toast(error.message, 'error'); }
  finally { setBusy(form, !$('#manual-user-rows').querySelector('.form-row')); }
});

$('#excel-file').addEventListener('change', (event) => { $('#file-name').textContent = event.target.files[0]?.name || ''; });
$('#excel-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true);
  try { await createUsers(await excelRows($('#excel-file').files[0])); form.reset(); $('#file-name').textContent = ''; }
  catch (error) { toast(error.message, 'error'); }
  finally { setBusy(form, false); }
});

$('#options-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const rows = [...document.querySelectorAll('#option-rows .form-row')].map((row) => ({
    code: row.querySelector('[name="code"]').value.trim(), title: row.querySelector('[name="title"]').value.trim(),
    video_url: row.querySelector('[name="video_url"]').value.trim(), enabled: row.querySelector('[name="enabled"]').checked,
  })).filter((row) => row.code || row.title || row.video_url);
  if (!rows.length || rows.length > 100 || rows.some((row) => !validWorkCode(row.code) || !row.title || row.title.length > 150 || !validVideoUrl(row.video_url))) {
    return toast('請輸入 1 至 100 筆選項，每筆需有作品編號、名稱與有效的 http(s) 影片連結。', 'error');
  }
  if (new Set(rows.map((row) => row.code)).size !== rows.length) return toast('作品編號不可重複。', 'error');
  setBusy(form, true);
  try {
    const { error } = await supabase.from('options').insert(rows);
    if (error) throw error;
    $('#option-rows').innerHTML = ''; addOptionRow();
    await refresh();
    toast(`已新增 ${rows.length} 個投票選項。`, 'success');
  } catch (error) { toast(error.code === '23505' ? '作品編號已存在，請改用其他編號。' : error.message, 'error'); }
  finally { setBusy(form, false); }
});

$('#options-list').addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit-work]');
  const deleteButton = event.target.closest('[data-delete-work]');
  if (editButton) {
    const option = state.options.find((item) => item.id === Number(editButton.dataset.editWork));
    if (!option) return;
    $('#edit-work-id').value = option.id;
    $('#edit-work-code').value = option.code || optionCode(option.id);
    $('#edit-work-title').value = option.title;
    $('#edit-work-url').value = option.video_url;
    $('#edit-work-enabled').checked = option.enabled !== false;
    $('#edit-work-dialog').showModal();
  }
  if (deleteButton) {
    const option = state.options.find((item) => item.id === Number(deleteButton.dataset.deleteWork));
    if (!option || !confirm(`確定刪除「${option.code || optionCode(option.id)}－${option.title}」嗎？`)) return;
    try {
      const { data, error } = await supabase.from('options').delete().eq('id', option.id).select('id').single();
      if (error) throw error;
      if (!data) throw new Error('作品未刪除，請確認管理員權限。');
      await refresh();
      toast('作品已刪除。', 'success');
    } catch (error) {
      toast(error.code === '23503' ? '此作品已有投票紀錄，無法刪除；可改為不開放投票。' : `刪除失敗：${error.message}`, 'error');
    }
  }
});

$('#edit-work-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const code = $('#edit-work-code').value.trim();
  const title = $('#edit-work-title').value.trim();
  const video_url = $('#edit-work-url').value.trim();
  const enabled = $('#edit-work-enabled').checked;
  if (!validWorkCode(code) || !title || title.length > 150 || !validVideoUrl(video_url)) return toast('請填寫有效的作品編號、名稱與影片連結。', 'error');
  setBusy(form, true);
  try {
    const { data, error } = await supabase.from('options').update({ code, title, video_url, enabled }).eq('id', Number($('#edit-work-id').value)).select('id').single();
    if (error) throw error;
    if (!data) throw new Error('作品未更新，請確認管理員權限。');
    $('#edit-work-dialog').close();
    await refresh();
    toast('作品已更新。', 'success');
  } catch (error) { toast(`儲存失敗：${error.message}`, 'error'); }
  finally { setBusy(form, false); }
});

$('#user-search').addEventListener('input', renderUsers);
$('#delete-all-users').addEventListener('click', async () => {
  if (bulkDeleteRunning || !state.users.length) return;
  const targets = [...state.users];
  if (!confirm(`確定刪除全部 ${targets.length} 位投票者帳號嗎？其投票紀錄也會永久刪除，票數將重新計算。管理員帳號不受影響。`)) return;
  bulkDeleteRunning = true;
  $('#delete-all-users').disabled = true;
  let deleted = 0;
  const errors = [];
  try {
    for (let offset = 0; offset < targets.length; offset += 10) {
      const chunk = targets.slice(offset, offset + 10);
      const result = await functionCall({ action: 'delete_users', ids: chunk.map((user) => user.id) });
      deleted += result.deleted || 0;
      errors.push(...(result.errors || []));
      toast(`刪除進度：${Math.min(offset + 10, targets.length)} / ${targets.length}`);
    }
    await refresh();
    toast(`已刪除 ${deleted} 位投票者帳號${errors.length ? `；${errors.length} 位失敗，請重新整理後再試。` : '及其投票紀錄。'}`, errors.length ? 'error' : 'success');
  } catch (error) {
    await refresh();
    toast(`批次刪除中斷：已刪除 ${deleted} 位；${error.message}`, 'error');
  } finally {
    bulkDeleteRunning = false;
    $('#delete-all-users').disabled = state.users.length === 0;
  }
});
$('#users-list').addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit]');
  const deleteButton = event.target.closest('[data-delete]');
  if (editButton) {
    const user = state.users.find((item) => item.id === editButton.dataset.edit);
    if (!user) return;
    $('#edit-id').value = user.id;
    $('#edit-name').value = user.name;
    $('#edit-password').value = '';
    $('#edit-dialog').showModal();
  }
  if (deleteButton) {
    const user = state.users.find((item) => item.id === deleteButton.dataset.delete);
    if (!user || !confirm(`確定刪除「${user.name}（${user.username}）」嗎？其投票紀錄也會移除。`)) return;
    try { await functionCall({ action: 'delete_user', id: user.id }); await refresh(); toast('使用者已刪除。', 'success'); }
    catch (error) { toast(error.message, 'error'); }
  }
});

$('#edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = $('#edit-name').value.trim();
  const password = $('#edit-password').value;
  if (!validName(name) || (password && password.length > 72)) {
    return toast('姓名不可空白且最多 80 字元；新密碼最多 72 字元。', 'error');
  }
  setBusy(form, true);
  try {
    await functionCall({ action: 'update_user', id: $('#edit-id').value, name, password });
    $('#edit-dialog').close();
    await refresh();
    toast('使用者資料已更新。', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(form, false); }
});

$('#schedule-form').addEventListener('input', () => { $('#schedule-form').dataset.dirty = '1'; });
$('#schedule-form').addEventListener('change', () => { $('#schedule-form').dataset.dirty = '1'; });
$('#voting-mode').addEventListener('change', syncScheduleInputs);
$('#schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const mode = $('#voting-mode').value;
  const start = $('#opens-at').value;
  const end = $('#closes-at').value;
  const opens_at = start ? new Date(`${start}+08:00`).toISOString() : null;
  const closes_at = end ? new Date(`${end}+08:00`).toISOString() : null;
  if (mode === 'scheduled' && (!opens_at || !closes_at || Date.parse(closes_at) <= Date.parse(opens_at))) return toast('排程需填寫開放與截止時間，且截止時間必須晚於開放時間。', 'error');
  if (mode === 'open' && closes_at && Date.parse(closes_at) <= Date.now()) return toast('立即開放時，請清除已過的截止時間或設定未來時間。', 'error');
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const payload = { mode, opens_at: mode === 'scheduled' ? opens_at : null, closes_at: mode === 'closed' ? null : closes_at };
    const { data, error } = await supabase.from('voting_settings').update(payload).eq('id', 1).select('mode,opens_at,closes_at').single();
    if (error) throw error;
    state.settings = data;
    delete form.dataset.dirty;
    render();
    toast('投票設定已儲存。', 'success');
  } catch (error) { toast(`儲存失敗：${error.message}`, 'error'); }
  finally { setBusy(form, false); }
});

$('#admin-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = $('#new-admin-password').value;
  const confirmation = $('#confirm-admin-password').value;
  if (!password || password.length > 72) return toast('新密碼不可空白且最多 72 字元。', 'error');
  if (password !== confirmation) return toast('兩次輸入的新密碼不一致。', 'error');
  setBusy(form, true);
  try {
    await functionCall({ action: 'change_admin_password', password });
    form.reset();
    toast('管理員密碼已更新，下次登入請使用新密碼。', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(form, false); }
});

$('#refresh-results').addEventListener('click', refresh);
$('#export-records-csv').addEventListener('click', () => downloadCsv('投票紀錄.csv', exportData().records));
$('#export-results-csv').addEventListener('click', () => downloadCsv('作品統計.csv', exportData().results));
$('#export-xlsx').addEventListener('click', async () => {
  try {
    const { records, results } = exportData({ includeAccount: false });
    await writeExcelFile([
      { sheet: '投票紀錄', data: records },
      { sheet: '作品統計', data: results },
    ]).toFile('投票結果.xlsx');
  } catch (error) { toast(`Excel 匯出失敗：${error.message}`, 'error'); }
});

$('#sync-names').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const pending = state.users.filter((user) => user.username !== normalizeUsername(user.name));
  if (!pending.length) return;
  button.disabled = true;
  let updated = 0;
  const errors = [];
  try {
    for (let offset = 0; offset < pending.length; offset += 20) {
      const result = await functionCall({ action: 'sync_names', ids: pending.slice(offset, offset + 20).map((user) => user.id) });
      updated += result.updated || 0;
      errors.push(...(result.errors || []));
    }
    await refresh();
    toast(`已將 ${updated} 位使用者改為姓名登入${errors.length ? `；${errors.length} 位失敗：${errors.slice(0, 2).join('、')}` : ''}。`, errors.length ? 'error' : 'success');
  } catch (error) { toast(`轉換失敗：${error.message}`, 'error'); }
  finally { button.disabled = false; }
});

addOptionRow();
if (configured) supabase.auth.onAuthStateChange(() => { setTimeout(refresh, 0); });
setInterval(() => {
  if (configured && document.visibilityState === 'visible') refresh();
}, 10000);
let lastPhase = votingPhase(state.settings);
setInterval(() => {
  const phase = votingPhase(state.settings);
  if (configured && document.visibilityState === 'visible' && phase !== lastPhase) { renderVotingStatus(); renderWorks(); }
  lastPhase = phase;
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (configured && document.visibilityState === 'visible') refresh();
});
refresh();
