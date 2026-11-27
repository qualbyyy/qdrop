// ============================================================
// qdrop-air app.js — передача файлов (до 300 МБ) и текста 1-на-1
// через Yandex Cloud Function + приватный Object Storage (HTTPS 443).
// Только createElement/textContent, sessionStorage и кастомные модалки.
// ============================================================

const SESSION_ACCESS_KEY = 'qdrop_air_access_key';
const MAX_TEXT_CHARS = 32768;
const DEFAULT_MAX_FILE_BYTES = 300 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 15 * 1024 * 1024;
const DOWNLOAD_URL_SAFE_MS = 100_000;
const DEFAULT_POLL_MS = 2000;
const WAITING_POLL_MS = 3000;
const HIDDEN_POLL_MS = 8000;

function getConfig() {
  const cfg = globalThis.QDROP_AIR_CONFIG || {};
  return {
    relayUrl: typeof cfg.relayUrl === 'string' ? cfg.relayUrl.trim() : '',
    pollIntervalMs: Number(cfg.pollIntervalMs) >= 500 ? Number(cfg.pollIntervalMs) : DEFAULT_POLL_MS,
    maxFileBytes: Number(cfg.maxFileBytes) > 0 ? Number(cfg.maxFileBytes) : DEFAULT_MAX_FILE_BYTES
  };
}

// ---------- Чистые утилиты (тестируются в Node) ----------

function normalizeCode(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  return digits.length === 6 ? digits : '';
}

function formatCode(raw) {
  const digits = normalizeCode(raw);
  return digits ? `${digits.slice(0, 3)}-${digits.slice(3)}` : '';
}

function extractCodeFromInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.includes('to=') || /^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text, 'https://example.invalid');
      const toCode = normalizeCode(parsed.searchParams.get('to'));
      if (toCode) return toCode;
    } catch {
      // Пробуем разобрать как обычный 6-значный код
    }
  }
  return normalizeCode(text);
}

function sanitizeFilename(name) {
  let clean = String(name || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .split(/[/\\]/)
    .pop() || '';
  clean = clean.replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+/, '').trim();
  if (!clean || clean === '.' || clean === '..') return 'file';
  if (clean.length <= 180) return clean;
  const dot = clean.lastIndexOf('.');
  if (dot > 0 && clean.length - dot <= 20) {
    const ext = clean.slice(dot);
    return clean.slice(0, 180 - ext.length) + ext;
  }
  return clean.slice(0, 180);
}

function parseSafeHttpUrl(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href;
    }
  } catch {
    return null;
  }
  return null;
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

function formatSpeed(bytesPerSec) {
  const n = Number(bytesPerSec) || 0;
  return `${formatSize(Math.round(n))}/с`;
}

// ---------- Браузерное приложение ----------

