# Stepik Course Archiver

Веб-приложение для полной выгрузки курсов Stepik в ZIP/TAR.GZ архивы. Включает теорию, видео, задания, тесты, правильные ответы, комментарии, отзывы и метаданные автора.

## Возможности

### Скачивание
- **Текст теории** — в Markdown (через html2text) + исходный HTML
- **Видео** — через yt-dlp с субтитрами или прямые URL из API
- **Тесты (choice)** — варианты ответов + правильные ответы (с токеном)
- **Задачи code/SQL/sorting/matching** — полные условия, тест-кейсы, эталонные решения
- **Комментарии** — все обсуждения шагов с деревом ответов
- **Отзывы о курсе** — рейтинги, тексты, ответы автора
- **Информация об авторе** — биография, аватар, ссылки
- **Картинки и вложения** — все медиа-файлы шагов
- **Поисковый индекс** — `_search_index.json` для полнотекстового поиска
- **PDF-сборник** — все шаги в одном PDF с оглавлением (опционально)

### Авторизация
- **Personal Token** — Permanent access token с stepik.org/edit-profile/tokens
- **OAuth2 App** — Client ID + Client Secret (client-credentials flow)
- **Кэширование токена** — 10 часов в памяти сервера

### UI
- Тёмная/светлая тема
- Превью курса перед запуском
- Прогресс в реальном времени (секции/уроки/шаги)
- Диалог просмотра содержимого архива
- Адаптивный polling (1s при активной задаче, 5s в покое)
- Поиск по задачам
- Очередь задач с авто-запуском

### Backend
- Streaming downloads с поддержкой Range requests
- SSE endpoint для real-time прогресса
- Health check endpoint
- Auto-cleanup старых задач (хранит последние 30)
- Stale detection (зависшие задачи > 2 часов)
- Race condition защита (write locks)
- Archive integrity verification (zipfile.testzip / tarfile)

### Python скрипт
- QRATOR bypass (Connection: close + browser User-Agent)
- 8 ретраев с экспоненциальной задержкой (1s → 120s)
- Многопоточная обработка шагов (3 потока)
- Resume capability (пропуск уже скачанных шагов)
- Uploadcare 403 retry (3 попытки)
- Авто-определение расширений файлов по content-type и магическим байтам
- Rate limiting (100ms между API запросами)

## Технологии

- **Frontend**: Next.js 16, React 19, TypeScript 5, Tailwind CSS 4, shadcn/ui
- **Backend**: Next.js API Routes (Node.js runtime), TypeScript
- **Python**: Python 3.12, requests, html2text, yt-dlp
- **PDF**: pandoc + weasyprint
- **Icons**: Lucide React

## Структура проекта

```
├── scripts/
│   └── stepik_course_dump.py      # Python скрипт выгрузки (1598 строк)
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── health/route.ts           # Health check
│   │   │   ├── jobs/route.ts             # Список/создание задач
│   │   │   ├── jobs/[id]/route.ts        # GET/DELETE задача
│   │   │   ├── jobs/[id]/download/route.ts  # Streaming download
│   │   │   ├── jobs/[id]/preview/route.ts   # Превью архива
│   │   │   ├── jobs/[id]/retry/route.ts     # Перезапуск
│   │   │   ├── jobs/[id]/stream/route.ts     # SSE прогресс
│   │   │   └── preview/route.ts             # Превью курса
│   │   ├── layout.tsx                    # Root layout с ThemeProvider
│   │   └── page.tsx                      # Главная страница (1474 строки)
│   ├── lib/
│   │   ├── jobs.ts                      # Job manager (558 строк)
│   │   ├── stepik.ts                    # Stepik API client
│   │   └── utils.ts                     # Утилиты
│   └── components/                       # shadcn/ui компоненты
├── prisma/
│   └── schema.prisma                    # БД схема
├── package.json
└── tsconfig.json
```

## Установка

### Требования
- Node.js 18+ и Bun
- Python 3.10+
- yt-dlp (для видео)
- pandoc и weasyprint (для PDF, опционально)

### Быстрый старт

```bash
# Установка зависимостей
bun install

# Установка Python зависимостей
pip install requests html2text yt-dlp

# Запуск dev сервера
bun run dev

# Откройте http://localhost:3000
```

