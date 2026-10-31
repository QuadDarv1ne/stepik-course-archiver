// /home/z/my-project/src/lib/jobs.ts
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { createInterface } from "readline";

// Абсолютные пути под /home/z/my-project/
const PROJECT_ROOT = "/home/z/my-project";
const DOWNLOAD_DIR = path.join(PROJECT_ROOT, "download");
const JOBS_DIR = path.join(DOWNLOAD_DIR, ".jobs");
const SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "stepik_course_dump.py");
const PYTHON_BIN = "/home/z/.venv/bin/python3";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobProgress {
  phase: "init" | "section" | "lesson" | "reviews" | "pdf" | "done" | "error" | "unknown";
  section?: string;     // e.g. "1/17"
  totalSections?: number;
  totalSteps?: number;  // общее число шагов в курсе
  lesson?: string;       // e.g. "1/4"
  totalLessons?: number;
  steps?: number;        // число шагов в текущем уроке
  doneSteps?: number;    // сколько шагов уже скачано (для %)
  title?: string;
  courseTitle?: string;
  stats?: Record<string, number>;
  archivePath?: string;
  error?: string;
}

const runningProcesses = new Map<string, ChildProcess>();

// Простой логгер
const log = {
  info: (m: string) => console.log(`[jobs] ${m}`),
  warn: (m: string) => console.warn(`[jobs] ${m}`),
  error: (m: string) => console.error(`[jobs] ${m}`),
};

// OAuth2 token cache (Stepik tokens live 10 hours)
interface CachedToken { token: string; expiresAt: number; }
const oauthTokenCache = new Map<string, CachedToken>();

// Per-job write locks to prevent JSON corruption
const jobWriteLocks = new Map<string, Promise<void>>();

async function getOAuthToken(clientId: string, clientSecret: string): Promise<string | null> {
  const cacheKey = `${clientId}:${clientSecret}`;
  const cached = oauthTokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 5 * 60 * 1000) return cached.token;
  try {
    const https = await import("https");
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const postData = "grant_type=client_credentials";
    const token = await new Promise<string | null>((resolve) => {
      const req = https.request("https://stepik.org/oauth2/token/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basicAuth}`,
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Connection: "close",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.access_token) resolve(parsed.access_token);
            else { log.error(`OAuth2: no access_token in response (status ${res.statusCode})`); resolve(null); }
          } catch (e: any) { log.error(`OAuth2 parse: ${e.message}`); resolve(null); }
        });
      });
      req.on("error", (e) => { log.error(`OAuth2 req: ${e.message}`); resolve(null); });
      req.write(postData);
      req.end();
    });
    if (token) {
      oauthTokenCache.set(cacheKey, { token, expiresAt: now + (36000 - 300) * 1000 });
      log.info("OAuth2 token cached (~10h)");
    }
    return token;
  } catch (e: any) { log.error(`OAuth2: ${e?.message || e}`); return null; }
}

async function ensureDirs() {
  await fs.mkdir(JOBS_DIR, { recursive: true });
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
}

function metaPath(jobId: string) {
  return path.join(JOBS_DIR, `${jobId}.json`);
}

function logPath(jobId: string) {
  return path.join(JOBS_DIR, `${jobId}.log`);
}

export async function loadJob(jobId: string): Promise<JobMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(jobId), "utf-8");
    return JSON.parse(raw) as JobMeta;
  } catch {
    return null;
  }
}

export async function listJobs(): Promise<JobMeta[]> {
  await ensureDirs();
  // Cleanup stale jobs (running > 2 hours without heartbeat) → mark as failed
  const STALE_THRESHOLD = 2 * 60 * 60 * 1000; // 2 hours
  const now = Date.now();
  const files = await fs.readdir(JOBS_DIR);
  const jobs: JobMeta[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const id = f.replace(/\.json$/, "");
    const j = await loadJob(id);
    if (!j) continue;
    // Stale detection
    if (
      (j.status === "running" || j.status === "queued") &&
      j.startedAt &&
      now - j.startedAt > STALE_THRESHOLD
    ) {
      j.status = "failed";
      j.errorMessage = `Задача зависла (нет прогресса более 2 часов). ` +
        `Возможно, процесс был убит OOM или сетью.`;
      j.finishedAt = now;
      await saveJob(j);
    }
    jobs.push(j);
  }
  jobs.sort((a, b) => b.createdAt - a.createdAt);

  // Auto-cleanup: keep last 30 completed/failed, delete older
  const KEEP = 30;
  const old = jobs.filter(j => j.status === "completed" || j.status === "failed");
  if (old.length > KEEP) {
    for (const j of old.slice(KEEP)) {
      try {
        await fs.unlink(metaPath(j.id));
        await fs.unlink(logPath(j.id));
        if (j.archiveName) {
          try { await fs.unlink(path.join(DOWNLOAD_DIR, j.archiveName)); } catch {}
        }
      } catch {}
    }
    const delIds = new Set(old.slice(KEEP).map(j => j.id));
    return jobs.filter(j => !delIds.has(j.id));
  }
  return jobs;
}

