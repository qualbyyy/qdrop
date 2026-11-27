'use strict';

const crypto = require('node:crypto');

const S3_HOST = 'storage.yandexcloud.net';
const S3_REGION = 'ru-central1';
const S3_SERVICE = 's3';
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const MAX_TEXT_CHARS = 32768;
const UPLOAD_TTL_SEC = 300;
const DOWNLOAD_TTL_SEC = 120;
const UNJOINED_ROOM_TTL_MS = 10 * 60 * 1000;
const MAX_ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ROOM_FILES = 50;
const MAX_ROOM_EVENTS = 200;
const MAX_ROOM_BYTES = 500 * 1024 * 1024;
const DAILY_QUOTA_BYTES = 3 * 1024 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_JOIN = 10;
const RATE_LIMIT_GENERAL = 90;

const rateBuckets = new Map();

// ---------- Безопасность и утилиты ----------

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function timingSafeHexEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return Array.isArray(v) ? String(v[0] || '') : String(v || '');
    }
  }
  return '';
}

function isAllowedOrigin(origin, env = process.env) {
  if (!origin || typeof origin !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (
    String(env.ALLOW_LOCALHOST || '').toLowerCase() === 'true' &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return true;
  }
  const allowed = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return allowed.includes(parsed.origin);
}

function checkRateLimit(ip, bucketName, limit, now = Date.now()) {
  const key = `${bucketName}:${ip || 'unknown'}`;
  const cutoff = now - RATE_WINDOW_MS;
  let list = rateBuckets.get(key) || [];
  list = list.filter((ts) => ts > cutoff);
  if (list.length >= limit) {
    rateBuckets.set(key, list);
    return false;
  }
  list.push(now);
  rateBuckets.set(key, list);
  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets.entries()) {
      if (!v.length || v[v.length - 1] <= cutoff) rateBuckets.delete(k);
    }
  }
  return true;
}

function generateSixDigitCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function normalizeCode(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  return digits.length === 6 ? digits : '';
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

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function randomId() {
  return crypto.randomBytes(8).toString('hex');
}

function rfc3986Encode(str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Path(key) {
  return String(key).split('/').map(rfc3986Encode).join('/');
}

function formatAmzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function deriveSigningKey(secretKey, dateStamp) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, S3_REGION);
  const kService = hmac(kRegion, S3_SERVICE);
  return hmac(kService, 'aws4_request');
}

function buildCanonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(params[k])}`)
    .join('&');
}

// ---------- AWS Signature V4 для Yandex Object Storage ----------

function createPresignedUrl({ method, bucket, key, accessKey, secretKey, expiresSec, contentLength, downloadFilename, now = new Date() }) {
  const { amzDate, dateStamp } = formatAmzDate(now);
  const credentialScope = `${dateStamp}/${S3_REGION}/${S3_SERVICE}/aws4_request`;
  const canonicalUri = `/${rfc3986Encode(bucket)}/${encodeS3Path(key)}`;

  const headerMap = { host: S3_HOST };
  if (contentLength !== undefined && contentLength !== null) {
    headerMap['content-length'] = String(contentLength);
  }
  const signedHeaderNames = Object.keys(headerMap).sort();
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headerMap[h]}\n`).join('');

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': signedHeaders
  };
  if (downloadFilename) {
    const safeAscii = sanitizeFilename(downloadFilename).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    const utf8Encoded = rfc3986Encode(sanitizeFilename(downloadFilename));
    query['response-content-disposition'] = `attachment; filename="${safeAscii}"; filename*=UTF-8''${utf8Encoded}`;
  }

  const canonicalQuery = buildCanonicalQuery(query);
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(deriveSigningKey(secretKey, dateStamp), stringToSign).toString('hex');

  return `https://${S3_HOST}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function s3Request({ method, bucket, key = '', query = {}, body = '', contentType = '', accessKey, secretKey, fetchImpl = fetch }) {
  const { amzDate, dateStamp } = formatAmzDate();
  const credentialScope = `${dateStamp}/${S3_REGION}/${S3_SERVICE}/aws4_request`;
  const canonicalUri = key ? `/${rfc3986Encode(bucket)}/${encodeS3Path(key)}` : `/${rfc3986Encode(bucket)}`;
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
  const payloadHash = sha256Hex(bodyBuf);

  const headers = {
    host: S3_HOST,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  if (contentType) headers['content-type'] = contentType;

  const signedHeaderNames = Object.keys(headers).sort();
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalQuery = buildCanonicalQuery(query);
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(deriveSigningKey(secretKey, dateStamp), stringToSign).toString('hex');

  const fetchHeaders = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
  if (contentType) fetchHeaders['content-type'] = contentType;

  const url = `https://${S3_HOST}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetchImpl(url, {
      method,
      headers: fetchHeaders,
      body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : bodyBuf,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function s3GetJson(ctx, key) {
  const res = await s3Request({ ...ctx, method: 'GET', key });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`S3 GET ${res.status}`);
  return res.json();
}

