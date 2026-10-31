// /home/z/my-project/src/app/api/preview/route.ts
import { NextRequest, NextResponse } from "next/server";
import { previewCourse, parseCourseId } from "@/lib/stepik";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/preview { courseUrl, token? }
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const courseUrl: string = (body?.courseUrl || "").trim();
  const token: string | undefined = body?.token;
  if (!courseUrl) {
    return NextResponse.json({ error: "courseUrl is required" }, { status: 400 });
  }
  if (!parseCourseId(courseUrl)) {
    return NextResponse.json(
      { error: "Cannot parse course ID from URL" },
      { status: 400 }
    );
  }

  try {
    const preview = await previewCourse(courseUrl, token);
    return NextResponse.json({ preview });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to fetch course preview" },
      { status: 400 }
    );
  }
}