async function saveJob(job: JobMeta) {
  // Сериализуем записи — protect от race condition
  const prev = jobWriteLocks.get(job.id) || Promise.resolve();
  const next = prev.then(async () => {
    await fs.writeFile(metaPath(job.id), JSON.stringify(job, null, 2), "utf-8");
  });
  jobWriteLocks.set(job.id, next.catch(() => {}));
  await next;
}

export function parseCourseId(url: string): number | null {
  // https://stepik.org/course/207061/info or /promo or plain
  const m = url.match(/\/course\/(\d+)/);
  if (m) return Number(m[1]);
  const m2 = url.match(/^(\d+)$/);
  if (m2) return Number(m2[1]);
  return null;
}

// Парсер строк "__PROGRESS__ phase=X key=val key=val"
function parseProgressLine(line: string): JobProgress | null {
  if (!line.startsWith("__PROGRESS__")) return null;
  const rest = line.replace(/^__PROGRESS__\s*/, "");
  const out: JobProgress = { phase: "unknown" };

  // stats и archive/error могут содержать пробелы и спецсимволы — вытаскиваем
  // их по имени ключа через regex, а остаток токенизируем.
  const statsMatch = rest.match(/\bstats=(\{.*?\})\s/);
  if (statsMatch) {
    try { out.stats = JSON.parse(statsMatch[1]); } catch {}
  }
  // title="..." или title='...' — берём в кавычках целиком
  // если без кавычек — берём до конца строки НО это сломает archive=/error=.
  // Поэтому: archive= и error= всегда в конце строки.
  const archiveMatch = rest.match(/\barchive=(.+)$/);
  if (archiveMatch) {
    out.archivePath = archiveMatch[1].trim();
  }
  const errorMatch = rest.match(/\berror=(.+)$/);
  if (errorMatch) {
    out.error = errorMatch[1].trim();
  }

  // Сначала удалим stats=, archive=, error= (это сложные значения), затем —
  // вытащим title= отдельно, т.к. он тоже может содержать пробелы.
  let stripped = rest
    .replace(/\bstats=\{.*?\}\s?/, "")
    .replace(/\barchive=.+$/, "")
    .replace(/\berror=.+$/, "");

  // title=<значение до конца stripped строки>
  const titleMatch = stripped.match(/\btitle=(.+)$/);
  if (titleMatch) {
    out.title = titleMatch[1].trim();
    stripped = stripped.replace(/\btitle=.+$/, "");
  }
  // course_title=<значение до конца stripped строки>
  const courseTitleMatch = stripped.match(/\bcourse_title=(.+)$/);
  if (courseTitleMatch) {
    out.courseTitle = courseTitleMatch[1].trim();
    stripped = stripped.replace(/\bcourse_title=.+$/, "");
  }

  const tokens = stripped.trim().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    const v = t.slice(eq + 1);
    if (k === "phase") (out as any).phase = v;
    else if (k === "section") out.section = v;
    else if (k === "total_sections") out.totalSections = Number(v);
    else if (k === "total_steps") out.totalSteps = Number(v);
    else if (k === "lesson") out.lesson = v;
    else if (k === "total_lessons") out.totalLessons = Number(v);
    else if (k === "steps") out.steps = Number(v);
    else if (k === "done_steps") out.doneSteps = Number(v);
  }
  return out;
}

export interface CreateJobInput {
  courseUrl: string;
  courseId: number;
  token?: string;
  clientId?: string;
  clientSecret?: string;
  includeVideo?: boolean;
  useYtDlp?: boolean;
  fetchSources?: boolean;     // step-sources (правильные ответы, тесты)
  fetchHtml?: boolean;       // сохранять HTML шага
  fetchSubtitles?: boolean;  // субтитры видео отдельно
  fetchComments?: boolean;   // комментарии к шагам
  fetchReviews?: boolean;    // отзывы о курсе
  fetchInstructors?: boolean; // биография автора
  buildPdf?: boolean;        // PDF-сборник курса
  buildSearchIdx?: boolean;  // _search_index.json
  zipFormat?: boolean;       // ZIP (default) или tar.gz
}

export interface JobMeta {
  id: string;
  courseUrl: string;
  courseId: number;
  courseTitle: string | null;
  token: string | null;
  clientId: string | null;
  clientSecret: string | null;
  includeVideo: boolean;
  useYtDlp: boolean;
  fetchSources: boolean;
  fetchHtml: boolean;
  fetchSubtitles: boolean;
  fetchComments: boolean;
  fetchReviews: boolean;
  fetchInstructors: boolean;
  buildPdf: boolean;
  buildSearchIdx: boolean;
  zipFormat: boolean;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  archiveName: string | null;
  errorMessage: string | null;
  progress: JobProgress | null;
  stats: Record<string, number> | null;
}

