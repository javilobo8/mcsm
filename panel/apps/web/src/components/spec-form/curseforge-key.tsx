import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import { dialogSubmit } from "@/lib/dialog-form";

interface KeyStatus { configured: boolean; valid?: boolean }

/** Status of the global CurseForge API key and dialog to change it. The key is never read back. */
export function CurseForgeKeyNotice() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["settings", "curseforge"], queryFn: () => api.get<KeyStatus>("/api/settings/curseforge") });
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (apiKey: string) => api.put<KeyStatus>("/api/settings/curseforge", { apiKey }),
    onSuccess: (s) => {
      qc.setQueryData(["settings", "curseforge"], s);
      void qc.invalidateQueries({ queryKey: ["servers"] });
      setOpen(false); setKey("");
    },
  });
  const configured = status.data?.configured;
  const removeKey = () => {
    if (window.confirm("Removing the CurseForge API key will recreate the running CurseForge servers. Continue?")) save.mutate("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-xs">
      <KeyRound className="size-4 text-muted-foreground" />
      <span>
        CurseForge API key: {status.isError ? <strong role="alert" className="text-red-400">could not be checked</strong> : configured === undefined ? "…" : configured ? <strong className="text-emerald-400">configured</strong> : <strong className="text-amber-400">not configured</strong>}
        {configured === false && " (java17 or newer images include one; with java8 it is required)"}
      </span>
      {configured && status.data?.valid === false && (
        <span role="alert" className="text-amber-400">The saved key is not valid (it has spaces or disallowed characters): paste it again.</span>
      )}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setKey(""); save.reset(); } }}>
        <DialogTrigger asChild><Button type="button" size="sm" variant="secondary">{configured ? "Change" : "Configure"}</Button></DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>CurseForge API key</DialogTitle>
            <DialogDescription>It is global for all servers. Changing it recreates the ones that download from CurseForge.</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={dialogSubmit(() => save.mutate(key.trim()))}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-api-key">New API key</Label>
              <Input id="cf-api-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="$2a$10$…" />
              <p className="text-xs text-muted-foreground">Get it at console.curseforge.com. Paste it as is: “$” signs are not escaped.</p>
            </div>
            {save.error && <p role="alert" className="text-sm text-red-400">{save.error instanceof ApiError ? save.error.message : "Unexpected error"}</p>}
            <DialogFooter>
              {configured && <Button type="button" variant="ghost" disabled={save.isPending} onClick={removeKey}>Remove the key</Button>}
              <Button type="submit" disabled={save.isPending || key.trim() === ""}>{save.isPending ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
