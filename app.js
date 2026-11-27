// ============================================================
// qdrop-air app.js — WebRTC P2P передача файлов и текста 1-на-1.
// Только createElement/textContent, sessionStorage и кастомные модалки.
// ============================================================

const SESSION_TURN_KEY = 'qdrop_air_turn_proxy';
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const MAX_TEXT_CHARS = 32768;
const HIGH_WATERMARK = 1024 * 1024;
const LOW_WATERMARK = 256 * 1024;
const DEFAULT_CHUNK_SIZE = 65536;
const CONNECT_TIMEOUT_MS = 18000;
const ACK_TIMEOUT_MS = 15000;

function getConfig() {
  const cfg = globalThis.QDROP_AIR_CONFIG || {};
  return {
    peerPrefix: typeof cfg.peerPrefix === 'string' && cfg.peerPrefix ? cfg.peerPrefix : 'qdrop-air-',
    peerServer: cfg.peerServer && typeof cfg.peerServer === 'object' ? cfg.peerServer : null,
    turnProxyUrl: typeof cfg.turnProxyUrl === 'string' ? cfg.turnProxyUrl.trim() : '',
    iceServers: Array.isArray(cfg.iceServers) && cfg.iceServers.length
      ? cfg.iceServers
      : [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ],
    chunkSize: Number(cfg.chunkSize) > 0 ? Number(cfg.chunkSize) : DEFAULT_CHUNK_SIZE
  };
}

// ---------- Чистые утилиты (тестируются в Node) ----------

