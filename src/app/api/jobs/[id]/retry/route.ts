// /home/z/my-project/src/app/api/jobs/[id]/retry/route.ts
import { NextRequest, NextResponse } from "next/server";
import { retryJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/[id]/retry
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await retryJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.status === "running" || job.status === "queued") {
    return NextResponse.json(
      { error: "Job is already running", job },
      { status: 409 }
    );
  }
  return NextResponse.json({ job });
}
