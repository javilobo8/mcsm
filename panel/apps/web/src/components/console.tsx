import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError, type ServerMessage } from "@/lib/api";
import { addHistory, applyMessage, filterLines, initialConsole, isAtBottom, navigateHistory, pushLine, type ConsoleState, type LineKind } from "@/lib/console";
import { realtime } from "@/lib/ws";

type Action = { kind: "msg"; msg: ServerMessage } | { kind: "line"; text: string; line: LineKind } | { kind: "clear" };
const reducer = (s: ConsoleState, a: Action): ConsoleState => {
  if (a.kind === "msg") return applyMessage(s, a.msg, Date.now());
  if (a.kind === "line") return pushLine(s, { ts: Date.now(), text: a.text, kind: a.line });
  return { lines: [], nextId: s.nextId };
};

const color: Record<LineKind, string> = { log: "text-zinc-300", cmd: "text-sky-300", out: "text-emerald-300", sys: "text-amber-400" };

export function Console({ serverId, nodeOnline }: { serverId: string; nodeOnline?: boolean }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialConsole);
  const [cmd, setCmd] = useState("");
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const [sending, setSending] = useState(false);
  const [following, setFollowing] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    dispatch({ kind: "clear" });
    return realtime.subscribe(`server:${serverId}:logs`, (msg) => dispatch({ kind: "msg", msg }));
  }, [serverId]);

  const shown = useMemo(() => filterLines(state.lines, filter), [state.lines, filter]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stick.current = isAtBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
    setFollowing(stick.current);
  };
  const resume = () => {
    const el = scroller.current;
    stick.current = true; setFollowing(true);
    if (el) el.scrollTop = el.scrollHeight;
  };

  const send = async () => {
    const c = cmd.trim();
    if (!c || sending) return;
    setHistory((h) => addHistory(h, c)); setHIdx(-1); setCmd(""); setSending(true);
    dispatch({ kind: "line", text: `> ${c}`, line: "cmd" });
    stick.current = true; setFollowing(true);
    try {
      const { output } = await api.post<{ output: string }>(`/api/servers/${serverId}/command`, { command: c });
      for (const l of (output.trim() ? output.replace(/\n+$/, "") : "(sin salida)").split("\n")) dispatch({ kind: "line", text: l, line: "out" });
    } catch (e) {
      dispatch({ kind: "line", text: `✗ ${e instanceof ApiError ? e.message : "Error inesperado al enviar el comando"}`, line: "sys" });
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); void send(); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const n = navigateHistory(history, hIdx, e.key === "ArrowUp" ? "up" : "down");
      e.preventDefault();
      setHIdx(n.idx);
      if (n.value !== null) setCmd(n.value);
    }
  };

  return (
    <div className="flex h-[70vh] flex-col rounded-md border border-zinc-800 bg-black font-mono text-xs" data-testid="console">
      <div className="flex items-center gap-2 border-b border-zinc-800 p-2">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar líneas…" aria-label="Filtrar líneas de la consola" className="h-8 max-w-xs font-mono text-xs" />
        <span className="text-zinc-500">{filter ? `${shown.length} de ${state.lines.length}` : `${state.lines.length} líneas`}</span>
        {!following && <Button type="button" size="sm" variant="secondary" className="ml-auto" onClick={resume}><ArrowDown className="size-3.5" /> Ir al final</Button>}
      </div>
      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-auto p-3" role="log" aria-live="off" aria-label="Registro del servidor" tabIndex={0}>
        {state.lines.length === 0 && <p className="text-zinc-600">Sin salida todavía…</p>}
        {shown.map((l) => (
          <div key={l.id} className={`whitespace-pre-wrap break-all ${color[l.kind]}`}>
            <span className="mr-2 select-none text-zinc-600">{new Date(l.ts).toLocaleTimeString()}</span>{l.text}
          </div>
        ))}
      </div>
      <div className="border-t border-zinc-800 p-2">
        <Input
          value={cmd} onChange={(e) => { setCmd(e.target.value); setHIdx(-1); }} onKeyDown={onKey}
          disabled={nodeOnline === false} aria-label="Comando"
          placeholder={nodeOnline === false ? "Nodo desconectado" : "Comando (sin /): list, say hola, whitelist add Lobo…  (↑/↓ historial)"}
          className="font-mono" autoComplete="off" spellCheck={false}
        />
      </div>
    </div>
  );
}
