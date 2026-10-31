// /home/z/my-project/src/lib/stepik.ts
// Lightweight Stepik API client for course preview (no Python needed).

const API = "https://stepik.org/api";

export interface CoursePreview {
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
  totalSteps: number;     // only counts for public lessons (or all if token given)
  needsToken: boolean;
  ownerName: string | null;
  language: string | null;
}

async function apiGet(path: string, token?: string): Promise<any> {
  const headers: Record<string, string> = {
    "Accept-Language": "ru",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${API}/${path}`, {
        headers,
        // @ts-ignore — Next.js supports `cache: 'no-store'`
        cache: "no-store",
      });
      if (r.status === 429) {
        const wait = Number(r.headers.get("Retry-After") || 2);
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      if (r.status === 401) {
        throw new Error("Invalid Stepik token (401 Unauthorized)");
      }
      if (!r.ok) {
        throw new Error(`Stepik API ${r.status}: ${await r.text()}`);
      }
      return await r.json();
    } catch (e: any) {
      if (attempt === 3) throw e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
}

async function apiGetMany(resource: string, ids: number[], token?: string): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const params = new URLSearchParams();
    for (const id of chunk) params.append("ids[]", String(id));
    const data = await apiGet(`${resource}?${params.toString()}`, token);
    out.push(...(data[resource] || []));
  }
  return out;
}

export function parseCourseId(url: string): number | null {
  const m = url.match(/\/course\/(\d+)/);
  if (m) return Number(m[1]);
  const m2 = url.match(/^(\d+)$/);
  if (m2) return Number(m2[1]);
  return null;
}

export async function previewCourse(
  courseUrl: string,
  token?: string
): Promise<CoursePreview> {
  const courseId = parseCourseId(courseUrl);
  if (!courseId) {
    throw new Error(
      "Cannot parse course ID. Expected https://stepik.org/course/<id>/... or just <id>."
    );
  }

  const courseData = await apiGet(`courses/${courseId}`, token);
  const course = courseData.courses?.[0];
  if (!course) {
    throw new Error(`Course #${courseId} not found or access denied`);
  }

  // Owner name
  let ownerName: string | null = null;
  if (course.owner) {
    try {
      const u = await apiGet(`users/${course.owner}`, token);
      ownerName = u.users?.[0]
        ? `${u.users[0].first_name} ${u.users[0].last_name}`.trim() || null
        : null;
    } catch {}
  }

  const sectionIds: number[] = course.sections || [];
  const sections = sectionIds.length
    ? await apiGetMany("sections", sectionIds, token)
    : [];

  const unitIds: number[] = [];
  for (const s of sections) unitIds.push(...(s.units || []));
  const units = unitIds.length ? await apiGetMany("units", unitIds, token) : [];

  const lessonIds: number[] = units.map((u: any) => u.lesson);
  const lessons = lessonIds.length ? await apiGetMany("lessons", lessonIds, token) : [];

  let totalSteps = 0;
  let publicLessons = 0;
  let privateLessons = 0;
  for (const l of lessons) {
    const isPublic = !!l.is_public;
    if (isPublic) publicLessons++;
    else privateLessons++;
    // For private lessons without token, steps array is empty.
    totalSteps += (l.steps || []).length;
  }

  return {
    courseId,
    title: course.title || `Course #${courseId}`,
    summary: course.summary || "",
    cover: course.cover || null,
    targetAudience: course.target_audience || null,
    workload: course.workload || null,
    totalSections: sectionIds.length,
    totalUnits: unitIds.length,
    totalLessons: lessons.length,
    publicLessons,
    privateLessons,
    totalSteps,
    needsToken: privateLessons > 0,
    ownerName,
    language: course.language || null,
  };
}
