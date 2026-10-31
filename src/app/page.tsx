"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Download,
  Loader2,
  Link2,
  KeyRound,
  Video,
  Youtube,
  PlayCircle,
  CheckCircle2,
  XCircle,
  Clock,
  FileArchive,
  ExternalLink,
  Trash2,
  Eye,
  EyeOff,
  RefreshCw,
  Terminal,
  Sun,
  Moon,
  Search,
  Folder,
  RotateCcw,
  BookOpen,
  Users,
  Layers,
  Lock,
  Unlock,
  Sparkles,
} from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { toast, Toaster } from "@/components/ui/sonner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface JobProgress {
  phase: "init" | "section" | "lesson" | "reviews" | "pdf" | "done" | "error" | "unknown";
  section?: string;
  totalSections?: number;
  totalSteps?: number;
  lesson?: string;
  totalLessons?: number;
  steps?: number;
  doneSteps?: number;
  title?: string;
  courseTitle?: string;
  stats?: Record<string, number>;
  archivePath?: string;
  error?: string;
}

interface JobMeta {
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
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  archiveName: string | null;
  errorMessage: string | null;
  progress: JobProgress | null;
  stats: Record<string, number> | null;
}

interface CoursePreview {
  courseId: number;
  title: string;
  summary: string;
  cover: string | null;
  targetAudience: string | null;
  workload: string | null;
  totalSections: number;
  totalUnits: number;
  totalLessons: number;
  publicLessons: number;
  privateLessons: number;
  totalSteps: number;
  needsToken: boolean;
  ownerName: string | null;
  language: string | null;
}

// --- helpers ---

