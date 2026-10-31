// /home/z/my-project/src/app/api/jobs/[id]/stream/route.ts
// Server-Sent Events для real-time прогресса задачи.
// Использование: EventSource(`/api/jobs/${jobId}/stream`)
import { NextRequest } from "next/server";
import { loadJob, readJobLog } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// SSE требует отключить buffering
export const fetchCache = "force-no-store";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: any) => {
        const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(msg));
      };

      // Стартовое сообщение
      send("hello", { jobId: id, ts: Date.now() });

      let lastProgress: string | undefined;
      let lastStatus: string | undefined;
      let lastLogLen = 0;

      // Poll внутреннего состояния и пушим изменения
      // Timeout через 30 минут (на случай если клиент не закрыл соединение)
      const deadline = Date.now() + 30 * 60 * 1000;
      const interval = setInterval(async () => {
        if (Date.now() > deadline) {
          send("timeout", { ts: Date.now() });
          clearInterval(interval);
          controller.close();
          return;
        }
        const job = await loadJob(id);
        if (!job) {
          send("error", { error: "Job not found" });
          clearInterval(interval);
          controller.close();
          return;
        }
        // Состояние изменилось?
        const progJson = JSON.stringify(job.progress);
        if (
          job.status !== lastStatus ||
          progJson !== lastProgress
        ) {
          send("progress", {
            status: job.status,
            progress: job.progress,
            courseTitle: job.courseTitle,
            stats: job.stats,
            archiveName: job.archiveName,
            errorMessage: job.errorMessage,
          });
          lastStatus = job.status;
          lastProgress = progJson;
        }
        // Если задача завершена — отправим финальное событие и закроем
        if (job.status === "completed" || job.status === "failed") {
          // Также отправим последние строки лога
          const log = await readJobLog(id, 50);
          if (log.length > lastLogLen) {
            send("log", { lines: log.slice(lastLogLen) });
            lastLogLen = log.length;
          }
          send("done", {
            status: job.status,
            archiveName: job.archiveName,
            errorMessage: job.errorMessage,
            stats: job.stats,
          });
          clearInterval(interval);
          controller.close();
          return;
        }
        // Периодически (раз в 5 секунд) отправляем лог-обновления
        // чтобы не засорять канал — только если есть новые строки
        if (Math.floor(Date.now() / 5000) % 6 === 0) {
          const log = await readJobLog(id, 50);
          if (log.length > lastLogLen) {
            send("log", { lines: log.slice(lastLogLen) });
            lastLogLen = log.length;
          }
        }
      }, 1000); // 1 сек интервал

      // Cleanup когда клиент отключится
      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
