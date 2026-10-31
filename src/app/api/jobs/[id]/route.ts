// /home/z/my-project/src/app/api/jobs/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { loadJob, readJobLog, killJob, deleteJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const job = await loadJob(id);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    const log = await readJobLog(id, 300);
    return NextResponse.json({ job, log });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to load job" },
      { status: 500 }
    );
  }
}

// DELETE /api/jobs/[id]              — остановить запущенную задачу (cancel)
// DELETE /api/jobs/[id]?purge=true   — полностью удалить задачу и архив
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const purge = req.nextUrl.searchParams.get("purge") === "true";

  try {
    if (purge) {
      const result = await deleteJob(id);
      return NextResponse.json({ ok: true, deleted: result.deleted.length });
    }
    const ok = await killJob(id);
    return NextResponse.json({ cancelled: ok });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to delete job" },
      { status: 500 }
    );
  }
}