export async function createAndStartJob(input: CreateJobInput): Promise<JobMeta> {
  await ensureDirs();

  // OAuth2: если есть clientId+clientSecret, обменяем на токен с кэшированием
  let token: string | null = input.token?.trim() || null;
  if (!token && input.clientId && input.clientSecret) {
    log.info("Pre-fetching OAuth2 token...");
    token = await getOAuthToken(input.clientId.trim(), input.clientSecret.trim());
    if (!token) {
      throw new Error("Не удалось получить OAuth2 токен. Проверьте Client ID и Client Secret.");
    }
  }

  const jobId = randomUUID().slice(0, 8);
  const now = Date.now();

  const job: JobMeta = {
    id: jobId,
    courseUrl: input.courseUrl,
    courseId: input.courseId,
    courseTitle: null,
    token,
    clientId: input.clientId?.trim() || null,
    clientSecret: input.clientSecret?.trim() || null,
    includeVideo: input.includeVideo ?? false,
    useYtDlp: input.useYtDlp ?? true,
    fetchSources: input.fetchSources ?? true,
    fetchHtml: input.fetchHtml ?? true,
    fetchSubtitles: input.fetchSubtitles ?? true,
    fetchComments: input.fetchComments ?? true,
    fetchReviews: input.fetchReviews ?? true,
    fetchInstructors: input.fetchInstructors ?? true,
    buildPdf: input.buildPdf ?? false,
    buildSearchIdx: input.buildSearchIdx ?? true,
    zipFormat: input.zipFormat ?? true,  // ZIP по умолчанию
    status: "queued",
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    archiveName: null,
    errorMessage: null,
    progress: null,
    stats: null,
  };
  await saveJob(job);

  // Запускаем асинхронно — не блокируем ответ API
  startJob(job).catch(async (err) => {
    job.status = "failed";
    job.errorMessage = `Failed to start: ${err?.message || String(err)}`;
    job.finishedAt = Date.now();
    await saveJob(job);
  });

  return job;
}

async function startJob(job: JobMeta) {
  const args = [
    SCRIPT_PATH,
    "--course-id", String(job.courseId),
    "--out", DOWNLOAD_DIR,
  ];
  if (!job.includeVideo) args.push("--no-video");
  if (!job.useYtDlp) args.push("--no-yt-dlp");
  if (!job.fetchSources) args.push("--no-sources");
  if (!job.fetchHtml) args.push("--no-html");
  if (!job.fetchSubtitles) args.push("--no-subtitles");
  if (!job.fetchComments) args.push("--no-comments");
  if (!job.fetchReviews) args.push("--no-reviews");
  if (!job.fetchInstructors) args.push("--no-instructors");
  if (!job.buildSearchIdx) args.push("--no-search-index");
  if (job.buildPdf) args.push("--build-pdf");
  if (job.zipFormat) args.push("--zip");

  const env: any = { ...process.env };
  if (job.token) env.STEPIC_TOKEN = job.token;
  if (job.clientId) env.STEPIC_CLIENT_ID = job.clientId;
  if (job.clientSecret) env.STEPIC_CLIENT_SECRET = job.clientSecret;

  const child = spawn(PYTHON_BIN, args, {
    env,
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  }) as any; // cast to avoid ChildProcess union type conflicts in Bun
  runningProcesses.set(job.id, child);

  job.status = "running";
  job.startedAt = Date.now();
  await saveJob(job);

  const logStream = await fs.open(logPath(job.id), "w");

  const rlOut = createInterface({ input: child.stdout! });
  const rlErr = createInterface({ input: child.stderr! });

  const handleLine = async (line: string, isStderr: boolean) => {
    const prefix = isStderr ? "" : "";
    await logStream.write(`${prefix}${line}\n`);

    const prog = parseProgressLine(line);
    if (prog) {
      job.progress = prog;
      if (prog.courseTitle) job.courseTitle = prog.courseTitle;
      if (prog.stats) job.stats = prog.stats;
      if (prog.archivePath) {
        job.archiveName = path.basename(prog.archivePath);
      }
      await saveJob(job);
    }
  };

  rlOut.on("line", (l) => handleLine(l, false));
  rlErr.on("line", (l) => handleLine(l, true));

  await new Promise<void>((resolve) => {
    child.on("close", async (code) => {
      runningProcesses.delete(job.id);
      await logStream.close();
      job.finishedAt = Date.now();
      if (code === 0) {
        job.status = "completed";
      } else {
        job.status = "failed";
        job.errorMessage = `Process exited with code ${code}`;
      }
      await saveJob(job);
      // Auto-start next queued job
      scheduleNextQueuedJob().catch(() => {});
      resolve();
    });
    child.on("error", async (err) => {
      runningProcesses.delete(job.id);
      await logStream.close();
      job.finishedAt = Date.now();
      job.status = "failed";
      job.errorMessage = `Spawn error: ${err.message}`;
      await saveJob(job);
      scheduleNextQueuedJob().catch(() => {});
      resolve();
    });
  });
}