function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDuration(ms: number | null, end?: number | null): string {
  if (!ms) return "—";
  const e = end || Date.now();
  const sec = Math.max(0, Math.round((e - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function estimateRemaining(job: JobMeta): string | null {
  if (!job.startedAt || job.status !== "running") return null;
  if (!job.progress?.totalSections) return null;
  const m = job.progress.section?.match(/^(\d+)\//);
  if (!m) return null;
  const cur = Number(m[1]);
  const total = job.progress.totalSections;
  if (cur < 1) return null;
  const elapsed = Date.now() - job.startedAt;
  const per = elapsed / cur;
  const remaining = per * (total - cur);
  return fmtDuration(0, remaining);
}

function statusBadge(status: JobMeta["status"]) {
  const map = {
    queued: { cls: "bg-muted text-muted-foreground", icon: <Clock className="w-3 h-3 mr-1" /> },
    running: { cls: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900", icon: <Loader2 className="w-3 h-3 mr-1 animate-spin" /> },
    completed: { cls: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900", icon: <CheckCircle2 className="w-3 h-3 mr-1" /> },
    failed: { cls: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900", icon: <XCircle className="w-3 h-3 mr-1" /> },
  }[status];
  return (
    <Badge variant="outline" className={map.cls}>
      {map.icon} {status}
    </Badge>
  );
}

function progressPercent(job: JobMeta): number {
  if (job.status === "completed") return 100;
  if (job.status === "failed") return 100;
  if (!job.progress) return 0;
  // Приоритет: doneSteps / totalSteps — самый точный показатель
  if (job.progress.totalSteps && job.progress.doneSteps !== undefined) {
    const pct = Math.round((job.progress.doneSteps / job.progress.totalSteps) * 100);
    return Math.min(99, Math.max(3, pct));
  }
  // Фолбэк: по секциям
  if (job.progress.totalSections) {
    const m = job.progress.section?.match(/^(\d+)\//);
    if (m) {
      const cur = Number(m[1]);
      return Math.min(99, Math.round((cur / job.progress.totalSections) * 100));
    }
  }
  if (job.progress.phase === "init") return 3;
  if (job.progress.phase === "done") return 100;
  return 5;
}

// --- theme toggle ---

function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  // suppressHydrationWarning, т.к. next-themes выставляет класс на <html> после гидратации.
  const current = (theme === "system" ? resolvedTheme : theme) || "light";
  const isDark = current === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? "Светлая тема" : "Тёмная тема"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="h-9 w-9"
      suppressHydrationWarning
    >
      {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </Button>
  );
}

// --- preview card ---

function PreviewCard({ preview }: { preview: CoursePreview }) {
  const publicPct = preview.totalLessons
    ? Math.round((preview.publicLessons / preview.totalLessons) * 100)
    : 0;
  return (
    <Card className="border-emerald-200 dark:border-emerald-900 shadow-md overflow-hidden">
      <div className="flex flex-col sm:flex-row">
        {preview.cover ? (
          <div className="sm:w-48 shrink-0 bg-slate-100 dark:bg-slate-800">
            <img
              src={preview.cover}
              alt={preview.title}
              className="w-full h-48 sm:h-full object-cover"
            />
          </div>
        ) : null}
        <div className="flex-1 p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-semibold text-base sm:text-lg leading-tight">
                {preview.title}
              </h3>
              {preview.ownerName ? (
                <p className="text-xs text-slate-500 mt-0.5">автор: {preview.ownerName}</p>
              ) : null}
            </div>
            <Badge variant="outline" className="shrink-0">
              #{preview.courseId}
            </Badge>
          </div>

          {preview.summary ? (
            <p className="text-sm text-slate-600 dark:text-slate-400 line-clamp-3">
              {preview.summary}
            </p>
          ) : null}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat icon={<Layers className="w-3.5 h-3.5" />} label="секций" value={preview.totalSections} />
            <Stat icon={<BookOpen className="w-3.5 h-3.5" />} label="уроков" value={preview.totalLessons} />
            <Stat icon={<Unlock className="w-3.5 h-3.5 text-emerald-600" />} label="публичных" value={preview.publicLessons} />
            <Stat icon={<Lock className="w-3.5 h-3.5 text-amber-600" />} label="приватных" value={preview.privateLessons} />
          </div>

          {preview.totalLessons > 0 ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Доступность контента</span>
                <span>{publicPct}% публично</span>
              </div>
              <Progress value={publicPct} className="h-1.5" />
            </div>
          ) : null}

          {preview.needsToken ? (
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
              <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Курс содержит <strong>{preview.privateLessons}</strong> приватных уроков.
                Укажите Stepik API токен и заранее запишитесь на курс, чтобы выгрузить их всех.
              </span>
            </div>
          ) : (
            <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300 flex items-start gap-2">
              <Unlock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>Все уроки публичные — можно выгрузить без токена.</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-md bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700 px-2 py-1.5">
      <div className="flex items-center gap-1 text-slate-500 text-[10px] uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
        {value}
      </div>
    </div>
  );
}

// --- archive tree renderer ---

interface ArchiveNode {
  name: string;
  type: "file" | "dir";
  size: number;
  children?: ArchiveNode[];
}

function ArchiveTree({ node, depth }: { node: ArchiveNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const indent = depth * 16;

  if (node.type === "file") {
    return (
      <div
        className="text-xs font-mono py-0.5 text-slate-600 dark:text-slate-400"
        style={{ paddingLeft: indent + 20 }}
      >
        <FileArchive className="w-3 h-3 inline mr-1 opacity-50" />
        {node.name}
      </div>
    );
  }

  const childCount = node.children?.length || 0;
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="text-xs font-mono py-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 w-full text-left rounded"
        style={{ paddingLeft: indent + 4 }}
      >
        <span className="inline-block w-4">{expanded ? "▼" : "▶"}</span>
        <Folder className="w-3 h-3 inline mr-1 text-amber-500" />
        <span className="font-medium text-slate-700 dark:text-slate-300">{node.name}</span>
        {childCount > 0 && (
          <span className="text-slate-400 ml-2">({childCount})</span>
        )}
      </button>
      {expanded && node.children && (
        <div>
          {[...node.children]
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map((child, i) => (
              <ArchiveTree key={`${child.name}-${i}`} node={child} depth={depth + 1} />
            ))}
        </div>
      )}
    </div>
  );
}

// --- main page ---

export default function Home() {
  const [courseUrl, setCourseUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showClientSecret, setShowClientSecret] = useState(false);
  const [authMode, setAuthMode] = useState<"token" | "oauth">("token");
  const [includeVideo, setIncludeVideo] = useState(false);
  const [useYtDlp, setUseYtDlp] = useState(true);
  const [fetchSources, setFetchSources] = useState(true);
  const [fetchHtml, setFetchHtml] = useState(true);
  const [fetchSubtitles, setFetchSubtitles] = useState(true);
  const [fetchComments, setFetchComments] = useState(true);
  const [fetchReviews, setFetchReviews] = useState(true);
  const [fetchInstructors, setFetchInstructors] = useState(true);
  const [buildPdf, setBuildPdf] = useState(false);
  const [buildSearchIdx, setBuildSearchIdx] = useState(true);
  const [zipFormat, setZipFormat] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<JobMeta[]>([]);
  const [activeJobLog, setActiveJobLog] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState("");

  // Archive preview dialog
  const [previewArchive, setPreviewArchive] = useState<{
    jobId: string;
    tree: any;
    loading: boolean;
    error: string | null;
  } | null>(null);

  // Preview
  const [preview, setPreview] = useState<CoursePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewTimer = useRef<NodeJS.Timeout | null>(null);

  const logRefs = useRef<Record<string, HTMLPreElement | null>>({});

  const hasAuth = authMode === "token"
    ? !!token.trim()
    : !!clientId.trim() && !!clientSecret.trim();

  // load persisted state from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("stepik_archiver_settings");
      if (saved) {
        const s = JSON.parse(saved);
        if (typeof s.token === "string") setToken(s.token);
        if (typeof s.clientId === "string") setClientId(s.clientId);
        if (typeof s.clientSecret === "string") setClientSecret(s.clientSecret);
        if (typeof s.authMode === "string") setAuthMode(s.authMode as "token" | "oauth");
        if (typeof s.includeVideo === "boolean") setIncludeVideo(s.includeVideo);
        if (typeof s.useYtDlp === "boolean") setUseYtDlp(s.useYtDlp);
        if (typeof s.fetchSources === "boolean") setFetchSources(s.fetchSources);
        if (typeof s.fetchHtml === "boolean") setFetchHtml(s.fetchHtml);
        if (typeof s.fetchSubtitles === "boolean") setFetchSubtitles(s.fetchSubtitles);
        if (typeof s.fetchComments === "boolean") setFetchComments(s.fetchComments);
        if (typeof s.fetchReviews === "boolean") setFetchReviews(s.fetchReviews);
        if (typeof s.fetchInstructors === "boolean") setFetchInstructors(s.fetchInstructors);
        if (typeof s.buildPdf === "boolean") setBuildPdf(s.buildPdf);
        if (typeof s.buildSearchIdx === "boolean") setBuildSearchIdx(s.buildSearchIdx);
        if (typeof s.zipFormat === "boolean") setZipFormat(s.zipFormat);
      }
    } catch {}
  }, []);

  // persist settings
  useEffect(() => {
    try {
      localStorage.setItem(
        "stepik_archiver_settings",
        JSON.stringify({
          token, clientId, clientSecret, authMode,
          includeVideo, useYtDlp,
          fetchSources, fetchHtml, fetchSubtitles,
          fetchComments, fetchReviews, fetchInstructors,
          buildPdf, buildSearchIdx, zipFormat,
        })
      );
    } catch {}
  }, [token, clientId, clientSecret, authMode, includeVideo, useYtDlp, fetchSources, fetchHtml, fetchSubtitles,
      fetchComments, fetchReviews, fetchInstructors, buildPdf, buildSearchIdx, zipFormat]);

  const refreshJobs = useCallback(async () => {
    try {
      const r = await fetch("/api/jobs");
      const data = await r.json();
      setJobs(data.jobs || []);

      const targets: string[] = (data.jobs || [])
        .filter((j: JobMeta) => j.status === "running" || j.status === "queued")
        .map((j: JobMeta) => j.id);
      if (data.jobs?.[0]) targets.push(data.jobs[0].id);
      const unique = Array.from(new Set(targets));
      for (const id of unique) {
        try {
          const lr = await fetch(`/api/jobs/${id}`);
          const ld = await lr.json();
          setActiveJobLog((p) => ({ ...p, [id]: ld.log || [] }));
        } catch {}
      }
    } catch {}
  }, []);

  useEffect(() => {
    refreshJobs();
    // Адаптивный polling: 1 сек когда есть активная задача, иначе 5 сек
    let t: NodeJS.Timeout;
    const tick = () => {
      const hasActive = jobs.some(
        (j) => j.status === "running" || j.status === "queued"
      );
      const interval = hasActive ? 1000 : 5000;
      t = setTimeout(async () => {
        await refreshJobs();
        tick();
      }, interval);
    };
    tick();
    return () => {
      if (t) clearTimeout(t);
    };
  }, [refreshJobs, jobs]);

  useEffect(() => {
    for (const id in logRefs.current) {
      const el = logRefs.current[id];
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [activeJobLog]);

  // Debounced preview when courseUrl changes
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (previewTimer.current) clearTimeout(previewTimer.current);

    const url = courseUrl.trim();
    if (!url || !/stepik\.org\/course\/\d+/.test(url) && !/^\d+$/.test(url)) {
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    previewTimer.current = setTimeout(async () => {
      try {
        const r = await fetch("/api/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            courseUrl: url,
            token: token.trim() || undefined,
          }),
        });
        const data = await r.json();
        if (!r.ok) {
          setPreviewError(data.error || "Failed to load preview");
          setPreview(null);
        } else {
          setPreview(data.preview);
          setPreviewError(null);
        }
      } catch (e: any) {
        setPreviewError(e.message || "Network error");
      } finally {
        setPreviewLoading(false);
      }
    }, 600);

    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [courseUrl, token]);

  const handleSubmit = async () => {
    if (!courseUrl.trim()) {
      toast.error("Укажите URL курса Stepik");
      return;
    }
    if (
      !/stepik\.org\/course\/\d+/.test(courseUrl.trim()) &&
      !/^\d+$/.test(courseUrl.trim())
    ) {
      toast.error("URL должен выглядеть как https://stepik.org/course/207061/...");
      return;
    }
    if (preview?.needsToken && !hasAuth) {
      toast.warning(
        "Курс содержит приватные уроки — без токена они будут пропущены"
      );
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseUrl: courseUrl.trim(),
          token: authMode === "token" ? (token.trim() || undefined) : undefined,
          clientId: authMode === "oauth" ? (clientId.trim() || undefined) : undefined,
          clientSecret: authMode === "oauth" ? (clientSecret.trim() || undefined) : undefined,
          includeVideo,
          useYtDlp,
          fetchSources,
          fetchHtml,
          fetchSubtitles,
          fetchComments,
          fetchReviews,
          fetchInstructors,
          buildPdf,
          buildSearchIdx,
          zipFormat,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data.error || "Не удалось запустить задачу");
        return;
      }
      toast.success(`Задача #${data.job.id} запущена`);
      setCourseUrl("");
      setPreview(null);
      await refreshJobs();
    } catch (e: any) {
      toast.error(e.message || "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    toast.info("Запрос на остановку отправлен");
    await refreshJobs();
  };

  const handleDelete = async (id: string) => {
    try {
      const r = await fetch(`/api/jobs/${id}?purge=true`, { method: "DELETE" });
      if (r.ok) {
        toast.success("Архив и задача удалены");
        await refreshJobs();
      } else {
        toast.error("Не удалось удалить");
      }
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleRetry = async (id: string) => {
    try {
      const r = await fetch(`/api/jobs/${id}/retry`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data.error || "Не удалось перезапустить");
        return;
      }
      toast.success(`Задача #${id} перезапущена`);
      await refreshJobs();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const loadArchivePreview = async (jobId: string) => {
    setPreviewArchive({ jobId, tree: null, loading: true, error: null });
    try {
      const r = await fetch(`/api/jobs/${jobId}/preview`);
      const data = await r.json();
      if (!r.ok) {
        setPreviewArchive({ jobId, tree: null, loading: false, error: data.error || "Ошибка" });
        return;
      }
      setPreviewArchive({ jobId, tree: data, loading: false, error: null });
    } catch (e: any) {
      setPreviewArchive({ jobId, tree: null, loading: false, error: e.message });
    }
  };

  const activeJob = jobs.find((j) => j.status === "running" || j.status === "queued");
  const filteredJobs = useMemo(() => {
    if (!search.trim()) return jobs;
    const q = search.toLowerCase();
    return jobs.filter(
      (j) =>
        j.courseTitle?.toLowerCase().includes(q) ||
        String(j.courseId).includes(q) ||
        j.courseUrl.toLowerCase().includes(q)
    );
  }, [jobs, search]);

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-emerald-50/30 dark:from-slate-950 dark:via-slate-950 dark:to-emerald-950/20">
      <Toaster richColors position="top-right" />

      {/* Header */}
      <header className="border-b bg-white/70 dark:bg-slate-950/70 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <FileArchive className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Stepik Course Archiver</h1>
              <p className="text-xs text-slate-500">Скачивайте курсы Stepik в полноценные архивы</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <a
              href="https://stepik.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 inline-flex items-center gap-1"
            >
              stepik.org <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Hero / form */}
        <section className="space-y-6">
          <div className="text-center space-y-2 pt-4">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-xs font-medium">
              <Sparkles className="w-3 h-3" />
              Превью курса прямо в браузере
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
              Архив любого курса Stepik
            </h2>
            <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
              Вставьте URL курса — скрипт выгрузит теорию, видео, задачи и вложения,
              упакует всё в <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-emerald-700 dark:text-emerald-400 font-mono text-sm">.tar.gz</code> архив
              и даст ссылку на скачивание.
            </p>
          </div>

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-emerald-600" />
                Новый архив
              </CardTitle>
              <CardDescription>
                Запись на курс обязательна для приватных уроков. Токен нужен только
                для доступа к закрытым материалам.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="url">URL курса Stepik</Label>
                <Input
                  id="url"
                  placeholder="https://stepik.org/course/207061/info"
                  value={courseUrl}
                  onChange={(e) => setCourseUrl(e.target.value)}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-slate-500">
                  Принимается URL вида <code>stepik.org/course/&lt;id&gt;</code> или просто
                  числовой ID курса.
                </p>
              </div>

              {/* Preview */}
              {previewLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500 py-3">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Загрузка превью курса…
                </div>
              ) : previewError ? (
                <div className="rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                  {previewError}
                </div>
              ) : preview ? (
                <PreviewCard preview={preview} />
              ) : null}

              <div className="space-y-3">
                <Tabs value={authMode} onValueChange={(v) => setAuthMode(v as "token" | "oauth")}>
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                      <KeyRound className="w-3.5 h-3.5" />
                      Авторизация (опционально)
                    </Label>
                    <TabsList className="h-8">
                      <TabsTrigger value="token" className="text-xs px-2 py-1">Token</TabsTrigger>
                      <TabsTrigger value="oauth" className="text-xs px-2 py-1">OAuth2 App</TabsTrigger>
                    </TabsList>
                  </div>

                  <TabsContent value="token" className="space-y-2 mt-2">
                    <div className="relative">
                      <Input
                        type={showToken ? "text" : "password"}
                        placeholder="Permanent access token с https://stepik.org/edit-profile/tokens"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        className="font-mono text-sm pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken((s) => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        aria-label={showToken ? "Скрыть" : "Показать"}
                      >
                        {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-slate-500">
                      Получите на{" "}
                      <a className="text-emerald-700 dark:text-emerald-400 underline" href="https://stepik.org/edit-profile/tokens" target="_blank" rel="noopener noreferrer">
                        stepik.org/edit-profile/tokens
                      </a>
                    </p>
                  </TabsContent>

                  <TabsContent value="oauth" className="space-y-2 mt-2">
                    <p className="text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-md p-2">
                      <KeyRound className="w-3 h-3 inline mr-1" />
                      Создайте OAuth2 приложение на{" "}
                      <a className="text-emerald-700 dark:text-emerald-400 underline" href="https://stepik.org/oauth2/applications/" target="_blank" rel="noopener noreferrer">
                        stepik.org/oauth2/applications/
                      </a>{" "}
                      с типом <strong>client-credentials</strong>. Скрипт сам обменяет креды на токен.
                    </p>
                    <div className="space-y-2">
                      <Input
                        placeholder="Client ID"
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        className="font-mono text-sm"
                      />
                      <div className="relative">
                        <Input
                          type={showClientSecret ? "text" : "password"}
                          placeholder="Client Secret"
                          value={clientSecret}
                          onChange={(e) => setClientSecret(e.target.value)}
                          className="font-mono text-sm pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowClientSecret((s) => !s)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                          aria-label={showClientSecret ? "Скрыть" : "Показать"}
                        >
                          {showClientSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </TabsContent>
                </Tabs>
                <p className="text-xs text-slate-500">
                  Без авторизации будут скачаны только публичные уроки. Настройки сохраняются в этом браузере.
                </p>
              </div>

              <div className="space-y-3">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                  Контент шагов
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="flex items-center gap-2">
                      <Video className="w-4 h-4 text-rose-500" />
                      <div>
                        <div className="text-sm font-medium">Видео</div>
                        <div className="text-xs text-slate-500">mp4 + thumbnail в лучшем качестве</div>
                      </div>
                    </div>
                    <Switch checked={includeVideo} onCheckedChange={setIncludeVideo} />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="flex items-center gap-2">
                      <Youtube className="w-4 h-4 text-amber-500" />
                      <div>
                        <div className="text-sm font-medium">Использовать yt-dlp</div>
                        <div className="text-xs text-slate-500">лучшее качество и субтитры</div>
                      </div>
                    </div>
                    <Switch
                      checked={useYtDlp}
                      onCheckedChange={setUseYtDlp}
                      disabled={!includeVideo}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="flex items-center gap-2">
                      <KeyRound className="w-4 h-4 text-violet-500" />
                      <div>
                        <div className="text-sm font-medium">Ответы и тесты</div>
                        <div className="text-xs text-slate-500">
                          step-sources: правильные ответы, тесты кода, эталоны
                        </div>
                      </div>
                    </div>
                    <Switch
                      checked={fetchSources}
                      onCheckedChange={setFetchSources}
                      disabled={!hasAuth}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="flex items-center gap-2">
                      <FileArchive className="w-4 h-4 text-emerald-500" />
                      <div>
                        <div className="text-sm font-medium">Исходный HTML</div>
                        <div className="text-xs text-slate-500">100% точная копия текста шага</div>
                      </div>
                    </div>
                    <Switch checked={fetchHtml} onCheckedChange={setFetchHtml} />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-sky-500" />
                      <div>
                        <div className="text-sm font-medium">Субтитры видео</div>
                        <div className="text-xs text-slate-500">.vtt для всех языков</div>
                      </div>
                    </div>
                    <Switch
                      checked={fetchSubtitles}
                      onCheckedChange={setFetchSubtitles}
                      disabled={!includeVideo}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-rose-500" />
                      <div>
                        <div className="text-sm font-medium">Комментарии к шагам</div>
                        <div className="text-xs text-slate-500">обсуждения + ответы автора</div>
                      </div>
                    </div>
                    <Switch checked={fetchComments} onCheckedChange={setFetchComments} />
                  </div>
                </div>

                {!hasAuth && fetchSources ? (
                  <div className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
                    <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                      Для скачивания ответов и эталонных тестов нужен Stepik API токен.
                      Без него будут доступны только публичные шаблоны кода и примеры.
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="space-y-3">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                  Доп. материалы курса
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-fuchsia-500" />
                      <div>
                        <div className="text-sm font-medium">Отзывы о курсе</div>
                        <div className="text-xs text-slate-500">★ рейтинги, тексты, ответы автора</div>
                      </div>
                    </div>
                    <Switch checked={fetchReviews} onCheckedChange={setFetchReviews} />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-cyan-500" />
                      <div>
                        <div className="text-sm font-medium">Информация об авторе</div>
                        <div className="text-xs text-slate-500">биография, аватар, ссылки</div>
                      </div>
                    </div>
                    <Switch checked={fetchInstructors} onCheckedChange={setFetchInstructors} />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="flex items-center gap-2">
                      <Search className="w-4 h-4 text-orange-500" />
                      <div>
                        <div className="text-sm font-medium">Поисковый индекс</div>
                        <div className="text-xs text-slate-500">_search_index.json для поиска</div>
                      </div>
                    </div>
                    <Switch checked={buildSearchIdx} onCheckedChange={setBuildSearchIdx} />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                    <div className="flex items-center gap-2">
                      <FileArchive className="w-4 h-4 text-rose-500" />
                      <div>
                        <div className="text-sm font-medium">PDF-сборник курса</div>
                        <div className="text-xs text-slate-500">
                          объединить все шаги в один PDF (~2 мин)
                        </div>
                      </div>
                    </div>
                    <Switch checked={buildPdf} onCheckedChange={setBuildPdf} />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 p-3 sm:col-span-2">
                    <div className="flex items-center gap-2">
                      <FileArchive className="w-4 h-4 text-indigo-500" />
                      <div>
                        <div className="text-sm font-medium">Формат ZIP (по умолчанию)</div>
                        <div className="text-xs text-slate-500">выключите, чтобы скачать .tar.gz для Linux/Mac</div>
                      </div>
                    </div>
                    <Switch checked={zipFormat} onCheckedChange={setZipFormat} />
                  </div>
                </div>

                {buildPdf ? (
                  <div className="text-xs text-slate-600 dark:text-slate-400 flex items-start gap-2">
                    <FileArchive className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                      PDF генерируется через pandoc + weasyprint — добавляет ~1-2 минуты
                      к общему времени. Поддерживается оглавление и кириллица.
                    </span>
                  </div>
                ) : null}
              </div>

              <Button
                onClick={handleSubmit}
                disabled={submitting || !!activeJob}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                size="lg"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <PlayCircle className="w-4 h-4 mr-2" />
                )}
                {submitting
                  ? "Запуск…"
                  : activeJob
                  ? `Уже выполняется задача #${activeJob.id}`
                  : "Запустить выгрузку"}
              </Button>
              {activeJob ? (
                <p className="text-xs text-center text-amber-700 dark:text-amber-400">
                  Дождитесь завершения текущей задачи, прежде чем запускать новую —
                  Stepik ограничивает частоту запросов к API.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </section>

        {/* Active job progress */}
        {activeJob ? (
          <section>
            <Card className="border-emerald-200 dark:border-emerald-900 shadow-md">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 text-emerald-600 animate-spin" />
                    Задача #{activeJob.id}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCancel(activeJob.id)}
                    className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Остановить
                  </Button>
                </CardTitle>
                <CardDescription className="font-mono text-xs">
                  {activeJob.courseUrl}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium truncate">
                    {activeJob.progress?.title || activeJob.progress?.courseTitle || "Загрузка…"}
                  </span>
                  <span className="font-mono text-slate-600 dark:text-slate-400">
                    {progressPercent(activeJob)}%
                  </span>
                </div>
                <Progress value={progressPercent(activeJob)} className="h-2" />
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>
                      Фаза: <code className="text-slate-700 dark:text-slate-300">{activeJob.progress?.phase || "init"}</code>
                    </span>
                    {activeJob.progress?.section ? (
                      <span className="font-mono">
                        секция {activeJob.progress.section}
                        {activeJob.progress.totalSections ? `/${activeJob.progress.totalSections}` : ""}
                      </span>
                    ) : null}
                    {activeJob.progress?.lesson ? (
                      <span className="font-mono">
                        · урок {activeJob.progress.lesson}
                        {activeJob.progress.steps ? ` (${activeJob.progress.steps} шагов)` : ""}
                      </span>
                    ) : null}
                    {activeJob.progress?.totalSteps && activeJob.progress?.doneSteps !== undefined ? (
                      <span className="font-mono text-emerald-600 dark:text-emerald-400">
                        · {activeJob.progress.doneSteps}/{activeJob.progress.totalSteps} шагов
                      </span>
                    ) : null}
                    {activeJob.progress?.title ? (
                      <span className="truncate max-w-[200px]">
                        · {activeJob.progress.title}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-3 shrink-0">
                    <span>{fmtDuration(activeJob.startedAt, activeJob.finishedAt)}</span>
                    {estimateRemaining(activeJob) ? (
                      <span>~ осталось {estimateRemaining(activeJob)}</span>
                    ) : null}
                  </span>
                </div>
              </CardContent>
            </Card>
          </section>
        ) : null}

        {/* Jobs list */}
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <FileArchive className="w-5 h-5" />
              Архивы ({jobs.length})
            </h3>
            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:flex-initial">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input
                  placeholder="Поиск…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 text-sm h-9 w-full sm:w-56"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={refreshJobs}
                disabled={submitting}
                className="h-9"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                <span className="hidden sm:inline">Обновить</span>
              </Button>
            </div>
          </div>

          {jobs.length === 0 ? (
            <Card className="border-dashed border-slate-300 dark:border-slate-700">
              <CardContent className="py-12 text-center text-slate-500 dark:text-slate-400">
                <FileArchive className="w-10 h-10 mx-auto mb-3 text-slate-300 dark:text-slate-600" />
                <p className="text-sm">Пока нет ни одного архива</p>
                <p className="text-xs mt-1">
                  Запустите выгрузку курса, чтобы увидеть его здесь
                </p>
              </CardContent>
            </Card>
          ) : filteredJobs.length === 0 ? (
            <Card className="border-dashed border-slate-300 dark:border-slate-700">
              <CardContent className="py-8 text-center text-slate-500">
                <p className="text-sm">Ничего не найдено по запросу «{search}»</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {filteredJobs.slice(0, 20).map((job) => (
                <Card key={job.id} className="shadow-sm overflow-hidden">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                          {job.courseTitle || `Course #${job.courseId}`}
                          {statusBadge(job.status)}
                        </CardTitle>
                        <CardDescription className="font-mono text-xs mt-1 truncate">
                          {job.courseUrl}
                        </CardDescription>
                      </div>
                      <div className="text-right text-xs text-slate-500 shrink-0">
                        <div>создан: {fmtDate(job.createdAt)}</div>
                        <div>длительность: {fmtDuration(job.startedAt, job.finishedAt)}</div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {job.status === "running" || job.status === "queued" ? (
                      <>
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium truncate">
                            {job.progress?.title || "Загрузка…"}
                          </span>
                          <span className="font-mono text-slate-600 dark:text-slate-400">
                            {progressPercent(job)}%
                          </span>
                        </div>
                        <Progress value={progressPercent(job)} className="h-1.5" />
                        {estimateRemaining(job) ? (
                          <p className="text-xs text-slate-500 text-right">
                            ~ осталось {estimateRemaining(job)}
                          </p>
                        ) : null}
                      </>
                    ) : null}

                    {job.stats ? (
                      <div className="space-y-2">
                        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
                          {Object.entries(job.stats)
                            .filter(([k]) => k !== "block_types")
                            .map(([k, v]) => (
                              <div
                                key={k}
                                className="rounded bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700 px-2 py-1.5"
                              >
                                <div className="text-slate-500 text-[10px] uppercase tracking-wide">
                                  {k}
                                </div>
                                <div className="font-mono font-semibold">
                                  {typeof v === "number" ? v : String(v)}
                                </div>
                              </div>
                            ))}
                        </div>
                        {job.stats.block_types ? (
                          <div className="flex flex-wrap gap-1.5">
                            <span className="text-[10px] text-slate-500 uppercase tracking-wide self-center">
                              типы шагов:
                            </span>
                            {Object.entries(job.stats.block_types as unknown as Record<string, number>).map(
                              ([bt, cnt]) => (
                                <Badge
                                  key={bt}
                                  variant="outline"
                                  className="font-mono text-[10px]"
                                >
                                  {bt}: {cnt}
                                </Badge>
                              )
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {job.status === "failed" && job.errorMessage ? (
                      <div className="rounded bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 p-2 text-xs text-rose-700 dark:text-rose-300 font-mono">
                        {job.errorMessage}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2">
                      {job.archiveName && (job.status === "completed" || job.status === "failed") ? (
                        <>
                          <Button
                            asChild
                            size="sm"
                            className="bg-emerald-600 hover:bg-emerald-700 text-white"
                          >
                            <a href={`/api/jobs/${job.id}/download`}>
                              <Download className="w-3.5 h-3.5 mr-1" />
                              Скачать {job.archiveName?.endsWith(".zip") ? ".zip" : ".tar.gz"}
                              {job.status === "failed" ? " (старый)" : ""}
                            </a>
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => loadArchivePreview(job.id)}
                          >
                            <FileArchive className="w-3.5 h-3.5 mr-1" />
                            Просмотр архива
                          </Button>
                        </>
                      ) : null}
                      <Button asChild size="sm" variant="outline">
                        <a
                          href={`https://stepik.org/course/${job.courseId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="w-3.5 h-3.5 mr-1" />
                          Открыть курс
                        </a>
                      </Button>

                      {(job.status === "failed" || job.status === "completed") && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRetry(job.id)}
                          disabled={!!activeJob}
                        >
                          <RotateCcw className="w-3.5 h-3.5 mr-1" />
                          Перезапустить
                        </Button>
                      )}

                      {(job.status === "running" || job.status === "queued") ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleCancel(job.id)}
                          className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1" />
                          Остановить
                        </Button>
                      ) : (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                            >
                              <Trash2 className="w-3.5 h-3.5 mr-1" />
                              Удалить
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Удалить архив?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Будут удалены: задача #{job.id}, её архив
                                {job.archiveName ? ` (${job.archiveName})` : ""}
                                {" "}и распакованная папка курса. Действие необратимо.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Отмена</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDelete(job.id)}
                                className="bg-rose-600 hover:bg-rose-700 text-white"
                              >
                                Удалить
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>

                    {activeJobLog[job.id] && activeJobLog[job.id].length > 0 ? (
                      <Accordion type="single" collapsible>
                        <AccordionItem value="log" className="border-0">
                          <AccordionTrigger className="text-xs hover:no-underline py-2 text-slate-600 dark:text-slate-400">
                            <span className="flex items-center gap-2">
                              <Terminal className="w-3.5 h-3.5" />
                              Лог выполнения ({activeJobLog[job.id].length} строк)
                            </span>
                          </AccordionTrigger>
                          <AccordionContent>
                            <pre
                              ref={(el) => {
                                logRefs.current[job.id] = el;
                              }}
                              className="max-h-72 overflow-y-auto rounded bg-slate-950 text-slate-100 text-[11px] font-mono p-3 leading-relaxed"
                            >
                              {activeJobLog[job.id].slice(-200).join("\n")}
                            </pre>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
              {filteredJobs.length > 20 && (
                <div className="text-center text-xs text-slate-500 py-2">
                  Показаны первые 20 из {filteredJobs.length}. Используйте поиск для фильтрации.
                </div>
              )}
            </div>
          )}
        </section>

        {/* Archive preview dialog */}
        <Dialog
          open={!!previewArchive}
          onOpenChange={(open) => { if (!open) setPreviewArchive(null); }}
        >
          <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>Содержимое архива</DialogTitle>
              <DialogDescription>
                {previewArchive?.tree?.archive
                  ? `${previewArchive.tree.archive} · ${previewArchive.tree.entries} элементов${
                      previewArchive.tree.size ? ` · ${(previewArchive.tree.size / 1024 / 1024).toFixed(1)} МБ` : ""
                    }${previewArchive.tree.truncated ? " · (показаны первые 5000)" : ""}`
                  : previewArchive?.loading ? "Загрузка…" : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto pr-2">
              {previewArchive?.loading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500 py-8 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Получение списка файлов из архива…
                </div>
              ) : previewArchive?.error ? (
                <div className="text-sm text-rose-600 dark:text-rose-400 py-4">
                  {previewArchive.error}
                </div>
              ) : previewArchive?.tree?.tree ? (
                <ArchiveTree node={previewArchive.tree.tree} depth={0} />
              ) : null}
            </div>
          </DialogContent>
        </Dialog>

        {/* Help / FAQ */}
        <section>
          <Card className="bg-slate-50 dark:bg-slate-900/50">
            <CardHeader>
              <CardTitle className="text-base">Как получить токен Stepik</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-slate-700 dark:text-slate-300 space-y-2">
              <ol className="list-decimal list-inside space-y-1">
                <li>
                  Запишитесь на курс — откройте страницу курса и нажмите{" "}
                  <strong>«Записаться»</strong>.
                </li>
                <li>
                  Откройте{" "}
                  <a
                    className="text-emerald-700 dark:text-emerald-400 underline"
                    href="https://stepik.org/edit-profile/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    stepik.org/edit-profile/tokens
                  </a>
                  .
                </li>
                <li>Нажмите <strong>«Создать новый токен»</strong>.</li>
                <li>Скопируйте значение и вставьте его в поле выше.</li>
              </ol>
              <Separator className="my-3" />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Токен хранится только в памяти браузера (localStorage) и в оперативной
                памяти сервера на время выгрузки. Не логируется на диск. Используется
                исключительно для авторизации в REST API Stepik.
              </p>
            </CardContent>
          </Card>
        </section>
      </main>

      <footer className="border-t mt-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 text-xs text-slate-500 flex items-center justify-between">
          <span>
            Powered by{" "}
            <a
              href="https://stepik.org/api/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-slate-900 dark:hover:text-slate-100 underline"
            >
              Stepik REST API
            </a>{" "}
            + yt-dlp
          </span>
          <span className="font-mono">For personal use only</span>
        </div>
      </footer>
    </div>
  );
}
