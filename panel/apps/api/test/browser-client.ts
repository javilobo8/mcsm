import WebSocket from "ws";

/** Cliente WS del navegador para tests: cola de mensajes JSON y espera con timeout. */
export function browserClient(url: string, cookie: string): Promise<{ ws: WebSocket; next: (timeoutMs?: number) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws", { headers: { cookie } });
    const queue: any[] = [];
    const waiters: ((m: any) => void)[] = [];
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      const w = waiters.shift();
      if (w) w(m); else queue.push(m);
    });
    const next = (timeoutMs = 3000) => queue.length
      ? Promise.resolve(queue.shift())
      : new Promise<any>((res, rej) => {
        const t = setTimeout(() => rej(new Error("sin mensaje")), timeoutMs);
        waiters.push((m) => { clearTimeout(t); res(m); });
      });
    ws.on("open", () => resolve({ ws, next }));
    ws.on("unexpected-response", (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
}
