# lolzteam

[![CI](https://github.com/teracotaCode/lolzteam-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/teracotaCode/lolzteam-ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Типобезопасная TypeScript-обёртка для API **Lolzteam Forum** и **Market** (Pair / Pair Market). Работает в Node.js и браузерах.

## Установка

```bash
git clone https://github.com/teracotaCode/lolzteam-ts.git
cd lolzteam-ts
npm install
```

> **Node.js ≥ 18** обязателен. Библиотека использует глобальный `fetch` API, доступный начиная с Node 18.
>
> Для продвинутых сценариев (HTTP-прокси, кастомные диспетчеры) установите `undici` как опциональную зависимость:
>
> ```bash
> npm install undici  # опционально, для поддержки прокси
> ```

## Быстрый старт

### Node.js

```ts
import { ForumClient, MarketClient } from "lolzteam";

const forum = new ForumClient({ token: process.env.FORUM_TOKEN! });
const market = new MarketClient({ token: process.env.MARKET_TOKEN! });

// Получаем текущего пользователя
const me = await forum.users.get("me");
console.log(me.user.username);

// Ищем товары на маркете
const items = await market.categorySearch.steam({ pmin: 10 });
console.log(`Найдено ${items.totalItems} товаров`);
```

### Браузер

```ts
import { ForumClient } from "lolzteam";

const forum = new ForumClient({ token: "ваш-токен" });
const user = await forum.users.get("me");
```

> **Примечание:** для работы в браузере потребуется CORS-прокси или бэкенд, проксирующий запросы, так как API Lolzteam не устанавливает CORS-заголовки.

### CommonJS

```js
const { ForumClient, MarketClient } = require("lolzteam");
```

## Конфигурация

```ts
const forum = new ForumClient({
  // Обязательный параметр
  token: "ваш-api-токен",

  // Необязательные — все поля ниже имеют значения по умолчанию
  baseUrl: "https://prod-api.lolz.live",
  timeout: 60_000, // таймаут запроса в мс
});
```

## Поддержка прокси

HTTP/HTTPS/SOCKS-прокси поддерживаются через диспетчеры `undici`:

```ts
import { ForumClient } from "lolzteam";

const forum = new ForumClient({
  token: "ваш-токен",
  proxy: { url: "http://proxy.example.com:8080" },
});

// SOCKS5-прокси
const forumSocks = new ForumClient({
  token: "ваш-токен",
  proxy: { url: "socks5://127.0.0.1:1080" },
});
```

## Настройка повторных попыток

Автоматические повторные попытки с экспоненциальной задержкой при временных сбоях и превышении лимитов:

```ts
const forum = new ForumClient({
  token: "ваш-токен",
  retry: {
    maxRetries: 3,         // макс. количество попыток (по умолчанию: 3)
    baseDelay: 1000,       // начальная задержка в мс (по умолчанию: 1000)
    maxDelay: 30_000,      // макс. задержка в мс (по умолчанию: 30000)
    retryStatuses: new Set([429, 502, 503, 504]),  // коды статусов для повтора
  },
});
```

Клиент автоматически повторяет запросы при:

- **429** Too Many Requests (учитывает заголовок `Retry-After`)
- **502, 503, 504** — ошибки сервера
- Временные сетевые ошибки (сброс соединения, ошибки DNS, таймауты)

## Обработка ошибок

```ts
import { ForumClient, LolzteamError, RateLimitError, HttpError } from "lolzteam";

const forum = new ForumClient("ваш-токен");

try {
  const user = await forum.users.get(123);
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log(`Превышен лимит запросов — повтор через ${error.retryAfter} сек.`);
  } else if (error instanceof HttpError) {
    console.log(`HTTP ${error.statusCode}: ${error.message}`);
  } else if (error instanceof LolzteamError) {
    console.log(`Ошибка API: ${error.message}`);
  } else {
    throw error;
  }
}
```

## Поддержка ESM и CJS

Пакет поставляется с билдами **ES Modules** и **CommonJS**. Нужный формат выбирается автоматически в зависимости от конфигурации вашего проекта:

| Тип проекта | Точка входа |
| --- | --- |
| `"type": "module"` или `.mjs` | `dist/esm/index.js` |
| `"type": "commonjs"` или `.cjs` | `dist/cjs/index.js` |

TypeScript-типы включены для обоих форматов.

## Требования

- **Node.js** ≥ 18.0.0
- **TypeScript** ≥ 5.0 (только для проверки типов — не является runtime-зависимостью)

## Лицензия

[MIT](./LICENSE) © 2026 Lolzteam API Contributors