async function s3PutJson(ctx, key, obj) {
  const res = await s3Request({
    ...ctx,
    method: 'PUT',
    key,
    body: JSON.stringify(obj),
    contentType: 'application/json; charset=utf-8'
  });
  if (!res.ok) throw new Error(`S3 PUT ${res.status}`);
}

async function s3ListKeys(ctx, prefix) {
  const res = await s3Request({
    ...ctx,
    method: 'GET',
    key: '',
    query: { 'list-type': '2', prefix }
  });
  if (!res.ok) throw new Error(`S3 LIST ${res.status}`);
  const xml = await res.text();
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    keys.push(m[1]);
  }
  return keys.sort();
}

async function s3DeletePrefix(ctx, prefix) {
  const keys = await s3ListKeys(ctx, prefix);
  await Promise.all(keys.map((k) => s3Request({ ...ctx, method: 'DELETE', key: k }).catch(() => {})));
  return keys.length;
}

// ---------- HTTP-ответ и логика комнат ----------

function response(statusCode, bodyObj, corsHeaders = {}, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders,
      ...extraHeaders
    },
    body: bodyObj === null ? '' : JSON.stringify(bodyObj)
  };
}

function authorizeParticipant(meta, token) {
  if (!meta || !token || typeof token !== 'string') return null;
  const hash = sha256Hex(token);
  if (meta.hostTokenHash && timingSafeHexEqual(meta.hostTokenHash, hash)) return 'host';
  if (meta.guestTokenHash && timingSafeHexEqual(meta.guestTokenHash, hash)) return 'guest';
  return null;
}

function checkAccessKey(body, env) {
  const requiredKey = String(env.ACCESS_KEY || '').trim();
  if (!requiredKey) return true;
  const provided = String((body && body.accessKey) || '').trim();
  if (!provided) return false;
  return timingSafeHexEqual(sha256Hex(requiredKey), sha256Hex(provided));
}

function isRoomExpired(meta, now = Date.now()) {
  if (!meta || !meta.createdAt) return true;
  const age = now - Number(meta.createdAt);
  if (!meta.guestTokenHash && age > UNJOINED_ROOM_TTL_MS) return true;
  return age > MAX_ROOM_TTL_MS;
}

function todayQuotaKey(now = new Date()) {
  return `rooms/_quota/${now.toISOString().slice(0, 10)}.json`;
}

