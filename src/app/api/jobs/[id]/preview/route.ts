// /home/z/my-project/src/app/api/jobs/[id]/preview/route.ts
import { NextRequest, NextResponse } from "next/server";
import { loadJob } from "@/lib/jobs";
import path from "path";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const DOWNLOAD_DIR = "/home/z/my-project/download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  children?: FileEntry[];
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await loadJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (!job.archiveName) {
    return NextResponse.json({ error: "Archive is not ready" }, { status: 409 });
  }
  const fullPath = path.join(DOWNLOAD_DIR, job.archiveName);
  try {
    await fs.access(fullPath);
  } catch {
    return NextResponse.json({ error: "Archive file is missing on disk" }, { status: 410 });
  }

  const stat = await fs.stat(fullPath);

  let listing: string[] = [];
  try {
    if (job.archiveName.endsWith(".zip")) {
      const { stdout } = await execAsync(
        `unzip -l "${fullPath}" | awk 'NR>3 && NF>3 {for(i=4;i<=NF;i++) printf "%s ", $i; print ""}'`,
        { maxBuffer: 20 * 1024 * 1024 }
      );
      listing = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    } else {
      const { stdout } = await execAsync(`tar -tzf "${fullPath}"`, {
        maxBuffer: 20 * 1024 * 1024,
      });
      listing = stdout.split("\n").filter((s) => s && s !== "./");
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: `Failed to list archive: ${e?.message}` },
      { status: 500 }
    );
  }

  const truncated = listing.length > 5000;
  const items = truncated ? listing.slice(0, 5000) : listing;

  // Build tree from flat list of paths
  const root: FileEntry = { name: job.archiveName, type: "dir", size: 0, children: [] };
  const dirMap = new Map<string, FileEntry>();
  dirMap.set("", root);

  for (const entry of items) {
    const clean = entry.replace(/^\.\//, "").replace(/\/$/, "");
    if (!clean) continue;
    const parts = clean.split("/");
    let curPath = "";
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      curPath = curPath ? `${curPath}/${part}` : part;
      if (isLast && !entry.endsWith("/")) {
        cur.children!.push({ name: part, type: "file", size: 0 });
      } else {
        if (!dirMap.has(curPath)) {
          const dir: FileEntry = { name: part, type: "dir", size: 0, children: [] };
          dirMap.set(curPath, dir);
          cur.children!.push(dir);
        }
        cur = dirMap.get(curPath)!;
      }
    }
  }

  return NextResponse.json({
    archive: job.archiveName,
    size: stat.size,
    entries: listing.length,
    truncated,
    tree: root,
  });
}
