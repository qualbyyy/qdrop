# AGENTS.md — qdrop-air

## Назначение и архитектура
- **Цель**: быстрый обмен файлами (до 300 МБ) и текстом/ссылками 1-на-1 между ПК (проводная сеть) и смартфоном (4G/5G) поверх HTTPS `:443`.
- **Фронтенд** (`index.html`, `style.css`, `app.js`, `config.js`): чистый HTML/CSS/JS без сборщиков и фреймворков, опубликован на GitHub Pages (`https://qualbyyy.github.io/qdrop/`).
- **Бэкенд** (`cloud-relay/index.js`): одна Yandex Cloud Function (`nodejs22`, zero-dep CommonJS, AWS SigV4 на `node:crypto`) + приватный бакет Yandex Object Storage (`ru-central1`).
- **Поток данных**: браузер получает от функции pre-signed `PUT`/`GET` URL (TTL 5 / 2 мин) и качает/загружает файлы напрямую в Object Storage стримингом (`XMLHttpRequest PUT`), без загрузки 300 МБ в RAM.
- **Экономия и квоты**: дневной лимит трафика сервиса **3 ГБ/сутки** (`rooms/_quota/YYYY-MM-DD.json`), на комнату — макс. **500 МБ / 50 файлов / 200 событий**, TTL пустой комнаты **10 мин**, активной **2 часа**, `poll` в режиме ожидания пропускает S3 `LIST`; адаптивный поллинг фронтенда — `2000 мс` в паре / `3000 мс` в ожидании / `8000 мс` в скрытой вкладке.
- **Доступ и связка**:
  - Единый групповой `ACCESS_KEY` хранится только в Yandex Lockbox (никогда в git) и проверяется только при создании комнаты (`create`); подключение второго устройства (`join`) работает без пароля.
  - Magic-link `#key=...`: ключ считывается в `sessionStorage` (`qdrop_air_access_key`) и сразу удаляется из адресной строки через `history.replaceState`.
  - Если ключ отсутствует (`401`), модалка «Код доступа» открывается сразу; в ней только поле пароля (без Relay URL и лишних статусов).
  - Связка в карточке комнаты идёт через одну кнопку **QR** (`openQrActionBtn`, без отдельных кнопок копирования кода/ссылки); модалка QR автоматически закрывается после подключения с обеих сторон.
- **Инфраструктура**: управляется через локальный MCP-сервер `yandex-cloud` (ID каталога, функции, бакета и сервисных аккаунтов не хардкодятся в репозитории — получать через `yc_functions_list`, `yc_storage_list_buckets`, `yc_lockbox_list_secrets`).

## Жёсткие инварианты
- **UI и вёрстка**:
  - iOS-стиль (`#f2f2f7` фон, `#ffffff` карточки `r=26px`, зелёный акцент `qdrop` `#4a7a6d`, `Inter` / системный SF Pro, Liquid Glass-кнопки, компактный переключатель автосохранения `50×28px`).
  - Адаптивная 2-колоночная десктопная вёрстка (`@media (min-width: 860px)`, `max-width: 980px`: рабочая зона слева, передачи справа).
  - Только SVG-иконки (ноль эмодзи); без `innerHTML`, `localStorage`, нативных `alert`/`confirm`/`select`; все модалки закрываются по `Esc` и клику на фон; ссылки только `http:` / `https:`.
  - Поле пароля (`#accessKeyInput`) изолировано в `<form id="accessKeyForm" autocomplete="off">` с `autocomplete="new-password"`, а `#textInput` имеет `autocomplete="off" data-lpignore="true" data-1p-ignore`, чтобы менеджеры паролей не автозаполняли поле отправки текста.
- **Камера (QR-сканер)**: строгий жизненный цикл (`releaseCameraTracks()`) — все `MediaStreamTrack` останавливаются при закрытии модалки, переключении вкладки, скрытии страницы (`visibilitychange`), успешном сканировании, подключении пары и отмене гонки запуска `start()`.
- **Секреты**: в git хранятся только фронтенд, `config.js` (публичный URL функции) и `cloud-relay/index.js`. Статические S3-ключи (`YC_ACCESS_KEY_ID`, `YC_SECRET_ACCESS_KEY`) и `ACCESS_KEY` передаются в функцию исключительно через Yandex Lockbox.
- **Изоляция Yandex Cloud**:
  - У сервисного аккаунта функции (`qdrop-air-relay`) **ноль ролей на каталог**.
  - Доступ к S3 ограничен ACL + Bucket Policy только на `rooms/*` своего бакета (квота 1 ГБ, lifecycle автоудаление `rooms/` через 1 день, анонимный доступ выключен).
  - Доступ к Lockbox (`lockbox.payloadViewer`) выдан только на два секрета функции (S3-ключи и `ACCESS_KEY`).
  - CORS функции и бакета зафиксированы на `https://qualbyyy.github.io` (`ALLOW_LOCALHOST=false` в проде).
- **Железо (3.6 GiB RAM)**: клиентское шифрование 300 МБ целиком в памяти не добавлять; при запуске Node-инструментов использовать `NODE_OPTIONS="--max-old-space-size=512"`.

## Проверка и публикация
- Перед коммитом: `node --check app.js && node --check config.js && node --check cloud-relay/index.js` + проверка диффа на отсутствие секретов и внутренних ID.
- Деплой функции: обновлять через `yandex-cloud` MCP (`cloud-relay/index.js` → entrypoint `index.handler`) с привязкой к Lockbox, без записи ключей в env напрямую.
- Публикация фронтенда: только по явному подтверждению пользователя (`git push` в `qualbyyy/qdrop`, ветка `main`).