function initApp() {
  const $ = (id) => document.getElementById(id);

  const statusBadge = $('statusBadge');
  const qrBtn = $('qrBtn');
  const networkBtn = $('networkBtn');
  const disconnectBtn = $('disconnectBtn');

  const pairCard = $('pairCard');
  const myCodeDisplay = $('myCodeDisplay');
  const openQrActionBtn = $('openQrActionBtn');
  const remoteCodeInput = $('remoteCodeInput');
  const connectBtn = $('connectBtn');

  const connectedBar = $('connectedBar');
  const connectedPeerLabel = $('connectedPeerLabel');
  const connectedRouteLabel = $('connectedRouteLabel');
  const barDisconnectBtn = $('barDisconnectBtn');

  const dropZone = $('dropZone');
  const fileInput = $('fileInput');
  const browseBtn = $('browseBtn');
  const textInput = $('textInput');
  const sendTextBtn = $('sendTextBtn');

  const transferCount = $('transferCount');
  const autoSaveToggle = $('autoSaveToggle');
  const saveAllBtn = $('saveAllBtn');
  const clearFeedBtn = $('clearFeedBtn');
  const feedEmpty = $('feedEmpty');
  const transferList = $('transferList');

  const qrModal = $('qrModal');
  const closeQrBtn = $('closeQrBtn');
  const qrTabMine = $('qrTabMine');
  const qrTabScan = $('qrTabScan');
  const qrMinePanel = $('qrMinePanel');
  const qrCodeWrap = $('qrCodeWrap');
  const qrModalCode = $('qrModalCode');
  const qrScanPanel = $('qrScanPanel');
  const qrReader = $('qrReader');
  const scanStatus = $('scanStatus');

  const networkModal = $('networkModal');
  const closeNetworkBtn = $('closeNetworkBtn');
  const accessKeyForm = $('accessKeyForm');
  const accessKeyInput = $('accessKeyInput');
  const relayTestStatus = $('relayTestStatus');
  const resetRelayBtn = $('resetRelayBtn');
  const applyRelayBtn = $('applyRelayBtn');

  const windowDropOverlay = $('windowDropOverlay');
  const toastEl = $('toast');

  const config = getConfig();
  const baseTitle = document.title || 'qdrop air';

  let roomCode = '';
  let roomToken = '';
  let roomRole = '';
  let isPaired = false;
  let remoteDeviceName = 'Устройство';
  let eventCursor = '';
  const seenEventIds = new Set();

  let pollTimer = null;
  let pollInFlight = false;
  let activeXhr = null;
  let activeJob = null;
  const sendQueue = [];
  let isSending = false;
  const feedEntries = [];
  let itemCounter = 0;
  let unreadCount = 0;
  let windowDragDepth = 0;

  let html5QrcodePromise = null;
  let qrScanner = null;
  let scannerSessionId = 0;
  let toastTimer = null;

  // ---------- DOM-хелперы ----------

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    const p = props || {};
    Object.keys(p).forEach((key) => {
      const value = p[key];
      if (value === undefined || value === null) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        node.setAttribute(key, String(value));
      }
    });
    for (const child of children) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function createDirectionIcon(direction) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', direction === 'in' ? 'dir-icon incoming' : 'dir-icon');

    const line = document.createElementNS(ns, 'line');
    const poly = document.createElementNS(ns, 'polyline');
    if (direction === 'in') {
      line.setAttribute('x1', '12');
      line.setAttribute('y1', '5');
      line.setAttribute('x2', '12');
      line.setAttribute('y2', '19');
      poly.setAttribute('points', '19 12 12 19 5 12');
    } else {
      line.setAttribute('x1', '12');
      line.setAttribute('y1', '19');
      line.setAttribute('x2', '12');
      line.setAttribute('y2', '5');
      poly.setAttribute('points', '5 12 12 5 19 12');
    }
    svg.appendChild(line);
    svg.appendChild(poly);
    return svg;
  }

  function showToast(message, type = '') {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.className = 'toast' + (type ? ` ${type}` : '');
    void toastEl.offsetWidth;
    toastEl.classList.add('visible');
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('visible');
    }, 3200);
  }

  function markUnreadIfHidden() {
    if (!document.hidden) return;
    unreadCount += 1;
    document.title = `(${unreadCount}) qdrop air`;
  }

  function clearUnreadTitle() {
    if (!unreadCount) return;
    unreadCount = 0;
    document.title = baseTitle;
  }

  function autoResizeTextInput() {
    textInput.style.height = 'auto';
    textInput.style.height = `${Math.min(120, textInput.scrollHeight)}px`;
  }

  function getDeviceLabel() {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Mobile/i.test(ua)) return 'Телефон';
    return 'ПК';
  }

  function readSession(key) {
    try {
      return String(sessionStorage.getItem(key) || '').trim();
    } catch {
      return '';
    }
  }

  function writeSession(key, value) {
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch {}
  }

  function getRelayUrl() {
    return config.relayUrl;
  }

  function getAccessKey() {
    return readSession(SESSION_ACCESS_KEY);
  }

  function buildShareUrl(code) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('to', code);
    return url.toString();
  }

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(okMessage, 'success');
    } catch {
      showToast('Не удалось скопировать в буфер', 'error');
    }
  }

  // ---------- Состояние UI ----------

  function setBadge(variant, text) {
    statusBadge.className = 'badge' + (variant ? ` ${variant}` : '');
    statusBadge.textContent = text;
  }

  function renderMyCode() {
    const formatted = formatCode(roomCode);
    const display = formatted ? formatted.replace('-', ' ') : '--- ---';
    myCodeDisplay.textContent = display;
    qrModalCode.textContent = display;
    openQrActionBtn.textContent = roomCode ? 'QR' : 'Ключ';
    if (qrModal.classList.contains('active') && !qrMinePanel.hidden) {
      renderMyQr();
    }
  }

  function updateConnectedUi() {
    pairCard.hidden = isPaired;
    connectedBar.hidden = !isPaired;
    disconnectBtn.hidden = !isPaired;
    dropZone.classList.toggle('is-offline', !isPaired);
    sendTextBtn.disabled = !isPaired || !textInput.value.trim();

    if (isPaired) {
      setBadge('configured', `HTTPS 443 • ${remoteDeviceName}`);
      connectedPeerLabel.textContent = `Подключено: ${remoteDeviceName}`;
      connectedRouteLabel.textContent = 'HTTPS 443';
    }
  }

  function updateFeedControls() {
    const total = feedEntries.length;
    transferCount.textContent = total ? `(${total})` : '';
    feedEmpty.hidden = total > 0;
    transferList.hidden = total === 0;
    clearFeedBtn.hidden = total === 0;

    const unsavedIncoming = feedEntries.filter(
      (entry) => entry.kind === 'file' && entry.direction === 'in' && entry.downloadUrl && !entry.saved
    );
    if (unsavedIncoming.length >= 2) {
      saveAllBtn.hidden = false;
      saveAllBtn.textContent = `Сохранить все (${unsavedIncoming.length})`;
    } else {
      saveAllBtn.hidden = true;
    }
  }

  // ---------- API-клиент к Yandex Cloud Function ----------

  async function relayCall(action, params = {}) {
    const url = getRelayUrl();
    if (!url) {
      throw Object.assign(new Error('Не задан адрес релея'), { status: 0 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const payload = { action, ...params };
      const accessKey = getAccessKey();
      if (accessKey && action === 'create') {
        payload.accessKey = accessKey;
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- Комнаты и polling ----------

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleNextPoll() {
    stopPolling();
    if (!roomCode || !roomToken) return;
    const delay = document.hidden ? HIDDEN_POLL_MS : (isPaired ? config.pollIntervalMs : WAITING_POLL_MS);
    pollTimer = setTimeout(pollRoom, delay);
  }

  function resetRoomState() {
    stopPolling();
    if (activeXhr) {
      try { activeXhr.abort(); } catch {}
      activeXhr = null;
    }
    activeJob = null;
    sendQueue.length = 0;
    isSending = false;
    roomCode = '';
    roomToken = '';
    roomRole = '';
    isPaired = false;
    remoteDeviceName = 'Устройство';
    eventCursor = '';
    seenEventIds.clear();
    renderMyCode();
    updateConnectedUi();
  }

  async function createRoom(showErrorOn401 = false) {
    resetRoomState();
    const url = getRelayUrl();
    if (!url) {
      setBadge('pending', 'Нужен Relay URL');
      return;
    }

    setBadge('pending', 'Создание…');
    try {
      const res = await relayCall('create', { device: getDeviceLabel() });
      roomCode = res.code;
      roomToken = res.token;
      roomRole = res.role || 'host';
      renderMyCode();
      setBadge('', 'Готов');
      scheduleNextPoll();
    } catch (err) {
      if (err.status === 401) {
        setBadge('pending', 'Нужен ключ');
        myCodeDisplay.textContent = 'Введи ключ';
        openQrActionBtn.textContent = 'Ключ';
        openNetworkModal();
        if (showErrorOn401) {
          showToast('Неверный код доступа', 'error');
        }
      } else {
        setBadge('error', 'Нет связи с релеем');
        showToast(err.message || 'Ошибка подключения к релею', 'error');
      }
    }
  }

  async function joinRoom(rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) {
      showToast('Введи 6-значный код собеседника', 'error');
      return;
    }
    if (code === roomCode && roomCode) {
      showToast('Это твой собственный код', 'error');
      return;
    }
    if (!getRelayUrl()) {
      openNetworkModal();
      showToast('Не задан адрес релея', 'error');
      return;
    }

    const prevCode = roomCode;
    const prevToken = roomToken;

    connectBtn.disabled = true;
    connectBtn.textContent = 'Связь…';
    setBadge('pending', 'Подключение…');

    try {
      const res = await relayCall('join', { code, device: getDeviceLabel() });
      if (prevCode && prevToken && prevCode !== code) {
        relayCall('close', { code: prevCode, token: prevToken }).catch(() => {});
      }
      resetRoomState();
      roomCode = res.code;
      roomToken = res.token;
      roomRole = res.role || 'guest';
      remoteDeviceName = res.peerDevice || 'Устройство';
      isPaired = true;
      if (qrModal.classList.contains('active')) closeQrModal();
      renderMyCode();
      updateConnectedUi();
      showToast('Устройства связаны', 'success');
      scheduleNextPoll();
    } catch (err) {
      if (err.status === 409) {
        showToast('Устройство уже занято другой сессией', 'error');
      } else if (err.status === 404) {
        showToast('Код не найден или комната закрыта', 'error');
      } else if (err.status === 401) {
        openNetworkModal();
        showToast('Нужен код доступа', 'error');
      } else {
        showToast(err.message || 'Не удалось подключиться', 'error');
      }
      setBadge(roomCode ? '' : 'error', roomCode ? 'Готов' : 'Ошибка');
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Подключиться';
    }
  }

  async function pollRoom() {
    if (!roomCode || !roomToken || pollInFlight) return;
    pollInFlight = true;
    const currentCode = roomCode;
    try {
      const data = await relayCall('poll', { code: roomCode, token: roomToken, cursor: eventCursor });
      if (roomCode !== currentCode) return;

      if (data.closed) {
        showToast(data.expired ? 'Комната истекла, создаём новую' : 'Собеседник отключился');
        await createRoom();
        return;
      }

      if (data.connected && !isPaired) {
        isPaired = true;
        remoteDeviceName = data.peerDevice || 'Устройство';
        if (qrModal.classList.contains('active')) closeQrModal();
        updateConnectedUi();
        showToast('Устройства связаны', 'success');
      } else if (data.connected && data.peerDevice && data.peerDevice !== remoteDeviceName) {
        remoteDeviceName = data.peerDevice;
        updateConnectedUi();
      }

      if (data.cursor) eventCursor = data.cursor;
      if (Array.isArray(data.events)) {
        for (const ev of data.events) {
          if (!ev || !ev.id || seenEventIds.has(ev.id)) continue;
          seenEventIds.add(ev.id);
          if (ev.sender === roomRole) continue;
          handleIncomingEvent(ev);
        }
      }
    } catch (err) {
      if (roomCode === currentCode && err.status === 404) {
        showToast('Комната закрыта собеседником');
        await createRoom();
        return;
      }
    } finally {
      pollInFlight = false;
      if (roomCode === currentCode) {
        scheduleNextPoll();
      }
    }
  }

  async function disconnectSession() {
    const code = roomCode;
    const token = roomToken;
    resetRoomState();
    if (code && token) {
      await relayCall('close', { code, token }).catch(() => {});
    }
    showToast('Отключено, файлы удалены, выдан новый код');
    await createRoom();
  }

  // ---------- Лента передач ----------

  function triggerDownload(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function resolveFreshDownloadUrl(entry) {
    if (entry.downloadUrl && Date.now() < entry.urlExpiresAt) {
      return entry.downloadUrl;
    }
    if (!entry.fileKey || !roomCode || !roomToken) {
      return entry.downloadUrl;
    }
    const res = await relayCall('presign-download', {
      code: roomCode,
      token: roomToken,
      fileKey: entry.fileKey,
      name: entry.name
    });
    entry.downloadUrl = res.downloadUrl;
    entry.urlExpiresAt = Date.now() + DOWNLOAD_URL_SAFE_MS;
    return entry.downloadUrl;
  }

  function createFileFeedEntry(direction, name, size, previewFile = null) {
    itemCounter += 1;
    const id = `item-${itemCounter}`;
    const statusEl = el('span', { class: 'file-status uploading', text: direction === 'out' ? 'В очереди' : 'Получено' });
    const progressBar = el('div', { class: 'progress-bar' });
    const progressWrap = el('div', { class: 'progress' }, progressBar);
    const speedEl = el('span', { class: 'file-speed' });
    const metaEl = el('div', { class: 'transfer-meta' },
      el('span', { class: 'file-size', text: formatSize(size) }),
      speedEl
    );

    let previewUrl = '';
    let thumbNode = null;
    if (
      previewFile &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function' &&
      previewFile.type &&
      previewFile.type.startsWith('image/') &&
      previewFile.size <= MAX_PREVIEW_BYTES
    ) {
      previewUrl = URL.createObjectURL(previewFile);
      thumbNode = el('img', { class: 'file-thumb', src: previewUrl, alt: '' });
    }

    const actionsEl = el('div', { class: 'file-actions' }, statusEl);
    const li = el('li', { class: 'transfer-item' },
      thumbNode,
      el('div', { class: 'file-main' },
        el('div', { class: 'file-info' },
          createDirectionIcon(direction),
          el('span', { class: 'file-name', text: name, title: name })
        ),
        metaEl,
        progressWrap
      ),
      actionsEl
    );

    transferList.prepend(li);

    const entry = {
      id,
      kind: 'file',
      direction,
      name,
      size,
      state: 'active',
      downloadUrl: null,
      fileKey: '',
      urlExpiresAt: 0,
      previewUrl,
      saved: false,
      setProgress(percent, speedBytesPerSec) {
        const pct = Math.max(0, Math.min(100, percent));
        progressBar.style.width = `${pct}%`;
        speedEl.textContent = speedBytesPerSec > 0 && pct < 100 ? formatSpeed(speedBytesPerSec) : '';
      },
      setStatus(kind, text) {
        statusEl.className = `file-status ${kind}`;
        statusEl.textContent = text;
        if (kind === 'success' || kind === 'error') {
          entry.state = kind;
          speedEl.textContent = '';
          if (kind === 'success') progressBar.style.width = '100%';
          progressWrap.hidden = true;
        } else {
          entry.state = 'active';
          progressWrap.hidden = false;
        }
      },
      setActionButton(label, extraClass, onClick) {
        const btn = el('button', {
          type: 'button',
          class: extraClass ? `item-action-btn ${extraClass}` : 'item-action-btn',
          text: label,
          onClick
        });
        actionsEl.replaceChildren(statusEl, btn);
        return btn;
      },
      clearActionButton() {
        actionsEl.replaceChildren(statusEl);
      },
      attachDownload(downloadUrl, autoSaved, fileKey) {
        entry.downloadUrl = downloadUrl;
        entry.fileKey = fileKey || '';
        entry.urlExpiresAt = Date.now() + DOWNLOAD_URL_SAFE_MS;
        entry.saved = Boolean(autoSaved);
        const btn = el('button', {
          type: 'button',
          class: 'item-action-btn',
          text: autoSaved ? 'Ещё раз' : 'Сохранить',
          onClick: async () => {
            btn.disabled = true;
            try {
              const freshUrl = await resolveFreshDownloadUrl(entry);
              triggerDownload(freshUrl, name);
              entry.saved = true;
              btn.textContent = 'Ещё раз';
              entry.setStatus('success', 'Сохранено');
              updateFeedControls();
            } catch (err) {
              showToast(err && err.message ? err.message : 'Не удалось обновить ссылку', 'error');
            } finally {
              btn.disabled = false;
            }
          }
        });
        actionsEl.replaceChildren(statusEl, btn);
        entry.setStatus('success', autoSaved ? 'Сохранено' : 'Готово');
        updateFeedControls();
      }
    };

    feedEntries.push(entry);
    updateFeedControls();
    return entry;
  }

  function addTextFeedEntry(direction, text) {
    const safeUrl = parseSafeHttpUrl(text);
    const contentNode = safeUrl
      ? el('a', {
          class: 'text-link',
          href: safeUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: safeUrl
        })
      : el('div', { class: 'text-preview', text });

    const copyBtn = el('button', {
      type: 'button',
      class: 'mini-btn',
      text: 'Копировать',
      onClick: () => copyText(text, 'Текст скопирован')
    });

    const li = el('li', { class: 'transfer-item text-card' },
      el('div', { class: 'text-card-top' },
        el('div', { class: 'file-info' },
          createDirectionIcon(direction),
          el('span', { class: 'file-name', text: direction === 'in' ? 'Входящий текст' : 'Отправлено' })
        ),
        copyBtn
      ),
      contentNode
    );

    transferList.prepend(li);
    feedEntries.push({ kind: 'text', direction, downloadUrl: null });
    updateFeedControls();
  }

  function handleIncomingEvent(ev) {
    if (ev.kind === 'text' && ev.text) {
      addTextFeedEntry('in', String(ev.text).slice(0, MAX_TEXT_CHARS));
      markUnreadIfHidden();
      showToast('Получено сообщение');
      return;
    }
    if (ev.kind === 'file' && ev.downloadUrl) {
      const name = sanitizeFilename(ev.name);
      const entry = createFileFeedEntry('in', name, Number(ev.size) || 0);
      const shouldAutoSave = (Number(ev.batchTotal) || 1) <= 1 && autoSaveToggle.checked;
      entry.attachDownload(ev.downloadUrl, shouldAutoSave, ev.fileKey);
      markUnreadIfHidden();
      if (shouldAutoSave) {
        triggerDownload(ev.downloadUrl, name);
      }
    }
  }

  async function saveAllPending() {
    const targets = feedEntries.filter(
      (entry) => entry.kind === 'file' && entry.direction === 'in' && entry.downloadUrl && !entry.saved
    );
    if (!targets.length) return;

    saveAllBtn.disabled = true;
    for (let i = 0; i < targets.length; i += 1) {
      const entry = targets[i];
      try {
        const freshUrl = await resolveFreshDownloadUrl(entry);
        triggerDownload(freshUrl, entry.name);
        entry.saved = true;
        entry.setStatus('success', 'Сохранено');
      } catch (err) {
        showToast(err && err.message ? err.message : `Не удалось скачать ${entry.name}`, 'error');
      }
      if (i + 1 < targets.length) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    saveAllBtn.disabled = false;
    updateFeedControls();
  }

  function clearFeed() {
    for (let i = feedEntries.length - 1; i >= 0; i -= 1) {
      if (feedEntries[i].state === 'active') continue;
      if (feedEntries[i].previewUrl) {
        try { URL.revokeObjectURL(feedEntries[i].previewUrl); } catch {}
      }
      feedEntries.splice(i, 1);
    }
    if (feedEntries.length === 0) {
      transferList.replaceChildren();
    } else {
      for (const node of Array.from(transferList.children)) {
        if (!node.querySelector('.uploading')) node.remove();
      }
    }
    updateFeedControls();
  }

  // ---------- Прямая загрузка в Object Storage (XMLHttpRequest PUT) ----------

  function uploadFileDirect(uploadUrl, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhr = xhr;
      const startedAt = performance.now();
      let lastUiAt = 0;

      xhr.open('PUT', uploadUrl, true);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const now = performance.now();
        if (now - lastUiAt >= 100 || e.loaded === e.total) {
          lastUiAt = now;
          const elapsedSec = Math.max(0.05, (now - startedAt) / 1000);
          onProgress((e.loaded / e.total) * 100, e.loaded / elapsedSec);
        }
      };
      xhr.onload = () => {
        activeXhr = null;
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Ошибка загрузки S3 (HTTP ${xhr.status})`));
      };
      xhr.onerror = () => {
        activeXhr = null;
        reject(new Error('Сбой сети при загрузке файла'));
      };
      xhr.onabort = () => {
        activeXhr = null;
        reject(new Error('Отменено'));
      };
      xhr.send(file);
    });
  }

  function attachCancelButton(job) {
    job.entry.setActionButton('Отмена', 'danger-action', () => {
      job.cancelled = true;
      if (activeJob === job && activeXhr) {
        try { activeXhr.abort(); } catch {}
        return;
      }
      const idx = sendQueue.indexOf(job);
      if (idx !== -1) sendQueue.splice(idx, 1);
      job.entry.setStatus('error', 'Отменено');
      attachRetryButton(job);
    });
  }

  function attachRetryButton(job) {
    job.entry.setActionButton('Повторить', '', () => {
      if (!isPaired) {
        showToast('Сначала подключи второе устройство', 'error');
        return;
      }
      job.cancelled = false;
      job.entry.setProgress(0, 0);
      job.entry.setStatus('uploading', 'В очереди');
      attachCancelButton(job);
      sendQueue.push(job);
      processSendQueue();
    });
  }

  async function processSendQueue() {
    if (isSending) return;
    isSending = true;

    while (sendQueue.length > 0) {
      const job = sendQueue.shift();
      if (job.cancelled) continue;
      if (!isPaired || !roomCode || !roomToken) {
        job.entry.setStatus('error', 'Нет связи');
        attachRetryButton(job);
        continue;
      }

      activeJob = job;
      const file = job.file;
      const safeName = sanitizeFilename(file.name);
      try {
        job.entry.setStatus('uploading', 'Загрузка…');
        const presign = await relayCall('presign-upload', {
          code: roomCode,
          token: roomToken,
          size: file.size
        });
        if (job.cancelled) throw new Error('Отменено');
        await uploadFileDirect(presign.uploadUrl, file, (pct, speed) => {
          job.entry.setProgress(pct, speed);
        });
        if (job.cancelled) throw new Error('Отменено');
        await relayCall('commit-file', {
          code: roomCode,
          token: roomToken,
          fileId: presign.fileId,
          name: safeName,
          size: file.size,
          mime: file.type || 'application/octet-stream',
          batchTotal: job.batchTotal,
          batchIndex: job.batchIndex
        });
        seenEventIds.add(presign.fileId);
        job.entry.clearActionButton();
        job.entry.setProgress(100, 0);
        job.entry.setStatus('success', 'Доставлено');
      } catch (err) {
        const msg = job.cancelled
          ? 'Отменено'
          : err && err.status === 503
            ? 'Дневной лимит сервиса (3 ГБ) исчерпан'
            : (err && err.message ? err.message : 'Ошибка');
        job.entry.setStatus('error', msg);
        attachRetryButton(job);
        if (!job.cancelled && err && err.status === 503) {
          showToast('Дневной лимит сервиса (3 ГБ) исчерпан, попробуй завтра', 'error');
        }
      } finally {
        activeJob = null;
      }
    }

    isSending = false;
  }

  function queueFiles(rawFiles) {
    const files = Array.from(rawFiles || []);
    if (!files.length) return;
    if (!isPaired) {
      showToast('Сначала подключи второе устройство', 'error');
      return;
    }

    const valid = [];
    for (const file of files) {
      if (file.size > config.maxFileBytes) {
        showToast(`${sanitizeFilename(file.name)} превышает лимит ${formatSize(config.maxFileBytes)}`, 'error');
      } else {
        valid.push(file);
      }
    }
    if (!valid.length) return;

    const batchTotal = valid.length;
    valid.forEach((file, idx) => {
      const entry = createFileFeedEntry('out', sanitizeFilename(file.name), file.size, file);
      const job = { file, entry, batchTotal, batchIndex: idx + 1, cancelled: false };
      attachCancelButton(job);
      sendQueue.push(job);
    });

    processSendQueue();
  }

  async function sendQuickText() {
    const text = textInput.value.trim();
    if (!text) return;
    if (!isPaired) {
      showToast('Сначала подключи второе устройство', 'error');
      return;
    }
    const clipped = text.slice(0, MAX_TEXT_CHARS);
    sendTextBtn.disabled = true;
    try {
      const res = await relayCall('send-text', { code: roomCode, token: roomToken, text: clipped });
      if (res.id) seenEventIds.add(res.id);
      addTextFeedEntry('out', clipped);
      textInput.value = '';
      autoResizeTextInput();
    } catch {
      showToast('Не удалось отправить текст', 'error');
      sendTextBtn.disabled = false;
    }
  }

  // ---------- Модалки, QR и ленивый сканер ----------

  function openModal(modal) {
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeModal(modal) {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
  }

  function openNetworkModal() {
    accessKeyInput.value = getAccessKey();
    relayTestStatus.className = 'health-status';
    relayTestStatus.textContent = '';
    openModal(networkModal);
    accessKeyInput.focus();
  }

  function renderMyQr() {
    qrCodeWrap.replaceChildren();
    if (!roomCode) {
      qrCodeWrap.textContent = 'Код ещё не создан';
      return;
    }
    if (typeof QRCode === 'undefined') {
      qrCodeWrap.textContent = 'Модуль QR не загрузился';
      return;
    }
    new QRCode(qrCodeWrap, {
      text: buildShareUrl(roomCode),
      width: 216,
      height: 216,
      colorDark: '#111110',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  function loadHtml5QrcodeScript() {
    if (typeof Html5Qrcode !== 'undefined') return Promise.resolve();
    if (html5QrcodePromise) return html5QrcodePromise;

    html5QrcodePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'html5-qrcode.min.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        html5QrcodePromise = null;
        reject(new Error('Не удалось загрузить модуль сканера'));
      };
      document.body.appendChild(script);
    });
    return html5QrcodePromise;
  }

  function releaseCameraTracks() {
    for (const video of qrReader.querySelectorAll('video')) {
      const stream = video.srcObject;
      if (stream && typeof stream.getTracks === 'function') {
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch {}
        }
      }
      video.srcObject = null;
    }
    qrReader.replaceChildren();
  }

  async function stopScannerInstance(instance) {
    if (!instance) return;
    try {
      if (instance.isScanning) await instance.stop();
    } catch {}
    try {
      await instance.clear();
    } catch {}
    releaseCameraTracks();
  }

  async function stopQrScanner() {
    scannerSessionId += 1;
    const instance = qrScanner;
    qrScanner = null;
    await stopScannerInstance(instance);
  }

  async function startQrScanner() {
    await stopQrScanner();
    const currentSession = ++scannerSessionId;
    if (qrScanPanel.hidden || !qrModal.classList.contains('active') || document.hidden) return;
    scanStatus.textContent = 'Загрузка сканера…';

    let instance = null;
    try {
      await loadHtml5QrcodeScript();
      if (currentSession !== scannerSessionId || qrScanPanel.hidden || !qrModal.classList.contains('active') || document.hidden) {
        return;
      }
      if (typeof Html5Qrcode === 'undefined') throw new Error('Сканер недоступен');

      scanStatus.textContent = 'Запуск камеры…';
      qrReader.replaceChildren();
      instance = new Html5Qrcode('qrReader');
      qrScanner = instance;

      await instance.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decodedText) => {
          const code = extractCodeFromInput(decodedText);
          if (!code) {
            scanStatus.textContent = 'Это не QR-код qdrop air';
            return;
          }
          stopQrScanner();
          closeModal(qrModal);
          remoteCodeInput.value = formatCode(code);
          joinRoom(code);
        },
        () => {}
      );

      if (currentSession !== scannerSessionId || qrScanPanel.hidden || !qrModal.classList.contains('active') || document.hidden) {
        if (qrScanner === instance) qrScanner = null;
        await stopScannerInstance(instance);
        return;
      }
      scanStatus.textContent = 'Наведи камеру на QR-код второго устройства';
    } catch (err) {
      if (qrScanner === instance) qrScanner = null;
      await stopScannerInstance(instance);
      scanStatus.textContent = err && err.message ? err.message : 'Камера недоступна';
    }
  }

  function switchQrTab(tabName) {
    const isMine = tabName === 'mine';
    qrTabMine.classList.toggle('active', isMine);
    qrTabScan.classList.toggle('active', !isMine);
    qrTabMine.setAttribute('aria-selected', String(isMine));
    qrTabScan.setAttribute('aria-selected', String(!isMine));
    qrMinePanel.hidden = !isMine;
    qrScanPanel.hidden = isMine;

    if (isMine) {
      stopQrScanner();
      renderMyQr();
    } else {
      startQrScanner();
    }
  }

  function closeQrModal() {
    stopQrScanner();
    closeModal(qrModal);
  }

  // ---------- События интерфейса ----------

  qrBtn.addEventListener('click', () => {
    openModal(qrModal);
    switchQrTab('mine');
  });
  closeQrBtn.addEventListener('click', closeQrModal);
  qrTabMine.addEventListener('click', () => switchQrTab('mine'));
  qrTabScan.addEventListener('click', () => switchQrTab('scan'));

  openQrActionBtn.addEventListener('click', () => {
    if (roomCode) {
      openModal(qrModal);
      switchQrTab('mine');
    } else {
      openNetworkModal();
    }
  });

  networkBtn.addEventListener('click', openNetworkModal);
  closeNetworkBtn.addEventListener('click', () => closeModal(networkModal));

  accessKeyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    applyRelayBtn.click();
  });

  accessKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyRelayBtn.click();
    }
  });

  applyRelayBtn.addEventListener('click', async () => {
    writeSession(SESSION_ACCESS_KEY, accessKeyInput.value.trim());
    closeModal(networkModal);
    await createRoom(true);
  });

  resetRelayBtn.addEventListener('click', async () => {
    writeSession(SESSION_ACCESS_KEY, '');
    accessKeyInput.value = '';
    relayTestStatus.className = 'health-status success';
    relayTestStatus.textContent = 'Код доступа сброшен';
    await createRoom();
  });

  disconnectBtn.addEventListener('click', disconnectSession);
  barDisconnectBtn.addEventListener('click', disconnectSession);

  remoteCodeInput.addEventListener('input', () => {
    const digits = remoteCodeInput.value.replace(/\D+/g, '').slice(0, 6);
    remoteCodeInput.value = digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
  });

  remoteCodeInput.addEventListener('paste', (e) => {
    const pasted = e.clipboardData ? e.clipboardData.getData('text') : '';
    const extracted = extractCodeFromInput(pasted);
    if (extracted) {
      e.preventDefault();
      remoteCodeInput.value = formatCode(extracted);
    }
  });

  remoteCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      joinRoom(remoteCodeInput.value);
    }
  });

  connectBtn.addEventListener('click', () => joinRoom(remoteCodeInput.value));

  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    queueFiles(fileInput.files);
    fileInput.value = '';
  });

  function hasDraggedFiles(e) {
    return Boolean(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  }

  function hideWindowDropOverlay() {
    windowDragDepth = 0;
    if (windowDropOverlay) windowDropOverlay.classList.remove('active');
  }

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
    hideWindowDropOverlay();
    if (e.dataTransfer && e.dataTransfer.files) queueFiles(e.dataTransfer.files);
  });

  window.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    windowDragDepth += 1;
    if (windowDropOverlay) windowDropOverlay.classList.add('active');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    if (windowDragDepth > 0) windowDragDepth -= 1;
    if (windowDragDepth === 0) hideWindowDropOverlay();
  });
  window.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dropZone.classList.remove('dragover');
    hideWindowDropOverlay();
    if (e.dataTransfer && e.dataTransfer.files) queueFiles(e.dataTransfer.files);
  });

  textInput.addEventListener('input', () => {
    autoResizeTextInput();
    sendTextBtn.disabled = !isPaired || !textInput.value.trim();
  });

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendQuickText();
    }
  });

  sendTextBtn.addEventListener('click', sendQuickText);
  saveAllBtn.addEventListener('click', saveAllPending);
  clearFeedBtn.addEventListener('click', clearFeed);

  qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) closeQrModal();
  });
  networkModal.addEventListener('click', (e) => {
    if (e.target === networkModal) closeModal(networkModal);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (qrModal.classList.contains('active')) closeQrModal();
    if (networkModal.classList.contains('active')) closeModal(networkModal);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopQrScanner();
    } else {
      clearUnreadTitle();
      if (qrModal.classList.contains('active') && !qrScanPanel.hidden) {
        startQrScanner();
      }
    }
    if (roomCode && roomToken) scheduleNextPoll();
  });

  window.addEventListener('focus', clearUnreadTitle);

  document.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;

    const files = [];
    if (dt.files && dt.files.length) {
      files.push(...dt.files);
    } else if (dt.items) {
      for (const item of dt.items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
    }

    if (files.length) {
      e.preventDefault();
      const normalized = files.map((file, idx) => {
        if (file.name && file.name !== 'image.png') return file;
        const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
        const ext = file.type && file.type.includes('/') ? file.type.split('/')[1].split('+')[0] : 'png';
        return new File([file], `screenshot-${stamp}${idx ? '-' + idx : ''}.${ext}`, { type: file.type || 'image/png' });
      });
      queueFiles(normalized);
      return;
    }

    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

    const text = dt.getData('text');
    if (text && text.trim()) {
      e.preventDefault();
      textInput.value = text.trim();
      autoResizeTextInput();
      textInput.dispatchEvent(new Event('input'));
      textInput.focus();
    }
  });

  window.addEventListener('pagehide', (e) => {
    if (e && e.persisted) return;
    stopQrScanner();
    stopPolling();
    for (const entry of feedEntries) {
      if (entry.previewUrl) {
        try { URL.revokeObjectURL(entry.previewUrl); } catch {}
      }
    }
    const url = getRelayUrl();
    if (url && roomCode && roomToken) {
      try {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'close', code: roomCode, token: roomToken }),
          keepalive: true
        }).catch(() => {});
      } catch {}
    }
  });

  // ---------- Старт ----------

  async function boot() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    const hashRaw = location.hash ? location.hash.slice(1) : '';
    const hashParams = new URLSearchParams(hashRaw);
    const hashKey = (hashParams.get('key') || '').trim();
    if (hashKey) {
      writeSession(SESSION_ACCESS_KEY, hashKey);
      hashParams.delete('key');
      const nextHash = hashParams.toString();
      history.replaceState(null, '', location.pathname + location.search + (nextHash ? `#${nextHash}` : ''));
    }

    const params = new URLSearchParams(location.search);
    const toCode = normalizeCode(params.get('to'));
    const sharedParts = [
      (params.get('share_title') || '').trim(),
      (params.get('share_text') || '').trim(),
      (params.get('share_url') || '').trim()
    ].filter(Boolean);
    const uniqueShared = Array.from(new Set(sharedParts)).join('\n');

    if (toCode || uniqueShared) {
      history.replaceState(null, '', location.pathname + location.hash);
    }
    if (uniqueShared) {
      textInput.value = uniqueShared.slice(0, MAX_TEXT_CHARS);
      autoResizeTextInput();
    }

    updateConnectedUi();
    updateFeedControls();

    if (toCode) {
      remoteCodeInput.value = formatCode(toCode);
      await joinRoom(toCode);
    } else {
      await createRoom();
    }
  }

  boot();
}

if (typeof document !== 'undefined') {
  initApp();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeCode,
    formatCode,
    extractCodeFromInput,
    sanitizeFilename,
    parseSafeHttpUrl,
    formatSize,
    formatSpeed
  };
}