/** Auto-start next queued job if no running job exists */
async function scheduleNextQueuedJob(): Promise<void> {
  const all = await listJobs();
  if (all.some(j => j.status === "running")) return;
  const queued = all.filter(j => j.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
  if (queued.length === 0) return;
  log.info(`Auto-starting queued job ${queued[0].id}...`);
  try { await startJob(queued[0]); }
  catch (e: any) {
    log.error(`Failed to start queued job: ${e?.message || e}`);
    queued[0].status = "failed";
    queued[0].errorMessage = `Auto-start failed: ${e?.message || e}`;
    queued[0].finishedAt = Date.now();
    await saveJob(queued[0]);
  }
}

export async function readJobLog(jobId: string, tail = 200): Promise<string[]> {
  try {
    const raw = await fs.readFile(logPath(jobId), "utf-8");
    const lines = raw.split("\n");
    return lines.slice(-tail);
  } catch {
    return [];
  }
}

export async function killJob(jobId: string): Promise<boolean> {
  const proc = runningProcesses.get(jobId);
  if (proc) {
    proc.kill("SIGTERM");
    return true;
  }
  // Если процесса нет — возможно queued. Помечаем как cancelled.
  const job = await loadJob(jobId);
  if (job && job.status === "queued") {
    job.status = "failed";
    job.errorMessage = "Отменено пользователем (из очереди)";
    job.finishedAt = Date.now();
    await saveJob(job);
    return true;
  }
  return false;
}

// Полное удаление задачи: убить процесс, удалить meta+log+archive+course_dir.
export async function deleteJob(jobId: string): Promise<{ ok: boolean; deleted: string[] }> {
  await killJob(jobId);
  const job = await loadJob(jobId);
  const deleted: string[] = [];

  // meta + log
  for (const p of [metaPath(jobId), logPath(jobId)]) {
    try { await fs.unlink(p); deleted.push(p); } catch {}
  }

  if (job) {
    // 1. Архив .tar.gz (имя уже известно из прогресса).
    if (job.archiveName) {
      const ap = path.join(DOWNLOAD_DIR, job.archiveName);
      try { await fs.unlink(ap); deleted.push(ap); } catch {}
    }
    // 2. Распакованная папка курса — сканируем download/ на наличие
    //    stepik_course_<courseId>_* (имя зависит от title, который мог ещё не сохраниться).
    const prefix = `stepik_course_${job.courseId}_`;
    let entries: string[] = [];
    try { entries = await fs.readdir(DOWNLOAD_DIR); } catch {}
    for (const name of entries) {
      if (name.startsWith(prefix)) {
        const p = path.join(DOWNLOAD_DIR, name);
        try {
          const stat = await fs.stat(p);
          if (stat.isDirectory()) {
            await fs.rm(p, { recursive: true, force: true });
            deleted.push(p);
          } else {
            await fs.unlink(p);
            deleted.push(p);
          }
        } catch {}
      }
    }
  }
  return { ok: true, deleted };
}

// Перезапуск задачи с теми же параметрами (для упавших/остановленных).
export async function retryJob(jobId: string): Promise<JobMeta | null> {
  const old = await loadJob(jobId);
  if (!old) return null;
  // Нельзя перезапустить активную задачу
  if (old.status === "running" || old.status === "queued") {
    return old;
  }
  // Сначала ОЧИСТИМ старые meta + log, чтобы избежать гонки при сохранении.
  try { await fs.unlink(metaPath(jobId)); } catch {}
  try { await fs.unlink(logPath(jobId)); } catch {}

  const newJob: JobMeta = {
    ...old,
    status: "queued",
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    progress: null,
    stats: null,
    // archiveName обнулим, чтобы старый архив не считался «актуальным»,
    // пока новый не дойдёт до phase=done.
    archiveName: null,
  };
  await saveJob(newJob);

  // Запускаем в фоне, без await.
  startJob(newJob).catch(async (err) => {
    const cur = await loadJob(jobId);
    if (cur) {
      cur.status = "failed";
      cur.errorMessage = `Failed to start: ${err?.message || String(err)}`;
      cur.finishedAt = Date.now();
      await saveJob(cur);
    }
  });

  return newJob;
}
