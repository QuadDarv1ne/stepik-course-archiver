// /home/z/my-project/src/app/api/health/route.ts
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const DOWNLOAD_DIR = "/home/z/my-project/download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const start = Date.now();
  const checks: Record<string, any> = {};

  // 1. Download dir
  try {
    const stat = await fs.stat(DOWNLOAD_DIR);
    checks.download_dir = { ok: true, exists: stat.isDirectory() };
  } catch {
    checks.download_dir = { ok: false, error: "not accessible" };
  }

  // 2. Disk usage
  try {
    const { stdout } = await execAsync(`df -h "${DOWNLOAD_DIR}" | tail -1`);
    const parts = stdout.trim().split(/\s+/);
    checks.disk = {
      ok: true,
      total: parts[1],
      used: parts[2],
      available: parts[3],
      usage: parts[4],
    };
  } catch {
    checks.disk = { ok: false };
  }

  // 3. Archives count and size
  try {
    const files = await fs.readdir(DOWNLOAD_DIR);
    const archives = files.filter(
      (f) => f.endsWith(".zip") || f.endsWith(".tar.gz")
    );
    let totalSize = 0;
    for (const f of archives) {
      try {
        const stat = await fs.stat(path.join(DOWNLOAD_DIR, f));
        totalSize += stat.size;
      } catch {}
    }
    checks.archives = {
      ok: true,
      count: archives.length,
      total_size_mb: Math.round((totalSize / 1024 / 1024) * 100) / 100,
    };
  } catch {
    checks.archives = { ok: false };
  }

  // 4. Jobs count
  try {
    const jobsDir = path.join(DOWNLOAD_DIR, ".jobs");
    const files = await fs.readdir(jobsDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    checks.jobs = { ok: true, count: jsonFiles.length };
  } catch {
    checks.jobs = { ok: false, count: 0 };
  }

  // 5. Python availability
  try {
    const { stdout } = await execAsync(
      "/home/z/.venv/bin/python3 --version 2>&1"
    );
    checks.python = { ok: true, version: stdout.trim() };
  } catch {
    checks.python = { ok: false };
  }

  const allOk = Object.values(checks).every((c: any) => c.ok);
  const elapsed = Date.now() - start;

  return NextResponse.json({
    status: allOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    response_time_ms: elapsed,
    checks,
  });
}
