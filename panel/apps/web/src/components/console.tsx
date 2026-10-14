import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, apiPath, ApiError, type ServerMessage } from "@/lib/api";
import { addHistory, applyBatch, filterLines, initialConsole, isAtBottom, navigateHistory, pushLine, type ConsoleState, type LineKind } from "@/lib/console";
import { realtime } from "@/lib/ws";

type Action = { kind: "batch"; msgs: ServerMessage[] } | { kind: "line"; text: string; line: LineKind } | { kind: "clear" };
const reducer = (s: ConsoleState, a: Action): ConsoleState => {
  if (a.kind === "batch") return applyBatch(s, a.msgs, Date.now());
  if (a.kind === "line") return pushLine(s, { ts: Date.now(), text: a.text, kind: a.line });
  return { lines: [], nextId: s.nextId };
};

const color: Record<LineKind, string> = { log: "text-log", cmd: "text-info", out: "text-ok", sys: "text-warn" };

const Row = memo(function Row({ time, text, kind }: { time: string; text: string; kind: LineKind }) {
  return (
    <div className={`whitespace-pre-wrap break-all ${color[kind]}`}>
      <span className="mr-2 select-none text-fog/75">{time}</span>{text}
    </div>
  );
});

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
    let queue: ServerMessage[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      const msgs = queue; queue = [];
      if (msgs.length) dispatch({ kind: "batch", msgs });
    };
    const unsub = realtime.subscribe(`server:${serverId}:logs`, (msg) => {
      queue.push(msg);
      if (!raf) raf = requestAnimationFrame(flush);
    });
    return () => { unsub(); if (raf) cancelAnimationFrame(raf); };
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
    setHistory((h) => addHistory(h, c)); setHIdx(-1); setSending(true);
    dispatch({ kind: "line", text: `> ${c}`, line: "cmd" });
    stick.current = true; setFollowing(true);
    try {
      const { output } = await api.post<{ output: string }>(apiPath`/api/servers/${serverId}/command`, { command: c });
      setCmd("");
      for (const l of (output.trim() ? output.replace(/\n+$/, "") : "(no output)").split("\n")) dispatch({ kind: "line", text: l, line: "out" });
    } catch (e) {
      dispatch({ kind: "line", text: `✗ ${e instanceof ApiError ? e.message : "Unexpected error sending the command"}`, line: "sys" });
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
    <div className="flex h-[70vh] flex-col overflow-hidden rounded-lg border border-cobble bg-obsidian font-mono text-xs" data-testid="console">
      <div className="flex items-center gap-2 border-b border-cobble bg-bedrock/60 p-2">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter lines…" aria-label="Filter console lines" className="h-8 max-w-xs font-mono text-xs" />
        <span className="text-fog">{filter ? `${shown.length} of ${state.lines.length}` : `${state.lines.length} lines`}</span>
        {!following && <Button type="button" size="sm" variant="secondary" className="ml-auto" onClick={resume}><ArrowDown className="size-3.5" /> Jump to end</Button>}
      </div>
      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-auto px-3 py-2.5 leading-[1.65]" role="log" aria-live="off" aria-label="Server log" tabIndex={0}>
        {state.lines.length === 0 && <p className="text-fog">No output yet…</p>}
        {shown.map((l) => <Row key={l.id} time={l.time} text={l.text} kind={l.kind} />)}
      </div>
      <div className="flex items-center gap-2 border-t border-cobble py-1.5 pr-2 pl-3 focus-within:bg-bedrock/50 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring/70">
        <span className="select-none text-sm text-grass" aria-hidden="true">❯</span>
        <Input
          value={cmd} onChange={(e) => { setCmd(e.target.value); setHIdx(-1); }} onKeyDown={onKey}
          disabled={nodeOnline === false || sending} aria-label={sending ? "Command (sending…)" : "Command"}
          placeholder={nodeOnline === false ? "Node offline" : sending ? "Sending…" : "Command (without /): list, say hello, whitelist add Lobo…  (↑/↓ history)"}
          className="border-transparent bg-transparent px-1 font-mono text-xs focus-visible:border-transparent focus-visible:ring-0 md:text-xs dark:bg-transparent" autoComplete="off" spellCheck={false}
        />
      </div>
    </div>
  );
}
