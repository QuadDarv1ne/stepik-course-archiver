#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stepik_course_dump.py — Полная выгрузка курса Stepik в архив.

Что выгружает:
  • Текст теории и условий задач — в Markdown (через html2text) + исходный HTML
  • Все изображения шага (Uploadcare CDN)
  • Прикреплённые файлы шага (attachments из block.options.attachments)
  • Видео шага — через yt-dlp (с субтитрами) или прямые URL
  • Субтитры видео отдельно (.vtt)
  • Для choice-вопросов: варианты ответов + правильные ответы (если есть токен)
  • Для code-задач: шаблон кода, sample-тесты, лимиты времени/памяти,
    эталонные тест-кейсы (если есть токен через step-sources)
  • Для number/string/math — структура задачи
  • Для sql/sorting/matching/pycharm/linux-terminal/fill/dataset — полная структура
  • Мета-информация об обсуждениях (количество, ссылки на веб)
  • course_index.json — полное дерево курса в одном файле
  • Все шаги в структурированном виде: каждый шаг сохраняется как .md + .json

Использование:
  STEPIC_TOKEN=<token> python3 stepik_course_dump.py
  STEPIC_TOKEN=<token> python3 stepik_course_dump.py --course-id 207061 --no-video
"""

from __future__ import annotations

import os
import re
import sys
import json
import time
import shutil
import logging
import argparse
import subprocess
from pathlib import Path
from urllib.parse import urlparse

import requests
from concurrent.futures import ThreadPoolExecutor

try:
    import html2text
    _H2T = html2text.HTML2Text()
    _H2T.body_width = 0           # не переносить строки
    _H2T.unicode_snob = True      # не превращать кириллицу в entities
    _H2T.protect_links = True
    _H2T.images_to_alt = False
    _H2T.mark_code = True         # сохраняет <pre><code> как ```...```
    def html_to_md(html: str) -> str:
        return _H2T.handle(html or "").strip()
except ImportError:
    def html_to_md(html: str) -> str:
        s = re.sub(r"<(br|/p|/h\d|/li|/div)>", "\n", html or "", flags=re.I)
        s = re.sub(r"<[^>]+>", "", s)
        return s.strip()


# ─────────────────────────────────────────────────────────────────────────────
API = "https://stepik.org/api"
OAUTH_URL = "https://stepik.org/oauth2/token/"
DEFAULT_COURSE_ID = 207061
DEFAULT_OUT = Path("/home/z/my-project/download")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("stepik")


# ─────────────────────────────────────────────────────────────────────────────
# OAuth2 client-credentials: обмен client_id+client_secret на access_token.

def get_oauth_token(client_id: str, client_secret: str) -> str | None:
    """Обменять client_id + client_secret на access_token (client-credentials)."""
    try:
        r = requests.post(OAUTH_URL,
                         data={"grant_type": "client_credentials"},
                         auth=(client_id, client_secret),
                         headers={
                             "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
                             "Connection": "close",
                         },
                         timeout=30)
        if r.status_code != 200:
            log.error("OAuth2 failed: %d %s", r.status_code, r.text[:200])
            return None
        data = r.json()
        token = data.get("access_token")
        expires_in = data.get("expires_in", "?")
        log.info("OAuth2 token acquired (expires in %ss, scope=%s)",
                  expires_in, data.get("scope"))
        return token
    except Exception as e:
        log.error("OAuth2 exception: %s", e)
        return None


# ─────────────────────────────────────────────────────────────────────────────
class StepikClient:
    """Тонкий клиент Stepik API с QRATOR обходом и rate-limiting."""

    def __init__(self, token: str | None):
        self.token = token
        self.session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=5, pool_maxsize=20, max_retries=0,
        )
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        if token:
            self.session.headers["Authorization"] = f"Bearer {token}"
        self.session.headers["Accept-Language"] = "ru"
        # QRATOR требует browser UA и Connection: close
        self.session.headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        self.session.headers["Connection"] = "close"
        self._last_req = 0

    def get(self, path: str, params=None) -> dict:
        url = f"{API}/{path.lstrip('/')}"
        # Rate limit: 100ms между запросами
        now = time.time()
        if now - self._last_req < 0.1:
            time.sleep(0.1 - (now - self._last_req))
        self._last_req = time.time()
        # 8 ретраев: 1→2→4→8→16→32→64→120s
        MAX_RETRIES = 8
        for attempt in range(MAX_RETRIES):
            try:
                r = self.session.get(url, params=params, timeout=60)
            except requests.exceptions.ReadTimeout:
                wait = min(2 ** attempt, 120)
                log.warning("timeout, retry %d/%d in %ds", attempt + 1, MAX_RETRIES, wait)
                time.sleep(wait); continue
            except requests.exceptions.ConnectionError as e:
                wait = min(2 ** attempt, 120)
                log.warning("conn error, retry %d/%d in %ds: %s", attempt + 1, MAX_RETRIES, wait, e)
                time.sleep(wait); continue
            except requests.exceptions.RequestException as e:
                wait = min(2 ** attempt, 120)
                log.warning("request error, retry %d/%d in %ds: %s", attempt + 1, MAX_RETRIES, wait, e)
                time.sleep(wait); continue
            if r.status_code == 429:
                # Stepik отдаёт Retry-After в секундах
                wait = float(r.headers.get("Retry-After", 2 ** attempt))
                log.warning("rate-limit, sleeping %.1fs", wait)
                time.sleep(wait); continue
            if r.status_code in (500, 502, 503, 504):
                wait = min(2 ** attempt, 120)
                log.warning("server error %d, retry %d/%d in %ds",
                            r.status_code, attempt + 1, MAX_RETRIES, wait)
                time.sleep(wait); continue
            if r.status_code == 401:
                raise RuntimeError(
                    "401 Unauthorized — нужен персональный токен. "
                    "См. https://stepik.org/edit-profile/tokens"
                )
            if r.status_code == 403:
                # Шаг закрыт — возвращаем пустой результат
                return {"meta": {}, path.split("/")[0]: []}
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"failed after {MAX_RETRIES} retries: {url}")

    def get_many(self, resource: str, ids: list[int], chunk: int = 50) -> list:
        out: list = []
        ids = list(ids)
        for i in range(0, len(ids), chunk):
            chunk_ids = ids[i : i + chunk]
            params = [("ids[]", v) for v in chunk_ids]
            data = self.get(resource, params=params)
            out.extend(data.get(resource, []))
        return out


# ─────────────────────────────────────────────────────────────────────────────
def safe_name(s: str, max_len: int = 80) -> str:
    """Превратить произвольную строку в безопасное имя файла/папки."""
    s = (s or "").strip()
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", s)
    s = re.sub(r"_+", "_", s).strip(" _")
    s = re.sub(
        r"[\U0001F000-\U0001FFFF\U00002600-\U000027BF\U0001F900-\U0001F9FF]",
        "",
        s,
    ).strip()
    if not s:
        s = "untitled"
    return s[:max_len]


# Глобальная session для скачивания файлов (connection pooling + retry)
_download_session = requests.Session()
_dl_adapter = requests.adapters.HTTPAdapter(
    pool_connections=5, pool_maxsize=20, max_retries=0
)
_download_session.mount("https://", _dl_adapter)
_download_session.mount("http://", _dl_adapter)
_download_session.headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
_download_session.headers["Connection"] = "close"  # QRATOR блокирует keep-alive


def download_file(url: str, dest: Path, headers=None, max_retries: int = 3) -> bool:
    """Скачать файл с retry для transient 403 (Uploadcare rate-limiting)."""
    # Uploadcare CDN отвергает Authorization header — скачиваем анонимно
    if "ucarecdn" in url or "cdn.stepik" in url:
        headers = None

    for attempt in range(max_retries):
        try:
            with _download_session.get(url, stream=True, headers=headers or {}, timeout=60) as r:
                if r.status_code == 403 and attempt < max_retries - 1:
                    wait = 2 ** attempt  # 1s, 2s, 4s
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                dest.parent.mkdir(parents=True, exist_ok=True)
                # Сохраним во временный файл, потом переименуем с правильным расширением
                tmp_dest = dest.with_suffix(dest.suffix + ".tmp")
                with open(tmp_dest, "wb") as f:
                    for chunk in r.iter_content(8192):
                        f.write(chunk)
                # Определим тип по content-type или по магическим байтам
                content_type = r.headers.get("content-type", "").lower()
                ext = dest.suffix.lower()
                # Только если у dest нет расширения или оно .bin — угадываем
                if not ext or ext == ".bin":
                    new_ext = None
                    if "jpeg" in content_type or "jpg" in content_type:
                        new_ext = ".jpg"
                    elif "png" in content_type:
                        new_ext = ".png"
                    elif "gif" in content_type:
                        new_ext = ".gif"
                    elif "webp" in content_type:
                        new_ext = ".webp"
                    elif "svg" in content_type:
                        new_ext = ".svg"
                    elif "pdf" in content_type:
                        new_ext = ".pdf"
                    elif "audio" in content_type or "mpeg" in content_type:
                        new_ext = ".mp3"
                    elif "video" in content_type:
                        new_ext = ".mp4"
                    else:
                        # По магическим байтам
                        try:
                            with open(tmp_dest, "rb") as f:
                                head = f.read(16)
                            if head.startswith(b"\xff\xd8\xff"):
                                new_ext = ".jpg"
                            elif head.startswith(b"\x89PNG\r\n\x1a\n"):
                                new_ext = ".png"
                            elif head.startswith(b"GIF8"):
                                new_ext = ".gif"
                            elif head.startswith(b"RIFF") and b"WEBP" in head:
                                new_ext = ".webp"
                            elif head.startswith(b"%PDF"):
                                new_ext = ".pdf"
                            elif head.startswith(b"ID3") or head.startswith(b"\xff\xfb"):
                                new_ext = ".mp3"
                            elif b"ftyp" in head[:12]:
                                new_ext = ".mp4"
                        except Exception:
                            pass
                    if new_ext:
                        final_dest = dest.with_suffix(new_ext)
                    else:
                        final_dest = dest
                else:
                    final_dest = dest
                # Если целевой файл уже существует (другой тип) — удалим его
                if final_dest.exists() and final_dest != tmp_dest:
                    try: final_dest.unlink()
                    except Exception: pass
                tmp_dest.rename(final_dest)
            return True
        except Exception as e:
            try:
                if 'tmp_dest' in locals() and tmp_dest.exists():
                    tmp_dest.unlink()
            except Exception: pass
            if attempt < max_retries - 1 and "403" not in str(e):
                time.sleep(2 ** attempt)
                continue
            log.warning("download failed %s -> %s: %s", url, dest, e)
            return False
    return False


def fetch_course(client: StepikClient, course_id: int) -> dict:
    course = client.get(f"courses/{course_id}")["courses"][0]
    sections = client.get_many("sections", course["sections"])

    unit_ids: list[int] = []
    for s in sections:
        unit_ids.extend(s["units"])
    units = client.get_many("units", unit_ids)

    lesson_ids = [u["lesson"] for u in units]
    lessons = client.get_many("lessons", lesson_ids)

    step_ids: list[int] = []
    for l in lessons:
        step_ids.extend(l["steps"])
    steps = client.get_many("steps", step_ids)

    unit_by_id = {u["id"]: u for u in units}
    lesson_by_id = {l["id"]: l for l in lessons}
    step_by_id = {s["id"]: s for s in steps}

    return {
        "course": course,
        "sections": sections,
        "units": units,
        "lessons": lessons,
        "steps": steps,
        "unit_by_id": unit_by_id,
        "lesson_by_id": lesson_by_id,
        "step_by_id": step_by_id,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Извлечение медиа из HTML шага

def collect_urls_from_html(html: str) -> list[str]:
    """Все URL из src= и href= в HTML."""
    if not html:
        return []
    urls = re.findall(r'(?:src|href)="(https?://[^"]+)"', html)
    # Уникальные, сохраняя порядок
    seen, out = set(), []
    for u in urls:
        if u in seen:
            continue
        seen.add(u); out.append(u)
    return out


def collect_media_urls(html: str) -> dict:
    """Разделить URL из HTML по типам: images, files, audio, video."""
    out = {"images": [], "files": [], "audio": [], "video": [], "other": []}
    for u in collect_urls_from_html(html):
        path = urlparse(u).path.lower()
        ext = Path(path).suffix or ""
        if any(d in u for d in ("ucarecdn", "cdn.stepik")):
            # Uploadcare URLs без расширения — почти всегда картинки
            # (Stepik использует UUID без .jpg в URL)
            if ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"):
                out["images"].append(u)
            elif ext in (".mp3", ".wav", ".ogg", ".m4a"):
                out["audio"].append(u)
            elif ext in (".mp4", ".webm", ".mov", ".avi", ".mkv"):
                out["video"].append(u)
            elif ext in (".pdf", ".zip", ".tar", ".gz", ".doc", ".docx",
                         ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv",
                         ".py", ".cpp", ".c", ".java", ".go", ".rs", ".js", ".ts",
                         ".json", ".xml", ".yml", ".yaml", ".md", ".rst"):
                out["files"].append(u)
            else:
                # Нет расширения — скорее всего картинка (Uploadcare UUID)
                # Делаем HEAD-запрос, чтобы понять content-type
                out["images"].append(u)
        elif u.startswith("https://stepik.org/"):
            out["other"].append(u)
    return out


def collect_attachments_from_options(options: dict | None) -> list[dict]:
    """Извлечь attachments из block.options (форма name='attachments', dict с name+url)."""
    if not options:
        return []
    out = []
    # Шаги Stepik хранят attachments как list of {name, url}
    atts = options.get("attachments") or []
    if isinstance(atts, list):
        for a in atts:
            if isinstance(a, dict) and a.get("url"):
                out.append({"name": a.get("name") or Path(urlparse(a["url"]).path).name or "file",
                            "url": a["url"]})
            elif isinstance(a, str):
                out.append({"name": Path(urlparse(a).path).name or "file", "url": a})
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Субтитры видео

def download_video_subtitles(video: dict, dest_dir: Path, headers: dict) -> int:
    """Скачать все .vtt субтитры из video.subtitle_files. Возвращает число скачанных."""
    subs = video.get("subtitle_files") or []
    if not subs:
        return 0
    dest_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for s in subs:
        url = s.get("url")
        lang = s.get("language") or "und"
        if not url:
            continue
        # Stepik subtitle_files иногда отдают как JSON-обёртку. Возможны два варианта:
        # 1) {'language': 'ru', 'url': 'https://...'}  → уже URL
        # 2) URL указывает на .vtt напрямую
        # Также обрабатываем случай, когда URL — это JSON-эндпоинт, отдающий [{"..."}]
        try:
            r = requests.get(url, headers=headers, timeout=30)
            r.raise_for_status()
            content_type = r.headers.get("content-type", "")
            if "json" in content_type or r.text.strip().startswith("["):
                # JSON-обёртка
                try:
                    data = r.json()
                    if isinstance(data, list):
                        for sub in data:
                            sub_url = sub.get("url") or sub.get("src")
                            sub_lang = sub.get("language") or lang
                            if sub_url:
                                ext = ".vtt" if "vtt" in sub_url.lower() or sub_url.endswith(".vtt") else ".srt"
                                fname = f"subs_{sub_lang}{ext}"
                                if download_file(sub_url, dest_dir / fname, headers=headers):
                                    count += 1
                    continue
                except json.JSONDecodeError:
                    pass
            # Прямой файл
            ext = ".vtt" if "vtt" in url.lower() else ".srt"
            fname = f"subs_{lang}{ext}"
            (dest_dir / fname).write_bytes(r.content)
            count += 1
        except Exception as e:
            log.warning("subtitle download failed %s: %s", url, e)
    return count


# ─────────────────────────────────────────────────────────────────────────────
# Step-sources — для приватных полей (правильные ответы, тесты и т.д.)

def fetch_step_sources(client: StepikClient, step_id: int) -> dict | None:
    """Получить /api/step-sources/<id>. Требует авторизации. Возвращает block.source или None."""
    try:
        data = client.get(f"step-sources/{step_id}")
        ss_list = data.get("step-sources", [])
        if not ss_list:
            return None
        return ss_list[0].get("block", {}).get("source") or {}
    except Exception as e:
        log.debug("step-sources failed for %d: %s", step_id, e)
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Комментарии к шагам (через /api/comments?target_type=step&target=<id>)

def fetch_step_comments(client: StepikClient, step_id: int, max_pages: int = 50) -> dict:
    """Получить все комментарии шага + связанные users/attempts/submissions/votes."""
    out: dict = {"comments": [], "users": [], "attempts": [], "submissions": [], "votes": []}
    seen_comment_ids: set[int] = set()
    for page in range(1, max_pages + 1):
        try:
            data = client.get("comments", params={
                "target_type": "step",
                "target": step_id,
                "page": page,
            })
        except Exception as e:
            log.debug("comments fetch failed for step %d page %d: %s", step_id, page, e)
            break
        comments = data.get("comments", [])
        if not comments:
            break
        for c in comments:
            if c["id"] not in seen_comment_ids:
                seen_comment_ids.add(c["id"])
                out["comments"].append(c)
        # Доп. сущности (users/attempts/submissions/votes) дедуплицируем по id
        for key in ("users", "attempts", "submissions", "votes"):
            seen = {x["id"] for x in out[key]} if out[key] else set()
            for x in data.get(key, []):
                if x.get("id") not in seen:
                    out[key].append(x)
                    seen.add(x.get("id"))
        if not data.get("meta", {}).get("has_next"):
            break
        # Защита от бесконечного цикла
        if page >= 100:
            break
    return out


def save_step_comments(comments_data: dict, dest_dir: Path, step_url: str) -> None:
    """Сохранить комментарии шага в Markdown + JSON."""
    if not comments_data["comments"]:
        return
    dest_dir.mkdir(parents=True, exist_ok=True)
    # JSON со всеми данными
    (dest_dir / "comments.json").write_text(
        json.dumps(comments_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # Markdown — читаемый вид
    users_by_id = {u["id"]: u for u in comments_data.get("users", [])}
    # Построим дерево по parent
    by_parent: dict = {}
    for c in comments_data["comments"]:
        by_parent.setdefault(c.get("parent"), []).append(c)
    parts: list[str] = []
    parts.append(f"# Комментарии ({len(comments_data['comments'])})\n")
    parts.append(f"> Обсуждение на Stepik: {step_url}\n")

    def render_comment(c: dict, depth: int = 0) -> None:
        user = users_by_id.get(c.get("user"), {})
        name = f"{user.get('first_name','')} {user.get('last_name','')}".strip() or f"User #{c.get('user')}"
        time_str = c.get("time", "") or c.get("last_time", "")
        prefix = "  " * depth
        parts.append(f"{prefix}**{name}** · _{time_str}_")
        if c.get("text"):
            parts.append(f"{prefix}{html_to_md(c['text'])}")
        if c.get("reply_count"):
            parts.append(f"{prefix}_↳ {c['reply_count']} ответов_")
        parts.append("")
        for reply in by_parent.get(c["id"], []):
            render_comment(reply, depth + 1)

    # Сначала top-level комментарии (parent=None), отсортированные по голосам
    top_level = sorted(by_parent.get(None, []),
                       key=lambda c: -(c.get("vote_sum") or 0))
    for c in top_level:
        render_comment(c)

    (dest_dir / "comments.md").write_text("\n".join(parts), encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Отзывы о курсе

def fetch_course_reviews(client: StepikClient, course_id: int, max_pages: int = 50) -> dict:
    """Получить все отзывы о курсе + связанных users."""
    out: dict = {"reviews": [], "users": []}
    seen_review_ids: set[int] = set()
    seen_user_ids: set[int] = set()
    for page in range(1, max_pages + 1):
        try:
            data = client.get("course-reviews", params={
                "course": course_id,
                "page": page,
            })
        except Exception as e:
            log.debug("course-reviews page %d failed: %s", page, e)
            break
        reviews = data.get("course-reviews", [])
        if not reviews:
            break
        for r in reviews:
            if r["id"] not in seen_review_ids:
                seen_review_ids.add(r["id"])
                out["reviews"].append(r)
            uid = r.get("user")
            if uid and uid not in seen_user_ids:
                seen_user_ids.add(uid)
                out["users"].append({"id": uid})  # заполним позже
        if not data.get("meta", {}).get("has_next"):
            break
    # Догрузим users
    if seen_user_ids:
        try:
            users = client.get_many("users", list(seen_user_ids))
            out["users"] = users
        except Exception as e:
            log.debug("users fetch for reviews failed: %s", e)
    return out


def save_course_reviews(reviews_data: dict, dest: Path, course_title: str) -> None:
    """Сохранить отзывы о курсе в Markdown + JSON."""
    if not reviews_data["reviews"]:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    # JSON
    (dest.with_suffix(".json")).write_text(
        json.dumps(reviews_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # Markdown
    users_by_id = {u["id"]: u for u in reviews_data.get("users", [])}
    parts: list[str] = []
    parts.append(f"# Отзывы о курсе «{course_title}»\n")
    parts.append(f"Всего отзывов: {len(reviews_data['reviews'])}\n")
    # Сортируем по рейтингу (высокие первыми)
    sorted_reviews = sorted(reviews_data["reviews"],
                            key=lambda r: -(r.get("score") or 0))
    for r in sorted_reviews:
        user = users_by_id.get(r.get("user"), {})
        name = f"{user.get('first_name','')} {user.get('last_name','')}".strip() or f"User #{r.get('user')}"
        score = r.get("score") or 0
        stars = "★" * score + "☆" * (5 - score)
        parts.append(f"## {stars} — {name}")
        parts.append(f"_{r.get('create_date','')}_\n")
        if r.get("text"):
            parts.append(r["text"])
        if r.get("reply_text"):
            parts.append(f"\n**↳ Ответ автора курса:**\n")
            parts.append(r["reply_text"])
        parts.append("\n---\n")
    (dest.with_suffix(".md")).write_text("\n".join(parts), encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Информация об авторе курса

def fetch_user(client: StepikClient, user_id: int) -> dict | None:
    """Получить полную информацию о пользователе."""
    try:
        users = client.get_many("users", [user_id])
        return users[0] if users else None
    except Exception as e:
        log.debug("user fetch failed for %d: %s", user_id, e)
        return None


def save_instructor_info(user: dict, dest: Path) -> None:
    """Сохранить информацию об авторе курса."""
    if not user:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    # JSON
    (dest.with_suffix(".json")).write_text(
        json.dumps(user, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # Markdown
    name = f"{user.get('first_name','')} {user.get('last_name','')}".strip()
    parts: list[str] = [f"# {name}\n"]
    if user.get("short_bio"):
        parts.append("## Краткая биография\n")
        parts.append(user["short_bio"])
        parts.append("")
    if user.get("details"):
        parts.append("## Подробно\n")
        parts.append(user["details"])
        parts.append("")
    if user.get("image"):
        parts.append(f"![Аватар]({user['image']})")
    # Скачаем аватар
    if user.get("image"):
        avatar_path = dest.parent / (str(user["id"]) + "_avatar.jpg")
        download_file(user["image"], avatar_path)
    (dest.with_suffix(".md")).write_text("\n".join(parts), encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Превью видео (thumbnail)

def download_video_thumbnail(video: dict, dest_dir: Path, headers: dict) -> bool:
    """Скачать thumbnail видео как .jpg."""
    thumb = video.get("thumbnail")
    if not thumb:
        return False
    dest_dir.mkdir(parents=True, exist_ok=True)
    return download_file(thumb, dest_dir / "thumbnail.jpg", headers=headers)


# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
# PDF-сборник курса

def build_course_pdf(course_dir: Path, course_title: str, course_index: dict) -> bool:
    """Собрать все .md шаги курса в один PDF через pandoc + weasyprint."""
    pandoc = shutil.which("pandoc")
    weasyprint = shutil.which("weasyprint")
    if not pandoc or not weasyprint:
        log.warning("pandoc or weasyprint not found — skipping PDF export")
        return False
    try:
        # 1. Соберём все .md в один большой Markdown-файл в порядке курса
        combined_md = course_dir / "_course_combined.md"
        with open(combined_md, "w", encoding="utf-8") as f:
            f.write(f"% {course_title}\n\n")
            f.write(f"# {course_title}\n\n")
            if course_index.get("summary"):
                f.write(course_index["summary"] + "\n\n")
            f.write("---\n\n")
            for sec in course_index.get("sections", []):
                f.write(f"# {sec.get('position',0):02d}. {sec['title']}\n\n")
                for les in sec.get("lessons", []):
                    f.write(f"## {les.get('position',0):02d}. {les['title']}\n\n")
                    # Найдём папку урока
                    sec_dir = course_dir / f"{sec['position']:02d}_{safe_name(sec['title'], 60)}"
                    les_dir = sec_dir / f"{les.get('position',0):02d}_{safe_name(les['title'], 70)}"
                    if not les_dir.exists():
                        continue
                    # Шаги в папке урока
                    step_dirs = sorted([d for d in les_dir.iterdir()
                                        if d.is_dir() and d.name[0:2].isdigit()])
                    for step_dir in step_dirs:
                        md_file = step_dir / "step.md"
                        if md_file.exists():
                            content = md_file.read_text(encoding="utf-8")
                            f.write(f"### {step_dir.name.replace('_',' ')}\n\n")
                            f.write(content)
                            f.write("\n\n---\n\n")
        # 2. Конвертируем MD → HTML через pandoc
        html_file = course_dir / "_course_combined.html"
        subprocess.run([pandoc, str(combined_md), "-o", str(html_file),
                        "--standalone", "--metadata", f"title={course_title}",
                        "--toc", "--toc-depth=3"], check=True, capture_output=True, timeout=120)
        # 3. Конвертируем HTML → PDF через weasyprint
        pdf_file = course_dir / "_course_book.pdf"
        env = os.environ.copy()
        env["PYTHONPATH"] = "/home/z/.venv/lib/python3.12/site-packages"
        subprocess.run([weasyprint, str(html_file), str(pdf_file)],
                       check=True, capture_output=True, timeout=300, env=env)
        # Удалим промежуточный HTML (MD оставим для справки)
        try: html_file.unlink()
        except Exception: pass
        return True
    except subprocess.CalledProcessError as e:
        log.warning("PDF generation failed: %s", (e.stderr or b"")[:300].decode("utf-8", "replace"))
        return False
    except Exception as e:
        log.warning("PDF generation exception: %s", e)
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Search index — для полнотекстового поиска по архиву

def build_search_index(course_dir: Path, course_index: dict, course_id: int) -> dict:
    """Собрать JSON-индекс: для каждого шага — путь, заголовок, текст (для поиска)."""
    entries: list[dict] = []
    for sec in course_index.get("sections", []):
        sec_dir = course_dir / f"{sec['position']:02d}_{safe_name(sec['title'], 60)}"
        for les in sec.get("lessons", []):
            les_dir = sec_dir / f"{les.get('position',0):02d}_{safe_name(les['title'], 70)}"
            if not les_dir.exists():
                continue
            step_dirs = sorted([d for d in les_dir.iterdir()
                                if d.is_dir() and d.name[0:2].isdigit()])
            for step_dir in step_dirs:
                md_file = step_dir / "step.md"
                text = ""
                if md_file.exists():
                    text = md_file.read_text(encoding="utf-8")
                # Также читаем комментарии если есть
                comments_file = step_dir / "comments.md"
                if comments_file.exists():
                    text += "\n\n" + comments_file.read_text(encoding="utf-8")
                entries.append({
                    "section": sec["title"],
                    "lesson": les["title"],
                    "step_dir": str(step_dir.relative_to(course_dir)),
                    "step_url": next((s["step_url"] for s in les.get("steps", [])
                                       if str(s["position"]).zfill(2) == step_dir.name[:2]), ""),
                    "text": text[:5000],  # ограничим для размера
                })
    return {
        "course_id": course_id,
        "course_title": course_index.get("title", ""),
        "entries_count": len(entries),
        "entries": entries,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Markdown-генератор для разных типов шагов

def build_step_markdown(step: dict, lesson_title: str, source: dict | None) -> str:
    """Построить Markdown-текст шага в зависимости от типа."""
    blk = step["block"]
    name = blk["name"]
    text_html = blk.get("text", "") or ""
    text_md = html_to_md(text_html)
    options = blk.get("options") or {}

    parts: list[str] = []
    parts.append(f"# {lesson_title} — шаг {step['position']} ({name})\n")

    # Ссылка на шаг в Stepik
    step_url = f"https://stepik.org/lesson/{step['lesson']}/step/{step['position']}"
    parts.append(f"> Stepik: [{step_url}]({step_url})\n")

    # Текст шага
    if text_md:
        parts.append(text_md)
        parts.append("")

    # ----- Тип: text (теория) -----
    if name == "text":
        if options.get("is_html_enabled"):
            parts.append("> Текст шага использует HTML-разметку (см. .html файл)\n")

    # ----- Тип: video -----
    elif name == "video":
        video = blk.get("video") or {}
        if video:
            parts.append("## Видео\n")
            parts.append(f"- Длительность: {video.get('duration', '?')}s")
            if video.get("thumbnail"):
                parts.append(f"- Превью: " + str(video.get("thumbnail")))
            subs = video.get("subtitle_files") or []
            if subs:
                langs = ", ".join(sorted({s.get("language","?") for s in subs}))
                parts.append(f"- Субтитры: {langs}")
            parts.append("")

    # ----- Тип: choice (тест с вариантами) -----
    elif name == "choice":
        parts.append("## Тест\n")
        is_multi = options.get("is_multiple_choice", False)
        parts.append(f"- Тип: {'несколько правильных ответов' if is_multi else 'один правильный ответ'}")
        # Варианты берутся из step-sources
        if source and source.get("options"):
            parts.append("\n### Варианты ответов\n")
            for i, opt in enumerate(source["options"], 1):
                is_correct = opt.get("is_correct", False)
                marker = "[x]" if is_correct else "[ ]"
                opt_text = html_to_md(opt.get("text", "") or "")
                parts.append(f"{i}. {marker} {opt_text}")
        else:
            parts.append("\n> Варианты ответов доступны только с токеном Stepik "
                         "(см. /api/step-sources/<id>)")
        parts.append("")

    # ----- Тип: code (программирование) -----
    elif name == "code":
        parts.append("## Программирование\n")
        parts.append(f"- Лимит времени: {options.get('execution_time_limit', '?')} сек")
        parts.append(f"- Лимит памяти: {options.get('execution_memory_limit', '?')} МБ")

        # Code templates (шаблон кода по языкам)
        templates = options.get("code_templates") or {}
        if templates:
            parts.append("\n### Шаблон кода по языкам\n")
            for lang, tmpl in templates.items():
                parts.append(f"**{lang}:**")
                parts.append(f"```{lang}")
                parts.append(tmpl)
                parts.append("```\n")

        # Sample тесты (публичные)
        samples = options.get("samples") or []
        if samples:
            parts.append(f"\n### Примеры тестов ({len(samples)})\n")
            for i, (inp, out) in enumerate(samples, 1):
                parts.append(f"#### Пример {i}")
                parts.append("**Вход:**")
                parts.append("```")
                parts.append(inp)
                parts.append("```")
                parts.append("**Выход:**")
                parts.append("```")
                parts.append(out)
                parts.append("```\n")

        # Полные тесты из step-sources (только с токеном)
        if source:
            tests = source.get("tests", "") or ""
            if tests:
                parts.append("\n### Эталонные тесты (из step-sources)\n")
                parts.append("```")
                parts.append(tests)
                parts.append("```\n")
            code_templates_src = source.get("code_templates") or {}
            if code_templates_src:
                parts.append("\n### Шаблоны из step-sources\n")
                for lang, tmpl in code_templates_src.items():
                    parts.append(f"**{lang}:**")
                    parts.append(f"```{lang}")
                    parts.append(tmpl)
                    parts.append("```\n")

    # ----- Тип: number (численный ответ) -----
    elif name == "number":
        parts.append("## Численный ответ\n")
        if source and "answer" in source:
            parts.append(f"- Ответ: `{source.get('answer')}`")
            if source.get("tolerance") is not None:
                parts.append(f"- Допуск: ±{source.get('tolerance')}")
            if source.get("answer_precision") is not None:
                parts.append(f"- Точность: {source.get('answer_precision')} знаков")
        else:
            parts.append("> Ответ доступен только с токеном Stepik")
        parts.append("")

    # ----- Тип: string (строковый ответ) -----
    elif name == "string":
        parts.append("## Строковый ответ\n")
        if source and "answer" in source:
            answers = source.get("answer")
            if isinstance(answers, list):
                parts.append(f"- Возможные ответы:")
                for a in answers:
                    parts.append(f"  - `{a}`")
            else:
                parts.append(f"- Ответ: `{answers}`")
            if source.get("case_sensitive") is not None:
                parts.append(f"- Чувствительность к регистру: {source.get('case_sensitive')}")
        else:
            parts.append("> Ответ доступен только с токеном Stepik")
        parts.append("")

    # ----- Тип: math (математический ответ) -----
    elif name == "math":
        parts.append("## Математический ответ\n")
        if source and "answer" in source:
            parts.append(f"- Ответ: `{source.get('answer')}`")
        else:
            parts.append("> Ответ доступен только с токеном Stepik")
        parts.append("")

    # ----- Тип: free-answer (свободный ответ) -----
    elif name == "free-answer":
        parts.append("## Свободный ответ\n")
        parts.append("> Требует ручной проверки преподавателем\n")

    # ----- Тип: sql -----
    elif name == "sql":
        parts.append("## SQL-задача\n")
        if source:
            parts.append(f"- СУБД: {source.get('database', '?')}")
            schema = source.get("schema") or ""
            if schema:
                parts.append("\n### Схема БД\n```sql")
                parts.append(schema)
                parts.append("```\n")
            sample = source.get("sample", {})
            if sample:
                parts.append("\n### Пример\n```sql")
                parts.append(sample.get("query",""))
                parts.append("```\n")
            correct = source.get("correct_answer") or source.get("answer")
            if correct:
                parts.append("\n### Эталонный ответ\n```sql")
                parts.append(correct if isinstance(correct, str) else json.dumps(correct, ensure_ascii=False))
                parts.append("```\n")
        else:
            parts.append("> Подробности доступны только с токеном Stepik")
        parts.append("")

    # ----- Тип: sorting -----
    elif name == "sorting":
        parts.append("## Сортировка\n")
        if source and source.get("items"):
            parts.append("### Правильный порядок\n")
            for i, item in enumerate(source.get("items", []), 1):
                parts.append(f"{i}. {html_to_md(item.get('text','') or item if isinstance(item, str) else '')}")
        else:
            parts.append("> Порядок доступен только с токеном Stepik")
        parts.append("")

    # ----- Тип: matching -----
    elif name == "matching":
        parts.append("## Соответствие\n")
        if source and source.get("pairs"):
            parts.append("### Правильные пары\n")
            for p in source.get("pairs", []):
                left = html_to_md(p.get("first","") or "")
                right = html_to_md(p.get("second","") or "")
                parts.append(f"- {left} → {right}")
        else:
            parts.append("> Пары доступны только с токеном Stepik")
        parts.append("")

    # ----- Тип: fill (заполнить пропуски) -----
    elif name == "fill":
        parts.append("## Заполнить пропуски\n")
        if source:
            text = source.get("text","")
            parts.append("### Текст с пропусками\n")
            parts.append(text)
            blanks = source.get("blanks") or []
            if blanks:
                parts.append(f"\n### Пропуски ({len(blanks)})\n")
                for i, b in enumerate(blanks, 1):
                    parts.append(f"**{i}:** {b}")
        else:
            parts.append("> Пропуски доступны только с токеном Stepik")
        parts.append("")

    # ----- Тип: pycharm / linux-terminal -----
    elif name in ("pycharm", "linux-terminal"):
        parts.append(f"## {name.upper()}\n")
        parts.append("> Специализированное задание. Детали в .json файле.\n")
        if source:
            parts.append("### Source\n```json")
            parts.append(json.dumps(source, ensure_ascii=False, indent=2))
            parts.append("```\n")

    # ----- Тип: dataset -----
    elif name == "dataset":
        parts.append("## Dataset-задача\n")
        if source:
            parts.append(f"- Размер: {source.get('size','?')}")
            url = source.get("dataset_url")
            if url:
                parts.append(f"- [Скачать dataset]({url})")
        else:
            parts.append("> Dataset доступен только с токеном Stepik")
        parts.append("")

    # ----- Прочие типы -----
    else:
        parts.append(f"## Тип: {name}\n")
        if source:
            parts.append("```json")
            parts.append(json.dumps(source, ensure_ascii=False, indent=2))
            parts.append("```\n")

    # ----- Прикреплённые файлы -----
    attachments = collect_attachments_from_options(options)
    if attachments:
        parts.append("\n### Прикреплённые файлы\n")
        for a in attachments:
            parts.append(f"- [{a['name']}](attachments/{a['name']})")

    # ----- Обсуждения (мета) -----
    disc_count = step.get("discussions_count", 0) or 0
    if disc_count:
        parts.append(f"\n### Обсуждения: {disc_count} (см. на [Stepik]({step_url}))")

    return "\n".join(parts) + "\n"


# ─────────────────────────────────────────────────────────────────────────────
# Скачивание видео

def download_step_video(step: dict, dest_dir: Path, headers: dict, prefer_yt_dlp: bool) -> bool:
    """Скачать видео шага. Сначала пробуем yt-dlp, потом прямые URL."""
    blk = step["block"]
    video = blk.get("video")
    if not video:
        return False

    step_url = f"https://stepik.org/lesson/{step['lesson']}/step/{step['position']}"
    dest_dir.mkdir(parents=True, exist_ok=True)

    if prefer_yt_dlp and shutil.which("yt-dlp"):
        cmd = [
            "yt-dlp",
            "-o", str(dest_dir / "%(title)s.%(ext)s"),
            "--write-subs", "--write-auto-subs",
            "--sub-langs", "ru,en",
            "--embed-subs",
            "--no-playlist",
            "--no-warnings",
            "--no-progress",
        ]
        if headers.get("Authorization"):
            cmd.extend(["--add-header", f"Authorization: {headers['Authorization']}"])
        cmd.append(step_url)
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if r.returncode == 0:
                return True
            log.warning("yt-dlp failed on %s: %s", step_url, r.stderr[-300:])
        except Exception as e:
            log.warning("yt-dlp exception on %s: %s", step_url, e)

    # Фолбэк: прямые URL из API
    for u in sorted(video.get("urls", []), key=lambda x: int(x.get("quality", 0))):
        url = u.get("url")
        if not url:
            continue
        fname = f"step_{step['position']:02d}_{u.get('quality','')}p.mp4"
        if download_file(url, dest_dir / fname, headers=headers):
            return True
    return False


# ─────────────────────────────────────────────────────────────────────────────
# Обработка одного шага — выделена в функцию для многопоточности.

def process_step(
    step: dict,
    lesson: dict,
    lesson_title: str,
    les_dir: Path,
    st_idx: int,
    client: "StepikClient",
    headers: dict,
    skip_video: bool,
    prefer_yt_dlp: bool,
    fetch_sources: bool,
    fetch_html: bool,
    fetch_subtitles: bool,
    fetch_comments: bool,
    token: str | None,
) -> tuple[dict, dict | None]:
    """Обработка одного шага — выделена в функцию для многопоточности.

    Возвращает (stats_dict, step_index_dict) — накопленные статистики и индекс шага.
    stats_dict содержит локальные счётчики, которые вызывающий код добавит к общим.
    """
    st_id = step["id"]
    blk = step["block"]
    name = blk["name"]
    local_stats: dict = {
        "steps": 1,
        "block_types": {name: 1},
        "text_md": 0, "html_files": 0, "step_sources": 0,
        "files": 0, "images": 0, "audio": 0, "video": 0, "other": 0,
        "attachments": 0, "videos": 0, "subtitles": 0, "thumbnails": 0,
        "comments": 0, "users_in_comments": 0, "discussions_total": 0,
    }

    # Папка шага
    step_dir = les_dir / f"{st_idx:02d}_{name}"
    step_dir.mkdir(parents=True, exist_ok=True)

    # Resume: если step.md уже существует — пропускаем (предыдущий прогон не завершился)
    if (step_dir / "step.md").exists():
        step_url = f"https://stepik.org/lesson/{step['lesson']}/step/{step['position']}"
        return local_stats, {
            "position": st_idx,
            "id": st_id,
            "type": name,
            "title": (blk.get("text", "") or "")[:80],
            "has_video": bool(blk.get("video")),
            "discussions_count": step.get("discussions_count", 0) or 0,
            "step_url": step_url,
            "resumed": True,
        }

    # 1. step-sources
    source = None
    if fetch_sources and token:
        source = fetch_step_sources(client, st_id)
        if source:
            local_stats["step_sources"] += 1

    # 2. Markdown
    md = build_step_markdown(step, lesson_title, source)
    (step_dir / "step.md").write_text(md, encoding="utf-8")
    local_stats["text_md"] += 1

    # 3. HTML
    if fetch_html:
        html_content = blk.get("text", "") or ""
        if html_content:
            html_full = (
                "<!DOCTYPE html>\n<html lang='ru'><head><meta charset='utf-8'>"
                f"<title>{lesson_title} — шаг {step['position']}</title></head>"
                f"<body>{html_content}</body></html>"
            )
            (step_dir / "step.html").write_text(html_full, encoding="utf-8")
            local_stats["html_files"] += 1

    # 4. JSON шага
    (step_dir / "step.json").write_text(
        json.dumps(step, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 5. source.json
    if source:
        (step_dir / "source.json").write_text(
            json.dumps(source, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    # 6. Картинки / файлы из HTML
    media = collect_media_urls(blk.get("text", ""))
    all_urls = []
    for kind in ("images", "audio", "files", "video"):
        all_urls.extend([(kind, u) for u in media[kind]])
        local_stats[kind] += len(media[kind])
    local_stats["other"] += len(media["other"])

    if media["other"]:
        links_file = step_dir / "links.txt"
        with open(links_file, "w", encoding="utf-8") as f:
            for u in media["other"]:
                f.write(u + "\n")

    if all_urls:
        def _dl_one(item, sd=step_dir):
            kind, url = item
            fname = Path(urlparse(url).path).name
            if not fname or fname == "/":
                fname = f"file_{int(time.time()*1000000)%1000000}.bin"
            if "." not in fname:
                fname += ".bin"
            dest = sd / "attachments" / fname
            return 1 if download_file(url, dest, headers=headers) else 0
        with ThreadPoolExecutor(max_workers=4) as ex:
            for ok in ex.map(_dl_one, all_urls):
                local_stats["files"] += ok

    # 7. Attachments из block.options
    attachments = collect_attachments_from_options(blk.get("options"))
    if attachments:
        local_stats["attachments"] += len(attachments)
        for a in attachments:
            dest = step_dir / "attachments" / a["name"]
            if download_file(a["url"], dest, headers=headers):
                local_stats["files"] += 1

    # 8. Видео шага
    if blk.get("video"):
        # 8a. Thumbnail
        if download_video_thumbnail(blk["video"], step_dir / "video", headers):
            local_stats["thumbnails"] += 1
        # 8b. Само видео
        if not skip_video:
            if download_step_video(step, step_dir / "video", headers, prefer_yt_dlp):
                local_stats["videos"] += 1
            # 8c. Субтитры
            if fetch_subtitles:
                local_stats["subtitles"] += download_video_subtitles(
                    blk["video"], step_dir / "video", headers
                )

    # 9. Комментарии (только если есть обсуждения)
    disc_count = step.get("discussions_count", 0) or 0
    local_stats["discussions_total"] += disc_count
    if fetch_comments and disc_count > 0:
        try:
            step_url = f"https://stepik.org/lesson/{step['lesson']}/step/{step['position']}"
            comments_data = fetch_step_comments(client, st_id)
            if comments_data["comments"]:
                save_step_comments(comments_data, step_dir / "comments", step_url)
                local_stats["comments"] += len(comments_data["comments"])
                local_stats["users_in_comments"] += len(comments_data.get("users", []))
        except Exception as e:
            log.debug("comments fetch failed for step %d: %s", st_id, e)

    step_url = f"https://stepik.org/lesson/{step['lesson']}/step/{step['position']}"
    step_index = {
        "position": st_idx,
        "id": st_id,
        "type": name,
        "title": (blk.get("text", "") or "")[:80],
        "has_video": bool(blk.get("video")),
        "discussions_count": disc_count,
        "step_url": step_url,
    }
    return local_stats, step_index


def _merge_local_stats(stats: dict, local: dict) -> None:
    """Слить локальные stats одного шага в общие stats (thread-safe через GIL)."""
    for k, v in local.items():
        if k == "block_types":
            for bt, cnt in v.items():
                stats["block_types"][bt] = stats["block_types"].get(bt, 0) + cnt
        else:
            stats[k] = stats.get(k, 0) + v


# ─────────────────────────────────────────────────────────────────────────────
# Главная функция выгрузки

def dump_course(course_id: int, out_root: Path, token: str | None,
                skip_video: bool = False, prefer_yt_dlp: bool = True,
                fetch_sources: bool = True, fetch_html: bool = True,
                fetch_subtitles: bool = True,
                fetch_comments: bool = True,
                fetch_reviews: bool = True,
                fetch_instructors: bool = True,
                build_pdf: bool = False,
                build_search_idx: bool = True,
                archive_format: str = "tar.gz") -> Path:
    client = StepikClient(token)
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    # Cleanup stale .tmp files from previous interrupted runs
    try:
        for tmp in out_root.rglob("*.tmp"):
            try: tmp.unlink()
            except Exception: pass
    except Exception: pass

    log.info("Fetching course %d …", course_id)
    data = fetch_course(client, course_id)
    course = data["course"]

    course_dir_name = f"stepik_course_{course_id}_{safe_name(course['title'], 60)}"
    course_dir = out_root / course_dir_name
    course_dir.mkdir(parents=True, exist_ok=True)

    # Метаданные курса
    (course_dir / "_course_meta.json").write_text(
        json.dumps(course, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Обложка
    cover = course.get("cover")
    if cover:
        download_file(cover, course_dir / "_cover.jpg", headers=headers)

    sections = data["sections"]
    log.info("Course: %s — %d sections", course["title"], len(sections))
    # Подсчитаем общее число шагов курса для детального прогресса
    total_course_steps = 0
    for sec in sections:
        for unit_id in sec["units"]:
            unit_obj = data["unit_by_id"].get(unit_id)
            if unit_obj:
                lesson_obj = data["lesson_by_id"].get(unit_obj["lesson"])
                if lesson_obj:
                    total_course_steps += len(lesson_obj.get("steps", []))
    print(f"__PROGRESS__ phase=init total_sections={len(sections)} "
          f"total_steps={total_course_steps} "
          f"course_title={course['title']}", flush=True)

    stats = {
        "lessons": 0, "steps": 0, "skipped_private": 0,
        "videos": 0, "files": 0, "text_md": 0, "images": 0,
        "audio": 0, "subtitles": 0, "thumbnails": 0, "html_files": 0,
        "step_sources": 0, "attachments": 0, "discussions_total": 0,
        "comments": 0, "users_in_comments": 0, "reviews": 0,
        "instructors": 0, "block_types": {},
    }

    # Информация об авторах курса
    if fetch_instructors and course.get("instructors"):
        log.info("Fetching %d instructor(s)…", len(course["instructors"]))
        for i, user_id in enumerate(course["instructors"], 1):
            user = fetch_user(client, user_id)
            if user:
                inst_path = course_dir / f"_instructor_{i:02d}_{safe_name(user.get('first_name','')+user.get('last_name',''), 40)}"
                save_instructor_info(user, inst_path)
                stats["instructors"] += 1

    # Структура course_index.json
    course_index = {
        "course_id": course_id,
        "title": course["title"],
        "summary": course.get("summary", ""),
        "cover": cover,
        "sections": [],
    }

    for sec_idx, sec in enumerate(sections, 1):
        sec_dir = course_dir / f"{sec_idx:02d}_{safe_name(sec['title'], 60)}"
        sec_dir.mkdir(parents=True, exist_ok=True)

        units = [data["unit_by_id"][u_id] for u_id in sec["units"] if u_id in data["unit_by_id"]]
        log.info("[%d/%d] %s — %d units", sec_idx, len(sections), sec["title"], len(units))
        print(f"__PROGRESS__ phase=section section={sec_idx}/{len(sections)} "
              f"title={sec['title'][:80]}", flush=True)

        sec_index = {"position": sec_idx, "id": sec["id"], "title": sec["title"], "lessons": []}

        for u_idx, unit in enumerate(units, 1):
            lesson = data["lesson_by_id"].get(unit["lesson"])
            if not lesson:
                continue

            les_dir = sec_dir / f"{u_idx:02d}_{safe_name(lesson['title'], 70)}"
            les_dir.mkdir(parents=True, exist_ok=True)
            stats["lessons"] += 1

            les_index = {
                "position": u_idx, "id": lesson["id"], "title": lesson["title"],
                "is_public": lesson.get("is_public", False),
                "unit_id": unit["id"], "steps": [],
            }

            # Сохраняем meta урока
            (les_dir / "_lesson_meta.json").write_text(
                json.dumps(les_index, ensure_ascii=False, indent=2), encoding="utf-8"
            )

            # Если урок приватный — помечаем и идём дальше (без токена шаги пустые)
            if not lesson.get("is_public") and not token:
                (les_dir / "_PRIVATE_LESSON.txt").write_text(
                    "Этот урок не публичный. Чтобы выкачать его содержимое,\n"
                    "запустите скрипт с STEPIC_TOKEN (см. https://stepik.org/edit-profile/tokens).\n",
                    encoding="utf-8",
                )
                stats["skipped_private"] += 1
                sec_index["lessons"].append(les_index)
                continue

            step_ids = lesson["steps"]
            total_steps_in_lesson = len(step_ids)
            # Параллельная обработка шагов урока (3 потока —
            # больше не делаем, чтобы не упереться в rate-limit Stepik)
            def _process_step_threaded(args):
                _st_idx, _st_id = args
                _step = data["step_by_id"].get(_st_id)
                if not _step:
                    return None
                try:
                    return process_step(
                        step=_step,
                        lesson=lesson,
                        lesson_title=lesson["title"],
                        les_dir=les_dir,
                        st_idx=_st_idx,
                        client=client,
                        headers=headers,
                        skip_video=skip_video,
                        prefer_yt_dlp=prefer_yt_dlp,
                        fetch_sources=fetch_sources,
                        fetch_html=fetch_html,
                        fetch_subtitles=fetch_subtitles,
                        fetch_comments=fetch_comments,
                        token=token,
                    )
                except Exception as e:
                    log.warning("step %d failed: %s", _st_id, e)
                    return None

            with ThreadPoolExecutor(max_workers=3) as ex:
                futures = list(ex.map(
                    _process_step_threaded,
                    [(st_idx, st_id) for st_idx, st_id in enumerate(step_ids, 1)]
                ))
                for res in futures:
                    if res is None:
                        continue
                    local_stats, step_index = res
                    _merge_local_stats(stats, local_stats)
                    if step_index:
                        step_index.pop("resumed", None)
                        les_index["steps"].append(step_index)
            # Детальный прогресс: шаги в уроке + общая статистика
            done_steps = sum(len(l.get('steps', []))
                             for s in course_index.get('sections', [])[:sec_idx-1]
                             for l in s.get('lessons', []))
            done_steps += len(les_index.get('steps', []))
            print(f"__PROGRESS__ phase=lesson section={sec_idx}/{len(sections)} "
                  f"lesson={u_idx}/{len(units)} steps={total_steps_in_lesson} "
                  f"done_steps={done_steps} "
                  f"title={lesson['title'][:60]}", flush=True)

            sec_index["lessons"].append(les_index)

        course_index["sections"].append(sec_index)

    # Сохраняем course_index.json
    (course_dir / "_course_index.json").write_text(
        json.dumps(course_index, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 10. Отзывы о курсе (через /api/course-reviews)
    if fetch_reviews:
        log.info("Fetching course reviews…")
        print(f"__PROGRESS__ phase=reviews", flush=True)
        try:
            reviews_data = fetch_course_reviews(client, course_id)
            if reviews_data["reviews"]:
                save_course_reviews(reviews_data, course_dir / "_reviews", course["title"])
                stats["reviews"] = len(reviews_data["reviews"])
        except Exception as e:
            log.warning("reviews fetch failed: %s", e)

    # 11. Search index — для полнотекстового поиска по архиву
    if build_search_idx:
        log.info("Building search index…")
        try:
            search_idx = build_search_index(course_dir, course_index, course_id)
            (course_dir / "_search_index.json").write_text(
                json.dumps(search_idx, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            stats["search_index_entries"] = search_idx["entries_count"]
        except Exception as e:
            log.warning("search index build failed: %s", e)

    # 12. PDF-сборник курса (опционально)
    if build_pdf:
        log.info("Generating PDF book…")
        print(f"__PROGRESS__ phase=pdf", flush=True)
        try:
            if build_course_pdf(course_dir, course["title"], course_index):
                stats["pdf_book"] = 1
                log.info("PDF generated successfully")
        except Exception as e:
            log.warning("PDF generation failed: %s", e)

    # Финальный отчёт
    report_lines = []
    for k, v in stats.items():
        if k == "block_types":
            report_lines.append(f"- block_types:")
            for bt, cnt in v.items():
                report_lines.append(f"    - {bt}: {cnt}")
        else:
            report_lines.append(f"- {k}: {v}")
    (course_dir / "_REPORT.txt").write_text(
        f"Stepik course {course_id} dump report\n"
        f"=====================================\n\n" + "\n".join(report_lines) + "\n",
        encoding="utf-8",
    )
    log.info("Done. Stats: %s", stats)

    # Архивируем (tar.gz или zip)
    fmt = "zip" if archive_format == "zip" else "gztar"
    ext = ".zip" if fmt == "zip" else ".tar.gz"
    log.info("Packing %s …", ext)
    archive_base = out_root / course_dir_name
    archive_path = shutil.make_archive(str(archive_base), fmt,
                                       root_dir=out_root, base_dir=course_dir_name)
    log.info("Archive: %s", archive_path)

    # Verify archive integrity
    try:
        archive_size = os.path.getsize(archive_path)
        if fmt == "zip":
            import zipfile
            with zipfile.ZipFile(archive_path, "r") as zf:
                bad = zf.testzip()
                if bad:
                    log.warning("Archive integrity FAILED: %s is corrupt", bad)
                else:
                    log.info("Archive integrity OK (%d files, %.1f MB)",
                             len(zf.namelist()), archive_size / 1024 / 1024)
        else:
            import tarfile
            with tarfile.open(archive_path, "r:gz") as tf:
                members = tf.getmembers()
                log.info("Archive integrity OK (%d files, %.1f MB)",
                         len(members), archive_size / 1024 / 1024)
    except Exception as e:
        log.warning("Archive verification failed: %s", e)

    print(f"__PROGRESS__ phase=done stats={json.dumps(stats, ensure_ascii=False)} "
          f"archive={archive_path}", flush=True)
    return Path(archive_path)


# ─────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Dump a Stepik course into an archive.")
    ap.add_argument("--course-id", type=int,
                    default=int(os.environ.get("STEPIC_COURSE_ID", DEFAULT_COURSE_ID)))
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--token", default=os.environ.get("STEPIC_TOKEN", ""),
                    help="Stepik personal access token (https://stepik.org/edit-profile/tokens)")
    ap.add_argument("--client-id", default=os.environ.get("STEPIC_CLIENT_ID", ""),
                    help="OAuth2 application Client ID (https://stepik.org/oauth2/applications/)")
    ap.add_argument("--client-secret", default=os.environ.get("STEPIC_CLIENT_SECRET", ""),
                    help="OAuth2 application Client Secret")
    ap.add_argument("--no-video", action="store_true", help="Skip video downloads")
    ap.add_argument("--no-yt-dlp", action="store_true",
                    help="Use direct API video URLs instead of yt-dlp")
    ap.add_argument("--no-sources", action="store_true",
                    help="Skip step-sources fetch (no correct answers/tests)")
    ap.add_argument("--no-html", action="store_true",
                    help="Skip saving raw HTML of step text")
    ap.add_argument("--no-subtitles", action="store_true",
                    help="Skip downloading video subtitles separately")
    ap.add_argument("--no-comments", action="store_true",
                    help="Skip step comments fetching (/api/comments)")
    ap.add_argument("--no-reviews", action="store_true",
                    help="Skip course reviews fetching (/api/course-reviews)")
    ap.add_argument("--no-instructors", action="store_true",
                    help="Skip course instructor info fetching")
    ap.add_argument("--no-search-index", action="store_true",
                    help="Skip building _search_index.json")
    ap.add_argument("--build-pdf", action="store_true",
                    help="Also generate _course_book.pdf (requires pandoc + weasyprint)")
    ap.add_argument("--zip", action="store_true",
                    help="Use ZIP format instead of tar.gz")
    args = ap.parse_args()

    # Token: явный > OAuth2 client-credentials > анонимный
    token = args.token.strip() or None
    if not token and args.client_id and args.client_secret:
        log.info("Exchanging OAuth2 client-credentials for access token…")
        token = get_oauth_token(args.client_id.strip(), args.client_secret.strip())
        if token:
            log.info("OAuth2 token acquired successfully.")
        else:
            log.error("Failed to acquire OAuth2 token. Falling back to anonymous.")
    if not token:
        log.warning("No token — only public lessons will be downloaded.")

    out_root: Path = args.out
    out_root.mkdir(parents=True, exist_ok=True)

    try:
        archive = dump_course(
            course_id=args.course_id,
            out_root=out_root,
            token=token,
            skip_video=args.no_video,
            prefer_yt_dlp=not args.no_yt_dlp,
            fetch_sources=not args.no_sources,
            fetch_html=not args.no_html,
            fetch_subtitles=not args.no_subtitles,
            fetch_comments=not args.no_comments,
            fetch_reviews=not args.no_reviews,
            fetch_instructors=not args.no_instructors,
            build_pdf=args.build_pdf,
            build_search_idx=not args.no_search_index,
            archive_format="zip" if args.zip else "tar.gz",
        )
        print("\n=== Готово ===")
        print(f"Архив: {archive}")
        print(f"Распакованная версия: {out_root}")
    except Exception as e:
        log.error("FAILED: %s", e, exc_info=True)
        print(f"__PROGRESS__ phase=error error={str(e)[:200]}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