function generateSixDigitCode() {
  const max = 1000000;
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    while (true) {
      globalThis.crypto.getRandomValues(buf);
      if (buf[0] < limit) {
        return String(buf[0] % max).padStart(6, '0');
      }
    }
  }
  return String(Math.floor(Math.random() * max)).padStart(6, '0');
}

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
      // Игнорируем некорректный URL и пробуем извлечь как обычный код
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
  const copyCodeBtn = $('copyCodeBtn');
  const copyLinkBtn = $('copyLinkBtn');
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
  const qrCopyLinkBtn = $('qrCopyLinkBtn');
  const qrScanPanel = $('qrScanPanel');
  const qrReader = $('qrReader');
  const scanStatus = $('scanStatus');

  const networkModal = $('networkModal');
  const closeNetworkBtn = $('closeNetworkBtn');
  const netRouteValue = $('netRouteValue');
  const netTurnState = $('netTurnState');
  const turnProxyInput = $('turnProxyInput');
  const turnTestStatus = $('turnTestStatus');
  const resetTurnBtn = $('resetTurnBtn');
  const applyTurnBtn = $('applyTurnBtn');

  const toastEl = $('toast');

  const config = getConfig();
  let myCode = generateSixDigitCode();
  let peer = null;
  let activeConn = null;
  let remoteDeviceName = 'Устройство';
  let routeType = 'none'; // 'none' | 'p2p' | 'relay'
  let turnState = 'none'; // 'none' | 'active-config' | 'active-session' | 'fallback-error'
  let currentIceServers = [...config.iceServers];

  let pendingAutoConnectCode = '';
  let peerRetries = 0;
  let connectTimer = null;
  let routeTimers = [];
  let isDisconnecting = false;

  const sendQueue = [];
  let isSending = false;
  let pendingAckResolver = null;
  let incomingTransfer = null;
  const feedEntries = [];
  let itemCounter = 0;

  let html5QrcodePromise = null;
  let qrScanner = null;
  let scannerSessionId = 0;
  let toastTimer = null;

  // ---------- DOM-хелперы (только createElement + textContent) ----------

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

  function getDeviceLabel() {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Mobile/i.test(ua)) return 'Телефон';
    return 'ПК';
  }

  function getSessionTurnUrl() {
    try {
      return String(sessionStorage.getItem(SESSION_TURN_KEY) || '').trim();
    } catch {
      return '';
    }
  }

  function setSessionTurnUrl(url) {
    try {
      if (url) sessionStorage.setItem(SESSION_TURN_KEY, url);
      else sessionStorage.removeItem(SESSION_TURN_KEY);
    } catch {
      // sessionStorage может быть недоступен в приватном контексте
    }
  }

  function getEffectiveTurnProxyUrl() {
    return getSessionTurnUrl() || config.turnProxyUrl;
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

  // ---------- Состояние интерфейса ----------

  function setBadge(variant, text) {
    statusBadge.className = 'badge' + (variant ? ` ${variant}` : '');
    statusBadge.textContent = text;
  }

  function updateNetworkUi() {
    const routeText =
      routeType === 'relay'
        ? 'Relay 443 (через TURN)'
        : routeType === 'p2p'
          ? 'Прямой P2P (WebRTC)'
          : 'Не подключено';
    netRouteValue.textContent = routeText;

    if (turnState === 'active-session') netTurnState.textContent = 'Активен (сессия)';
    else if (turnState === 'active-config') netTurnState.textContent = 'Активен (config)';
    else if (turnState === 'fallback-error') netTurnState.textContent = 'Ошибка, работает STUN';
    else netTurnState.textContent = 'Только STUN';
  }

  function updateConnectedUi(connected) {
    const hasOpenChannel = Boolean(connected && activeConn && activeConn.open);
    pairCard.hidden = hasOpenChannel;
    connectedBar.hidden = !hasOpenChannel;
    disconnectBtn.hidden = !hasOpenChannel;
    dropZone.classList.toggle('is-offline', !hasOpenChannel);
    sendTextBtn.disabled = !hasOpenChannel || !textInput.value.trim();

    if (hasOpenChannel) {
      const routeShort = routeType === 'relay' ? 'Relay 443' : 'P2P';
      const label = `${routeShort} • ${remoteDeviceName}`;
      setBadge(routeType === 'relay' ? 'relay' : 'configured', label);
      connectedPeerLabel.textContent = `Подключено: ${remoteDeviceName}`;
      connectedRouteLabel.className = 'badge ' + (routeType === 'relay' ? 'relay' : 'configured');
      connectedRouteLabel.textContent = routeShort;
    } else {
      routeType = 'none';
    }
    updateNetworkUi();
  }

  function renderMyCode() {
    const formatted = formatCode(myCode);
    myCodeDisplay.textContent = formatted.replace('-', ' ');
    qrModalCode.textContent = formatted.replace('-', ' ');
    if (qrModal.classList.contains('active') && !qrMinePanel.hidden) {
      renderMyQr();
    }
  }

  function updateFeedControls() {
    const total = feedEntries.length;
    transferCount.textContent = total ? `(${total})` : '';
    feedEmpty.hidden = total > 0;
    transferList.hidden = total === 0;
    clearFeedBtn.hidden = total === 0;

    const unsavedIncoming = feedEntries.filter(
      (entry) => entry.kind === 'file' && entry.direction === 'in' && entry.objectUrl && !entry.saved
    );
    if (unsavedIncoming.length >= 2) {
      saveAllBtn.hidden = false;
      saveAllBtn.textContent = `Сохранить все (${unsavedIncoming.length})`;
    } else {
      saveAllBtn.hidden = true;
    }
  }

  // ---------- ICE / TURN ----------

  async function loadIceServers(proxyUrl) {
    const fallback = [...config.iceServers];
    const targetUrl = String(proxyUrl || '').trim();
    if (!targetUrl) {
      turnState = 'none';
      currentIceServers = fallback;
      updateNetworkUi();
      return { iceServers: fallback, ok: true, usedTurn: false };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const rawList = Array.isArray(payload) ? payload : payload && Array.isArray(payload.iceServers) ? payload.iceServers : null;
      if (!rawList) throw new Error('Некорректный ответ прокси');
      const turnServers = rawList.filter((item) => item && item.urls);
      if (!turnServers.length) throw new Error('Пустой список ICE-серверов');

      currentIceServers = [...fallback, ...turnServers];
      turnState = getSessionTurnUrl() === targetUrl ? 'active-session' : 'active-config';
      updateNetworkUi();
      return { iceServers: currentIceServers, ok: true, usedTurn: true };
    } catch (err) {
      currentIceServers = fallback;
      turnState = 'fallback-error';
      updateNetworkUi();
      return { iceServers: fallback, ok: false, usedTurn: false, error: err && err.message ? err.message : 'Ошибка TURN' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- WebRTC / PeerJS (строго 1-на-1) ----------

  function clearRouteTimers() {
    while (routeTimers.length) clearTimeout(routeTimers.pop());
  }

  function clearConnectTimer() {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function resetConnectionControls() {
    clearConnectTimer();
    clearRouteTimers();
    connectBtn.disabled = false;
    connectBtn.textContent = 'Подключиться';
  }

  function abortPendingTransfers(reasonText) {
    if (pendingAckResolver) {
      const resolve = pendingAckResolver;
      pendingAckResolver = null;
      resolve(false);
    }
    sendQueue.length = 0;
    isSending = false;

    if (incomingTransfer) {
      if (incomingTransfer.entry) {
        incomingTransfer.entry.setStatus('error', reasonText || 'Прервано');
      }
      incomingTransfer.chunks = null;
      incomingTransfer = null;
    }

    for (const entry of feedEntries) {
      if (entry.kind === 'file' && entry.state === 'active') {
        entry.setStatus('error', reasonText || 'Прервано');
      }
    }
  }

  async function inspectConnectionRoute(conn) {
    if (!conn || conn !== activeConn || !conn.open || !conn.peerConnection || typeof conn.peerConnection.getStats !== 'function') {
      return;
    }
    try {
      const stats = await conn.peerConnection.getStats();
      let selectedPair = null;
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPair = stats.get(report.selectedCandidatePairId) || selectedPair;
        }
      });
      if (!selectedPair) {
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && (report.nominated || report.selected) && report.state === 'succeeded') {
            selectedPair = report;
          }
        });
      }
      if (!selectedPair) return;
      const localCand = stats.get(selectedPair.localCandidateId);
      const remoteCand = stats.get(selectedPair.remoteCandidateId);
      const isRelay =
        (localCand && localCand.candidateType === 'relay') ||
        (remoteCand && remoteCand.candidateType === 'relay');
      routeType = isRelay ? 'relay' : 'p2p';
      if (activeConn === conn && conn.open) {
        updateConnectedUi(true);
      }
    } catch {
      // Игнорируем временную недоступность статистики
    }
  }

  function scheduleRouteChecks(conn) {
    clearRouteTimers();
    for (const delay of [300, 1500, 4000]) {
      routeTimers.push(setTimeout(() => inspectConnectionRoute(conn), delay));
    }
  }

  function rotateCodeAndReinit() {
    if (isDisconnecting) return;
    isDisconnecting = true;
    abortPendingTransfers('Отключено');
    resetConnectionControls();

    const oldConn = activeConn;
    activeConn = null;
    if (oldConn) {
      try { oldConn.close(); } catch {}
    }

    const oldPeer = peer;
    peer = null;
    if (oldPeer) {
      try { oldPeer.destroy(); } catch {}
    }

    remoteDeviceName = 'Устройство';
    updateConnectedUi(false);

    myCode = generateSixDigitCode();
    peerRetries = 0;
    renderMyCode();
    isDisconnecting = false;
    initPeer();
  }

  function rejectExtraConnection(extraConn) {
    let sent = false;
    const sendBusyAndClose = () => {
      if (sent) return;
      sent = true;
      try {
        if (extraConn.open) {
          extraConn.send(JSON.stringify({ type: 'busy' }));
        }
      } catch {}
      setTimeout(() => {
        try { extraConn.close(); } catch {}
      }, 150);
    };

    if (extraConn.open) {
      sendBusyAndClose();
    } else {
      extraConn.on('open', sendBusyAndClose);
      setTimeout(sendBusyAndClose, 2000);
    }
  }

  function attachDataChannelEvents(conn) {
    activeConn = conn;
    remoteDeviceName = 'Устройство';

    conn.on('open', () => {
      if (conn !== activeConn) return;
      resetConnectionControls();
      routeType = 'p2p';
      try {
        conn.send(JSON.stringify({ type: 'hello', device: getDeviceLabel() }));
      } catch {}
      updateConnectedUi(true);
      scheduleRouteChecks(conn);
      showToast('Устройства связаны', 'success');
    });

    conn.on('data', (raw) => {
      if (conn !== activeConn) return;
      handleIncomingPayload(raw);
    });

    conn.on('close', () => {
      if (conn !== activeConn || isDisconnecting) return;
      showToast('Собеседник отключился');
      rotateCodeAndReinit();
    });

    conn.on('error', () => {
      if (conn !== activeConn || isDisconnecting) return;
      showToast('Соединение прервано', 'error');
      rotateCodeAndReinit();
    });
  }

  function initPeer() {
    if (typeof Peer === 'undefined') {
      setBadge('error', 'PeerJS не загружен');
      return;
    }

    setBadge('pending', 'Регистрация…');
    const peerId = config.peerPrefix + myCode;
    const opts = {
      config: { iceServers: currentIceServers }
    };
    if (config.peerServer) {
      Object.assign(opts, config.peerServer);
    }

    const instance = new Peer(peerId, opts);
    peer = instance;

    instance.on('open', () => {
      if (peer !== instance) return;
      if (!activeConn) setBadge('', 'Готов');
      if (pendingAutoConnectCode) {
        const target = pendingAutoConnectCode;
        pendingAutoConnectCode = '';
        remoteCodeInput.value = formatCode(target);
        connectToCode(target);
      }
    });

    instance.on('connection', (conn) => {
      if (peer !== instance) return;
      if (activeConn) {
        rejectExtraConnection(conn);
        return;
      }
      attachDataChannelEvents(conn);
    });

    instance.on('error', (err) => {
      if (peer !== instance) return;
      const type = err && err.type ? err.type : '';

      if (type === 'unavailable-id' && peerRetries < 3) {
        peerRetries += 1;
        myCode = generateSixDigitCode();
        renderMyCode();
        try { instance.destroy(); } catch {}
        initPeer();
        return;
      }

      if (type === 'peer-unavailable') {
        if (activeConn && !activeConn.open) {
          try { activeConn.close(); } catch {}
          activeConn = null;
        }
        resetConnectionControls();
        setBadge('', 'Готов');
        showToast('Код не найден или устройство не в сети', 'error');
        return;
      }

      if (!activeConn || !activeConn.open) {
        resetConnectionControls();
        setBadge('error', 'Ошибка сети');
      }
      showToast(err && err.message ? err.message : 'Сбой подключения', 'error');
    });

    instance.on('disconnected', () => {
      if (peer !== instance || isDisconnecting) return;
      if (!activeConn) setBadge('pending', 'Переподключение…');
      try { instance.reconnect(); } catch {}
    });
  }

  function connectToCode(rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) {
      showToast('Введи 6-значный код собеседника', 'error');
      return;
    }
    if (code === myCode) {
      showToast('Это твой собственный код', 'error');
      return;
    }
    if (!peer || peer.destroyed) {
      pendingAutoConnectCode = code;
      showToast('Ожидаем готовность сети…');
      return;
    }
    if (activeConn) {
      showToast('Сначала отключи текущую пару', 'error');
      return;
    }

    setBadge('pending', 'Подключение…');
    connectBtn.disabled = true;
    connectBtn.textContent = 'Связь…';

    const conn = peer.connect(config.peerPrefix + code, {
      reliable: true,
      serialization: 'raw'
    });
    attachDataChannelEvents(conn);

    connectTimer = setTimeout(() => {
      if (activeConn === conn && !conn.open) {
        try { conn.close(); } catch {}
        activeConn = null;
        resetConnectionControls();
        setBadge('', 'Готов');
        showToast('Не удалось соединиться — проверь код или TURN', 'error');
      }
    }, CONNECT_TIMEOUT_MS);
  }

  function disconnectSession() {
    if (activeConn && activeConn.open) {
      try {
        activeConn.send(JSON.stringify({ type: 'bye' }));
      } catch {}
    }
    rotateCodeAndReinit();
    showToast('Отключено, выдан новый код');
  }

  // ---------- Лента передач ----------

  function triggerDownload(objectUrl, filename) {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function createFileFeedEntry(direction, name, size) {
    itemCounter += 1;
    const id = `item-${itemCounter}`;
    const statusEl = el('span', { class: 'file-status uploading', text: direction === 'out' ? 'В очереди' : 'Приём…' });
    const progressBar = el('div', { class: 'progress-bar' });
    const progressWrap = el('div', { class: 'progress' }, progressBar);
    const metaEl = el('div', { class: 'transfer-meta' },
      el('span', { class: 'file-size', text: formatSize(size) })
    );
    const speedEl = el('span', { class: 'file-speed' });
    metaEl.appendChild(speedEl);

    const actionsEl = el('div', { class: 'file-actions' }, statusEl);
    const li = el('li', { class: 'transfer-item' },
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
      objectUrl: null,
      saved: false,
      setProgress(percent, speedBytesPerSec) {
        const pct = Math.max(0, Math.min(100, percent));
        progressBar.style.width = `${pct}%`;
        if (speedBytesPerSec > 0 && pct < 100) {
          speedEl.textContent = formatSpeed(speedBytesPerSec);
        } else {
          speedEl.textContent = '';
        }
      },
      setStatus(kind, text) {
        statusEl.className = `file-status ${kind}`;
        statusEl.textContent = text;
        if (kind === 'success' || kind === 'error') {
          entry.state = kind;
          speedEl.textContent = '';
          if (kind === 'success') progressBar.style.width = '100%';
          progressWrap.hidden = true;
        }
      },
      attachDownload(objectUrl, autoSaved) {
        entry.objectUrl = objectUrl;
        entry.saved = Boolean(autoSaved);
        const btn = el('button', {
          type: 'button',
          class: 'item-action-btn',
          text: autoSaved ? 'Ещё раз' : 'Сохранить',
          onClick: () => {
            triggerDownload(objectUrl, name);
            entry.saved = true;
            btn.textContent = 'Ещё раз';
            entry.setStatus('success', 'Сохранено');
            updateFeedControls();
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
    feedEntries.push({ kind: 'text', direction, objectUrl: null });
    updateFeedControls();
  }

  async function saveAllPending() {
    const targets = feedEntries.filter(
      (entry) => entry.kind === 'file' && entry.direction === 'in' && entry.objectUrl && !entry.saved
    );
    if (!targets.length) return;

    saveAllBtn.disabled = true;
    for (let i = 0; i < targets.length; i += 1) {
      const entry = targets[i];
      triggerDownload(entry.objectUrl, entry.name);
      entry.saved = true;
      entry.setStatus('success', 'Сохранено');
      if (i + 1 < targets.length) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    saveAllBtn.disabled = false;
    updateFeedControls();
  }

  function clearFeed() {
    for (let i = feedEntries.length - 1; i >= 0; i -= 1) {
      const entry = feedEntries[i];
      if (entry.state === 'active') continue;
      if (entry.objectUrl) {
        try { URL.revokeObjectURL(entry.objectUrl); } catch {}
      }
      feedEntries.splice(i, 1);
    }
    const keptActive = feedEntries.length > 0;
    if (!keptActive) {
      transferList.replaceChildren();
    } else {
      const nodes = Array.from(transferList.children);
      for (const node of nodes) {
        if (!node.querySelector('.uploading')) node.remove();
      }
    }
    updateFeedControls();
  }

  // ---------- Передача файлов (64 КБ чанки + backpressure) ----------

  function waitForDrain(conn) {
    const dc = conn && conn.dataChannel;
    if (!dc || dc.readyState !== 'open') return Promise.resolve(false);
    if (dc.bufferedAmount <= HIGH_WATERMARK) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        dc.removeEventListener('bufferedamountlow', onLow);
        dc.removeEventListener('close', onClose);
        resolve(ok);
      };
      const onLow = () => {
        if (dc.bufferedAmount <= LOW_WATERMARK) done(true);
      };
      const onClose = () => done(false);
      const poll = setInterval(() => {
        if (dc.readyState !== 'open') done(false);
        else if (dc.bufferedAmount <= LOW_WATERMARK) done(true);
      }, 50);

      try { dc.bufferedAmountLowThreshold = LOW_WATERMARK; } catch {}
      dc.addEventListener('bufferedamountlow', onLow);
      dc.addEventListener('close', onClose);
    });
  }

  function waitForAck(fileId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingAckResolver === finish) pendingAckResolver = null;
        resolve(false);
      }, ACK_TIMEOUT_MS);

      const finish = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
      pendingAckResolver = (ackId) => {
        if (ackId === fileId) {
          pendingAckResolver = null;
          finish(true);
        }
      };
    });
  }

  async function processSendQueue() {
    if (isSending) return;
    isSending = true;

    while (sendQueue.length > 0) {
      const job = sendQueue.shift();
      const conn = activeConn;
      if (!conn || !conn.open) {
        job.entry.setStatus('error', 'Нет связи');
        continue;
      }

      const file = job.file;
      const safeName = sanitizeFilename(file.name);
      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      try {
        job.entry.setStatus('uploading', 'Отправка…');
        conn.send(JSON.stringify({
          type: 'file-start',
          id: fileId,
          name: safeName,
          size: file.size,
          mime: file.type || 'application/octet-stream',
          batchTotal: job.batchTotal,
          batchIndex: job.batchIndex
        }));

        let offset = 0;
        let lastUiAt = 0;
        const startedAt = performance.now();

        while (offset < file.size) {
          if (activeConn !== conn || !conn.open) {
            throw new Error('Связь прервана');
          }
          const ok = await waitForDrain(conn);
          if (!ok || activeConn !== conn || !conn.open) {
            throw new Error('Канал закрыт');
          }

          const end = Math.min(file.size, offset + config.chunkSize);
          const buffer = await file.slice(offset, end).arrayBuffer();
          conn.send(buffer);
          offset = end;

          const now = performance.now();
          if (now - lastUiAt >= 100 || offset === file.size) {
            lastUiAt = now;
            const elapsedSec = Math.max(0.05, (now - startedAt) / 1000);
            const pct = file.size ? (offset / file.size) * 100 : 100;
            job.entry.setProgress(pct, offset / elapsedSec);
          }
        }

        const ackPromise = waitForAck(fileId);
        conn.send(JSON.stringify({ type: 'file-end', id: fileId }));
        const acked = await ackPromise;
        job.entry.setProgress(100, 0);
        job.entry.setStatus('success', acked ? 'Доставлено' : 'Отправлено');
      } catch (err) {
        job.entry.setStatus('error', err && err.message ? err.message : 'Ошибка');
      }
    }

    isSending = false;
  }

  function queueFiles(rawFiles) {
    const files = Array.from(rawFiles || []);
    if (!files.length) return;
    if (!activeConn || !activeConn.open) {
      showToast('Сначала подключи второе устройство', 'error');
      return;
    }

    const valid = [];
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        showToast(`${sanitizeFilename(file.name)} превышает лимит 300 МБ`, 'error');
      } else {
        valid.push(file);
      }
    }
    if (!valid.length) return;

    const batchTotal = valid.length;
    valid.forEach((file, idx) => {
      const entry = createFileFeedEntry('out', sanitizeFilename(file.name), file.size);
      sendQueue.push({
        file,
        entry,
        batchTotal,
        batchIndex: idx + 1
      });
    });

    processSendQueue();
  }

  function sendQuickText() {
    const text = textInput.value.trim();
    if (!text) return;
    if (!activeConn || !activeConn.open) {
      showToast('Сначала подключи второе устройство', 'error');
      return;
    }
    const clipped = text.slice(0, MAX_TEXT_CHARS);
    try {
      activeConn.send(JSON.stringify({ type: 'text', text: clipped }));
      addTextFeedEntry('out', clipped);
      textInput.value = '';
      sendTextBtn.disabled = true;
    } catch {
      showToast('Не удалось отправить текст', 'error');
    }
  }

  // ---------- Приём входящих сообщений ----------

  function appendBinaryChunk(rawChunk) {
    if (!incomingTransfer) return;
    let buf = null;
    if (rawChunk instanceof ArrayBuffer) {
      buf = rawChunk;
    } else if (ArrayBuffer.isView(rawChunk)) {
      buf = rawChunk.buffer.slice(rawChunk.byteOffset, rawChunk.byteOffset + rawChunk.byteLength);
    } else if (rawChunk instanceof Blob) {
      rawChunk.arrayBuffer().then((ab) => appendBinaryChunk(ab)).catch(() => {});
      return;
    } else {
      return;
    }

    if (incomingTransfer.received + buf.byteLength > MAX_FILE_BYTES) {
      incomingTransfer.entry.setStatus('error', 'Превышен лимит 300 МБ');
      incomingTransfer.chunks = null;
      incomingTransfer = null;
      return;
    }

    incomingTransfer.chunks.push(buf);
    incomingTransfer.received += buf.byteLength;

    const now = performance.now();
    if (now - incomingTransfer.lastUiAt >= 100 || incomingTransfer.received >= incomingTransfer.size) {
      incomingTransfer.lastUiAt = now;
      const elapsedSec = Math.max(0.05, (now - incomingTransfer.startedAt) / 1000);
      const pct = incomingTransfer.size ? (incomingTransfer.received / incomingTransfer.size) * 100 : 100;
      incomingTransfer.entry.setProgress(pct, incomingTransfer.received / elapsedSec);
    }
  }

  function handleControlMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hello') {
      remoteDeviceName = String(msg.device || 'Устройство').slice(0, 24);
      updateConnectedUi(true);
      return;
    }

    if (msg.type === 'busy') {
      showToast('Устройство уже занято другой сессией', 'error');
      const old = activeConn;
      activeConn = null;
      if (old) {
        try { old.close(); } catch {}
      }
      resetConnectionControls();
      updateConnectedUi(false);
      setBadge('', 'Готов');
      return;
    }

    if (msg.type === 'bye') {
      showToast('Собеседник отключился');
      rotateCodeAndReinit();
      return;
    }

    if (msg.type === 'text') {
      const text = String(msg.text || '').trim().slice(0, MAX_TEXT_CHARS);
      if (text) {
        addTextFeedEntry('in', text);
        showToast('Получено сообщение');
      }
      return;
    }

    if (msg.type === 'file-ack') {
      if (pendingAckResolver) pendingAckResolver(msg.id);
      return;
    }

    if (msg.type === 'file-start') {
      const size = Number(msg.size) || 0;
      const safeName = sanitizeFilename(msg.name);
      if (size < 0 || size > MAX_FILE_BYTES) {
        showToast(`Отклонён слишком большой файл: ${safeName}`, 'error');
        return;
      }
      const entry = createFileFeedEntry('in', safeName, size);
      incomingTransfer = {
        id: msg.id,
        name: safeName,
        size,
        mime: String(msg.mime || 'application/octet-stream'),
        batchTotal: Number(msg.batchTotal) || 1,
        chunks: [],
        received: 0,
        startedAt: performance.now(),
        lastUiAt: 0,
        entry
      };
      return;
    }

    if (msg.type === 'file-end') {
      if (!incomingTransfer || incomingTransfer.id !== msg.id) return;
      const done = incomingTransfer;
      incomingTransfer = null;

      const blob = new Blob(done.chunks, { type: done.mime });
      done.chunks = null;
      const objectUrl = URL.createObjectURL(blob);
      const shouldAutoSave = done.batchTotal <= 1 && autoSaveToggle.checked;

      done.entry.attachDownload(objectUrl, shouldAutoSave);
      if (shouldAutoSave) {
        triggerDownload(objectUrl, done.name);
      }

      if (activeConn && activeConn.open) {
        try {
          activeConn.send(JSON.stringify({ type: 'file-ack', id: done.id }));
        } catch {}
      }
    }
  }

  function handleIncomingPayload(raw) {
    if (typeof raw === 'string') {
      try {
        handleControlMessage(JSON.parse(raw));
      } catch {
        // Игнорируем некорректный JSON
      }
      return;
    }
    appendBinaryChunk(raw);
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

  function renderMyQr() {
    qrCodeWrap.replaceChildren();
    if (typeof QRCode === 'undefined') {
      qrCodeWrap.textContent = 'Модуль QR не загрузился';
      return;
    }
    new QRCode(qrCodeWrap, {
      text: buildShareUrl(myCode),
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

  async function stopQrScanner() {
    scannerSessionId += 1;
    if (!qrScanner) return;
    const instance = qrScanner;
    qrScanner = null;
    try {
      if (instance.isScanning) {
        await instance.stop();
      }
    } catch {}
    try {
      await instance.clear();
    } catch {}
  }

  async function startQrScanner() {
    const currentSession = ++scannerSessionId;
    scanStatus.textContent = 'Загрузка сканера…';

    try {
      await loadHtml5QrcodeScript();
      if (currentSession !== scannerSessionId || qrScanPanel.hidden || !qrModal.classList.contains('active')) {
        return;
      }
      if (typeof Html5Qrcode === 'undefined') {
        throw new Error('Сканер недоступен');
      }

      scanStatus.textContent = 'Запуск камеры…';
      qrReader.replaceChildren();
      const instance = new Html5Qrcode('qrReader');
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
          connectToCode(code);
        },
        () => {}
      );

      if (currentSession !== scannerSessionId || qrScanPanel.hidden || !qrModal.classList.contains('active')) {
        await stopQrScanner();
        return;
      }
      scanStatus.textContent = 'Наведи камеру на QR-код второго устройства';
    } catch (err) {
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

  qrCopyLinkBtn.addEventListener('click', () => copyText(buildShareUrl(myCode), 'Ссылка скопирована'));
  copyCodeBtn.addEventListener('click', () => copyText(myCode, 'Код скопирован'));
  copyLinkBtn.addEventListener('click', () => copyText(buildShareUrl(myCode), 'Ссылка скопирована'));

  networkBtn.addEventListener('click', () => {
    turnProxyInput.value = getSessionTurnUrl() || config.turnProxyUrl;
    turnTestStatus.className = 'health-status';
    turnTestStatus.textContent = '';
    updateNetworkUi();
    openModal(networkModal);
  });
  closeNetworkBtn.addEventListener('click', () => closeModal(networkModal));

  applyTurnBtn.addEventListener('click', async () => {
    const val = turnProxyInput.value.trim();
    if (val && !parseSafeHttpUrl(val)) {
      turnTestStatus.className = 'health-status error';
      turnTestStatus.textContent = 'Укажи корректный https:// или http:// адрес';
      return;
    }

    applyTurnBtn.disabled = true;
    turnTestStatus.className = 'health-status';
    turnTestStatus.textContent = val ? 'Проверка TURN-прокси…' : 'Сброс к STUN…';

    setSessionTurnUrl(val);
    const result = await loadIceServers(getEffectiveTurnProxyUrl());
    applyTurnBtn.disabled = false;

    if (!result.ok) {
      turnTestStatus.className = 'health-status error';
      turnTestStatus.textContent = `Ошибка: ${result.error}. Оставлен STUN.`;
      return;
    }

    turnTestStatus.className = 'health-status success';
    turnTestStatus.textContent = result.usedTurn ? 'TURN активен для этой вкладки' : 'Используется STUN';

    if (!activeConn) {
      rotateCodeAndReinit();
    } else {
      showToast('TURN обновлён и применится со следующей сессии');
    }
  });

  resetTurnBtn.addEventListener('click', async () => {
    setSessionTurnUrl('');
    turnProxyInput.value = config.turnProxyUrl;
    const result = await loadIceServers(getEffectiveTurnProxyUrl());
    turnTestStatus.className = 'health-status success';
    turnTestStatus.textContent = result.usedTurn ? 'Возвращён TURN из config.js' : 'Сброшено на STUN';
    if (!activeConn) rotateCodeAndReinit();
  });

  disconnectBtn.addEventListener('click', disconnectSession);
  barDisconnectBtn.addEventListener('click', disconnectSession);

  remoteCodeInput.addEventListener('input', () => {
    const raw = remoteCodeInput.value;
    const digits = raw.replace(/\D+/g, '').slice(0, 6);
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
      connectToCode(remoteCodeInput.value);
    }
  });

  connectBtn.addEventListener('click', () => connectToCode(remoteCodeInput.value));

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

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files) {
      queueFiles(e.dataTransfer.files);
    }
  });

  textInput.addEventListener('input', () => {
    const connected = Boolean(activeConn && activeConn.open);
    sendTextBtn.disabled = !connected || !textInput.value.trim();
  });

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendQuickText();
    }
  });

  sendTextBtn.addEventListener('click', sendQuickText);
  saveAllBtn.addEventListener('click', saveAllPending);
  clearFeedBtn.addEventListener('click', clearFeed);

  // Закрытие модалок по клику на оверлей и Esc
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

  // Глобальный Ctrl+V для файлов/скриншотов и быстрого текста
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
    const isEditing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    if (isEditing) return;

    const text = dt.getData('text');
    if (text && text.trim()) {
      e.preventDefault();
      textInput.value = text.trim();
      textInput.dispatchEvent(new Event('input'));
      textInput.focus();
    }
  });

  window.addEventListener('pagehide', () => {
    stopQrScanner();
    for (const entry of feedEntries) {
      if (entry.objectUrl) {
        try { URL.revokeObjectURL(entry.objectUrl); } catch {}
      }
    }
    if (activeConn && activeConn.open) {
      try { activeConn.send(JSON.stringify({ type: 'bye' })); } catch {}
    }
  });

  // ---------- Старт ----------

  async function boot() {
    const params = new URLSearchParams(location.search);
    const toCode = normalizeCode(params.get('to'));
    if (toCode) {
      pendingAutoConnectCode = toCode;
      history.replaceState(null, '', location.pathname + location.hash);
    }

    renderMyCode();
    updateConnectedUi(false);
    updateFeedControls();

    await loadIceServers(getEffectiveTurnProxyUrl());
    initPeer();
  }

  boot();
}

if (typeof document !== 'undefined') {
  initApp();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateSixDigitCode,
    normalizeCode,
    formatCode,
    extractCodeFromInput,
    sanitizeFilename,
    parseSafeHttpUrl,
    formatSize,
    formatSpeed
  };
}
