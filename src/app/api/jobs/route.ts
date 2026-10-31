// /home/z/my-project/src/app/api/jobs/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createAndStartJob, listJobs, parseCourseId } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/jobs — список всех задач
export async function GET() {
  const jobs = await listJobs();
  return NextResponse.json({ jobs });
}

// POST /api/jobs — создать и запустить задачу
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const courseUrl: string = (body?.courseUrl || "").trim();
  const token: string | undefined = body?.token;
  const clientId: string | undefined = body?.clientId;
  const clientSecret: string | undefined = body?.clientSecret;
  const includeVideo: boolean = !!body?.includeVideo;
  const useYtDlp: boolean = body?.useYtDlp !== false;             // default true
  const fetchSources: boolean = body?.fetchSources !== false;     // default true
  const fetchHtml: boolean = body?.fetchHtml !== false;           // default true
  const fetchSubtitles: boolean = body?.fetchSubtitles !== false; // default true
  const fetchComments: boolean = body?.fetchComments !== false;   // default true
  const fetchReviews: boolean = body?.fetchReviews !== false;     // default true
  const fetchInstructors: boolean = body?.fetchInstructors !== false; // default true
  const buildPdf: boolean = !!body?.buildPdf;                      // default false
  const buildSearchIdx: boolean = body?.buildSearchIdx !== false;  // default true
  const zipFormat: boolean = body?.zipFormat !== false;            // default TRUE (ZIP)

  if (!courseUrl) {
    return NextResponse.json({ error: "courseUrl is required" }, { status: 400 });
  }
  const courseId = parseCourseId(courseUrl);
  if (!courseId) {
    return NextResponse.json(
      { error: "Cannot parse course ID from URL. Expected https://stepik.org/course/<id>/..." },
      { status: 400 }
    );
  }

  try {
    const job = await createAndStartJob({
      courseUrl,
      courseId,
      token,
      clientId,
      clientSecret,
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
    });
    return NextResponse.json({ job }, { status: 201 });
  } catch (e: any) {
    const msg = e?.message || "Failed to create job";
    const isConflict = msg.includes("Уже выполняется") || msg.includes("OAuth2");
    return NextResponse.json(
      { error: msg },
      { status: isConflict ? 409 : 500 }
    );
  }
}