### Запуск Python скрипта напрямую

```bash
# Анонимно (только публичные уроки)
python3 scripts/stepik_course_dump.py --course-id 207061

# С personal token
STEPIC_TOKEN=your_token python3 scripts/stepik_course_dump.py --course-id 207061

# С OAuth2 приложением
python3 scripts/stepik_course_dump.py \
  --client-id YOUR_ID \
  --client-secret YOUR_SECRET \
  --course-id 207061

# С видео и PDF
python3 scripts/stepik_course_dump.py \
  --client-id YOUR_ID \
  --client-secret YOUR_SECRET \
  --course-id 207061 \
  --build-pdf

# ZIP формат (по умолчанию)
python3 scripts/stepik_course_dump.py --course-id 207061

# tar.gz формат
python3 scripts/stepik_course_dump.py --course-id 207061 --zip false
```

### CLI аргументы

| Аргумент | Описание | По умолчанию |
|----------|----------|-------------|
| `--course-id` | ID курса Stepik | 207061 |
| `--out` | Директория для архивов | /home/z/my-project/download |
| `--token` | Personal access token | из STEPIC_TOKEN env |
| `--client-id` | OAuth2 Client ID | из STEPIC_CLIENT_ID env |
| `--client-secret` | OAuth2 Client Secret | из STEPIC_CLIENT_SECRET env |
| `--no-video` | Пропустить видео | false |
| `--no-yt-dlp` | Прямые URL вместо yt-dlp | false |
| `--no-sources` | Пропустить step-sources (ответы/тесты) | false |
| `--no-html` | Не сохранять исходный HTML | false |
| `--no-subtitles` | Не скачивать субтитры | false |
| `--no-comments` | Пропустить комментарии | false |
| `--no-reviews` | Пропустить отзывы | false |
| `--no-instructors` | Пропустить биографию автора | false |
| `--no-search-index` | Не строить поисковый индекс | false |
| `--build-pdf` | Сгенерировать PDF-сборник | false |
| `--zip` | ZIP формат (по умолчанию) | true |

## Структура архива

```
stepik_course_207061_COURSE_TITLE.zip
├── _course_meta.json           # Метаданные курса
├── _course_index.json          # Дерево курса с URL шагов
├── _cover.jpg                  # Обложка курса
├── _instructor_01_AUTHOR.md    # Биография автора
├── _reviews.md                 # Отзывы о курсе
├── _search_index.json          # Поисковый индекс
├── _course_book.pdf            # PDF-сборник (опционально)
├── _REPORT.txt                 # Отчёт о выгрузке
├── 01_Section_Name/
│   ├── 01_Lesson_Title/
│   │   ├── _lesson_meta.json
│   │   ├── 01_text/
│   │   │   ├── step.md          # Markdown текста
│   │   │   ├── step.html        # Исходный HTML
│   │   │   ├── step.json        # Полная структура из API
│   │   │   ├── source.json      # step-sources (ответы/тесты)
│   │   │   ├── attachments/     # Картинки и файлы
│   │   │   └── comments/       # Комментарии шага
│   │   ├── 02_choice/
│   │   │   ├── step.md          # С правильными ответами [x]
│   │   │   └── ...
│   │   └── 03_code/
│   │       ├── step.md          # Условие + шаблон кода
│   │       └── source.json      # Эталонные тесты
│   └── ...
└── ...
```

## API Endpoints

| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/api/health` | Проверка состояния системы |
| GET | `/api/jobs` | Список всех задач |
| POST | `/api/jobs` | Создать и запустить задачу |
| GET | `/api/jobs/[id]` | Статус задачи + лог |
| DELETE | `/api/jobs/[id]` | Остановить/удалить задачу |
| GET | `/api/jobs/[id]/download` | Скачать архив (streaming + Range) |
| GET | `/api/jobs/[id]/preview` | Дерево содержимого архива |
| GET | `/api/jobs/[id]/stream` | SSE для real-time прогресса |
| POST | `/api/jobs/[id]/retry` | Перезапустить задачу |
| POST | `/api/preview` | Превью курса по URL |

## Лицензия

MIT