async function handler(event, _context, overrides = {}) {
  const env = overrides.env || process.env;
  const fetchImpl = overrides.fetchImpl || fetch;
  const method = String((event && event.httpMethod) || 'GET').toUpperCase();
  const origin = getHeader(event && event.headers, 'origin');
  const allowed = isAllowedOrigin(origin, env);
  const corsHeaders = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};

  if (method === 'OPTIONS') {
    if (!allowed) return response(403, { error: 'Origin not allowed' });
    return response(204, null, corsHeaders, {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
  }

  if (method !== 'POST') {
    return response(405, { error: 'Method not allowed' }, corsHeaders);
  }
  if (!allowed) {
    return response(403, { error: 'Origin not allowed' });
  }

  const bucket = String(env.YC_BUCKET || '').trim();
  const accessKey = String(env.YC_ACCESS_KEY_ID || '').trim();
  const secretKey = String(env.YC_SECRET_ACCESS_KEY || '').trim();
  if (!bucket || !accessKey || !secretKey) {
    return response(500, { error: 'Relay is not configured' }, corsHeaders);
  }

  let body;
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : String(event.body || '');
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return response(400, { error: 'Invalid JSON body' }, corsHeaders);
  }

  const action = String(body.action || '');
  const sourceIp = (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) || 'unknown';
  const isAuthAction = action === 'create' || action === 'join';
  if (!checkRateLimit(sourceIp, isAuthAction ? 'auth' : 'gen', isAuthAction ? RATE_LIMIT_JOIN : RATE_LIMIT_GENERAL)) {
    return response(429, { error: 'Too many requests' }, corsHeaders, { 'Retry-After': '60' });
  }

  const ctx = { bucket, accessKey, secretKey, fetchImpl };

  try {
    if (action === 'create') {
      if (!checkAccessKey(body, env)) {
        return response(401, { error: 'Invalid access key' }, corsHeaders);
      }
      const device = String(body.device || 'Устройство').slice(0, 24);
      let code = '';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = generateSixDigitCode();
        const existing = await s3GetJson(ctx, `rooms/${candidate}/meta.json`);
        if (!existing || existing.closed || isRoomExpired(existing)) {
          if (existing) await s3DeletePrefix(ctx, `rooms/${candidate}/`).catch(() => {});
          code = candidate;
          break;
        }
      }
      if (!code) return response(503, { error: 'Could not allocate room code' }, corsHeaders);

      const token = randomToken();
      const meta = {
        code,
        hostTokenHash: sha256Hex(token),
        guestTokenHash: null,
        hostDevice: device,
        guestDevice: null,
        createdAt: Date.now(),
        fileCount: 0,
        eventCount: 0,
        totalBytes: 0,
        closed: false
      };
      await s3PutJson(ctx, `rooms/${code}/meta.json`, meta);
      return response(200, { code, token, role: 'host' }, corsHeaders);
    }

    if (action === 'join') {
      const code = normalizeCode(body.code);
      if (!code) return response(400, { error: 'Invalid room code' }, corsHeaders);

      const meta = await s3GetJson(ctx, `rooms/${code}/meta.json`);
      if (!meta || meta.closed) {
        return response(404, { error: 'Room not found' }, corsHeaders);
      }
      if (isRoomExpired(meta)) {
        await s3DeletePrefix(ctx, `rooms/${code}/`).catch(() => {});
        return response(404, { error: 'Room expired' }, corsHeaders);
      }
      if (meta.guestTokenHash) {
        return response(409, { error: 'Room is busy' }, corsHeaders);
      }

      const token = randomToken();
      meta.guestTokenHash = sha256Hex(token);
      meta.guestDevice = String(body.device || 'Устройство').slice(0, 24);
      meta.joinedAt = Date.now();
      await s3PutJson(ctx, `rooms/${code}/meta.json`, meta);

      return response(200, { code, token, role: 'guest', peerDevice: meta.hostDevice }, corsHeaders);
    }

    // Все остальные действия требуют валидный code + token участника
    const code = normalizeCode(body.code);
    const token = String(body.token || '');
    if (!code || !token) return response(401, { error: 'Missing room credentials' }, corsHeaders);

    const meta = await s3GetJson(ctx, `rooms/${code}/meta.json`);
    if (!meta) return response(404, { error: 'Room closed' }, corsHeaders);

    const role = authorizeParticipant(meta, token);
    if (!role) return response(403, { error: 'Invalid room token' }, corsHeaders);

    if (action === 'close') {
      meta.closed = true;
      await s3PutJson(ctx, `rooms/${code}/meta.json`, meta).catch(() => {});
      const deleted = await s3DeletePrefix(ctx, `rooms/${code}/`);
      return response(200, { ok: true, deleted }, corsHeaders);
    }

    if (meta.closed) {
      return response(200, { closed: true, connected: false, events: [] }, corsHeaders);
    }

    if (isRoomExpired(meta)) {
      await s3DeletePrefix(ctx, `rooms/${code}/`).catch(() => {});
      if (action === 'poll') {
        return response(200, { closed: true, expired: true, connected: false, events: [] }, corsHeaders);
      }
      return response(404, { error: 'Room expired' }, corsHeaders);
    }

    if (action === 'poll') {
      const cursor = String(body.cursor || '');
      const connected = Boolean(meta.guestTokenHash);
      if (!connected) {
        return response(200, { closed: false, connected: false, peerDevice: null, events: [], cursor }, corsHeaders);
      }

      const eventPrefix = `rooms/${code}/events/`;
      const keys = await s3ListKeys(ctx, eventPrefix);
      const newKeys = cursor ? keys.filter((k) => k > cursor) : keys;

      const events = [];
      for (const k of newKeys.slice(0, 30)) {
        const ev = await s3GetJson(ctx, k);
        if (!ev) continue;
        const item = { ...ev, cursor: k };
        if (ev.kind === 'file' && ev.fileKey && ev.sender !== role) {
          item.downloadUrl = createPresignedUrl({
            method: 'GET',
            bucket,
            key: ev.fileKey,
            accessKey,
            secretKey,
            expiresSec: DOWNLOAD_TTL_SEC,
            downloadFilename: ev.name
          });
        }
        events.push(item);
      }

      const peerDevice = role === 'host' ? meta.guestDevice : meta.hostDevice;
      const nextCursor = events.length ? events[events.length - 1].cursor : cursor;
      return response(200, { closed: false, connected, peerDevice: peerDevice || null, events, cursor: nextCursor }, corsHeaders);
    }

    if (action === 'send-text') {
      if (!meta.guestTokenHash) return response(409, { error: 'Peer not connected' }, corsHeaders);
      if ((meta.eventCount || 0) >= MAX_ROOM_EVENTS) {
        return response(429, { error: 'Room event limit reached' }, corsHeaders);
      }
      const text = String(body.text || '').trim().slice(0, MAX_TEXT_CHARS);
      if (!text) return response(400, { error: 'Empty text' }, corsHeaders);

      const id = `${Date.now()}-${randomId()}`;
      const evKey = `rooms/${code}/events/${id}.json`;
      await s3PutJson(ctx, evKey, { id, kind: 'text', sender: role, text, ts: Date.now() });
      meta.eventCount = (meta.eventCount || 0) + 1;
      await s3PutJson(ctx, `rooms/${code}/meta.json`, meta);
      return response(200, { ok: true, id, cursor: evKey }, corsHeaders);
    }

    if (action === 'presign-upload') {
      if (!meta.guestTokenHash) return response(409, { error: 'Peer not connected' }, corsHeaders);
      const size = Number(body.size);
      if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
        return response(413, { error: 'File size exceeds 300 MB limit' }, corsHeaders);
      }
      if ((meta.fileCount || 0) >= MAX_ROOM_FILES) {
        return response(429, { error: 'Room file limit reached' }, corsHeaders);
      }
      if ((meta.totalBytes || 0) + size > MAX_ROOM_BYTES) {
        return response(413, { error: 'Room total size limit (500 MB) reached' }, corsHeaders);
      }

      const quotaKey = todayQuotaKey();
      const quota = (await s3GetJson(ctx, quotaKey)) || { bytes: 0, uploads: 0 };
      if ((quota.bytes || 0) + size > DAILY_QUOTA_BYTES) {
        return response(503, { error: 'Daily service traffic limit (3 GB) reached' }, corsHeaders);
      }

      quota.bytes = (quota.bytes || 0) + size;
      quota.uploads = (quota.uploads || 0) + 1;
      await s3PutJson(ctx, quotaKey, quota);

      meta.fileCount = (meta.fileCount || 0) + 1;
      meta.totalBytes = (meta.totalBytes || 0) + size;
      await s3PutJson(ctx, `rooms/${code}/meta.json`, meta);

      const fileId = `${Date.now()}-${randomId()}`;
      const fileKey = `rooms/${code}/files/${fileId}`;
      const uploadUrl = createPresignedUrl({
        method: 'PUT',
        bucket,
        key: fileKey,
        accessKey,
        secretKey,
        expiresSec: UPLOAD_TTL_SEC,
        contentLength: size
      });
      return response(200, { fileId, fileKey, uploadUrl }, corsHeaders);
    }

    if (action === 'commit-file') {
      if (!meta.guestTokenHash) return response(409, { error: 'Peer not connected' }, corsHeaders);
      if ((meta.eventCount || 0) >= MAX_ROOM_EVENTS) {
        return response(429, { error: 'Room event limit reached' }, corsHeaders);
      }
      const fileId = String(body.fileId || '').replace(/[^a-zA-Z0-9-]/g, '');
      const name = sanitizeFilename(body.name);
      const size = Number(body.size) || 0;
      if (!fileId || size < 0 || size > MAX_FILE_BYTES) {
        return response(400, { error: 'Invalid file metadata' }, corsHeaders);
      }
      const fileKey = `rooms/${code}/files/${fileId}`;
      const evKey = `rooms/${code}/events/${fileId}.json`;
      await s3PutJson(ctx, evKey, {
        id: fileId,
        kind: 'file',
        sender: role,
        name,
        size,
        mime: String(body.mime || 'application/octet-stream').slice(0, 120),
        fileKey,
        batchTotal: Math.max(1, Number(body.batchTotal) || 1),
        batchIndex: Math.max(1, Number(body.batchIndex) || 1),
        ts: Date.now()
      });
      meta.eventCount = (meta.eventCount || 0) + 1;
      await s3PutJson(ctx, `rooms/${code}/meta.json`, meta);
      return response(200, { ok: true, id: fileId, cursor: evKey }, corsHeaders);
    }

    if (action === 'presign-download') {
      if (!meta.guestTokenHash) return response(409, { error: 'Peer not connected' }, corsHeaders);
      const rawKey = String(body.fileKey || '').trim();
      const expectedPrefix = `rooms/${code}/files/`;
      const fileId = rawKey.startsWith(expectedPrefix) ? rawKey.slice(expectedPrefix.length) : '';
      if (!fileId || !/^[a-zA-Z0-9-]+$/.test(fileId)) {
        return response(400, { error: 'Invalid file key' }, corsHeaders);
      }
      const name = sanitizeFilename(body.name);
      const downloadUrl = createPresignedUrl({
        method: 'GET',
        bucket,
        key: `${expectedPrefix}${fileId}`,
        accessKey,
        secretKey,
        expiresSec: DOWNLOAD_TTL_SEC,
        downloadFilename: name
      });
      return response(200, { downloadUrl, expiresIn: DOWNLOAD_TTL_SEC }, corsHeaders);
    }

    return response(400, { error: 'Unknown action' }, corsHeaders);
  } catch {
    return response(502, { error: 'Storage backend error' }, corsHeaders);
  }
}

module.exports = {
  handler,
  isAllowedOrigin,
  createPresignedUrl,
  sanitizeFilename,
  _resetRateLimits: () => rateBuckets.clear()
};
