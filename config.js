// Публичная конфигурация qdrop-air (без секретов).
globalThis.QDROP_AIR_CONFIG = {
  peerPrefix: 'qdrop-air-',
  // По умолчанию используется публичный 0.peerjs.com.
  // Для своего PeerServer укажите { host: '...', port: 443, path: '/', secure: true }.
  peerServer: null,
  // URL развёрнутого Cloudflare Worker (turn-proxy/worker.js), например:
  // 'https://qdrop-turn-proxy.example.workers.dev'
  turnProxyUrl: '',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  chunkSize: 65536
};
