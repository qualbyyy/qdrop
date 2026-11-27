# qdrop air

Лёгкое P2P-веб-приложение для мгновенной передачи файлов (до 300 МБ), скриншотов (`Ctrl+V`) и короткого текста/ссылок между ПК и смартфоном по 6-значному коду или QR.

## Безопасность и приватность

- **Строго 1-на-1**: пока два устройства связаны, сторонние подключения автоматически отклоняются; после «Отключиться» выдаётся новый 6-значный код.
- **Без следов на учебном ПК**: `localStorage` не используется; временный адрес TURN-прокси хранится только в `sessionStorage` текущей вкладки и исчезает при её закрытии.
- **Скрытие TURN-ключа**: `turn-proxy/worker.js` держит ключ Metered в секретах Cloudflare Worker и проверяет заголовок `Origin`.

## Локальный запуск

```zsh
python3 -m http.server 8000 --directory /home/qualbyy/Проекты/qdrop-air
```

Открой `http://localhost:8000` в двух вкладках (или подключи телефон по локальной сети / HTTPS).

## Публикация на GitHub Pages

1. Создай репозиторий и залей в корень файлы `index.html`, `style.css`, `app.js`, `config.js`, `peerjs.min.js`, `qrcode.min.js`, `html5-qrcode.min.js`.
2. В настройках репозитория включи **Settings → Pages → Deploy from a branch** (`main` / `/(root)`).
3. Если нужен TURN 443 для обхода строгого NAT / блокировки UDP на учебном ПК, укажи URL воркера в `turnProxyUrl` в [config.js](config.js) или временно введи его в модалке **«Сеть»** на конкретную сессию.

## Настройка TURN-прокси (Cloudflare Workers + Metered)

Бесплатный тариф Metered даёт TURN по TLS на порту `443` — это позволяет соединять учебный ПК за жёстким NAT и телефон в 4G/5G.

1. Зарегистрируйся на [metered.ca](https://www.metered.ca/) и скопируй **App Domain** (например, `my-app.metered.live`) и **API Key**.
2. В панели Cloudflare создай новый **Worker** и вставь код из [turn-proxy/worker.js](turn-proxy/worker.js).
3. В **Settings → Variables and Secrets** добавь:
   - `METERED_DOMAIN` — твой домен Metered (например, `my-app.metered.live`)
   - `METERED_API_KEY` *(Secret)* — твой API-ключ Metered
   - `ALLOWED_ORIGIN` — адрес твоего GitHub Pages (например, `https://qualbyy.github.io`)
4. Скопируй URL развёрнутого воркера (`https://...workers.dev`) и вставь его в `turnProxyUrl` в [config.js](config.js) (или используй кнопку **«Сеть»** в интерфейсе).
