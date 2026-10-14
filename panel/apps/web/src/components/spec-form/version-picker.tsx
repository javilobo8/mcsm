import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useVersions } from "@/hooks/use-versions";
import { ageText, startsUnstable, versionOptions } from "@/lib/versions";
import { cn } from "@/lib/utils";

/**
 * Minecraft version combobox (plan 10): list from the API according to the type, search, test versions
 * behind a switch and free text (“Use “x””) in case the version is missing or the source does not respond.
 */
export function VersionPicker({ id, type, value, onChange, "aria-describedby": describedby }: {
  id: string; type: string; value: string; onChange: (v: string) => void; "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showUnstable, setShowUnstable] = useState(() => startsUnstable(value));
  const versions = useVersions(type, true);
  const opts = versionOptions(type, versions.data?.versions ?? [], { query, showUnstable });
  const pick = (v: string) => { onChange(v); setOpen(false); setQuery(""); };
  const item = (v: string, label = v) => (
    <CommandItem key={v} value={v} onSelect={() => pick(v)}>
      <Check className={cn("size-4", value === v ? "opacity-100" : "opacity-0")} />{label}
    </CommandItem>
  );
  return (
    <div className="flex flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-describedby={describedby}
            className="w-full justify-between font-normal">
            <span className="truncate">{value || "Choose a version"}</span>
            <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search or type a version…" value={query} onValueChange={setQuery} />
            <CommandList>
              {versions.isPending && <p className="px-3 py-2 text-xs text-muted-foreground">Loading versions…</p>}
              {versions.isError && <p role="alert" className="px-3 py-2 text-xs text-bad">{versions.error.message}. You can type the version by hand.</p>}
              {opts.freeText && <CommandGroup heading="Typed by hand">{item(opts.freeText, `Use “${opts.freeText}”`)}</CommandGroup>}
              {opts.specials.length > 0 && <CommandGroup heading="Specials">{opts.specials.map((s) => item(s.id, s.label))}</CommandGroup>}
              {opts.stable.length > 0 && <CommandGroup heading="Stable">{opts.stable.map((v) => item(v))}</CommandGroup>}
              {opts.unstable.length > 0 && <CommandGroup heading="Snapshots and pre-releases">{opts.unstable.map((v) => item(v))}</CommandGroup>}
              {opts.hidden > 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{opts.hidden} more: type to filter.</p>}
              <CommandEmpty>No matches.</CommandEmpty>
            </CommandList>
          </Command>
          <label className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs">
            <input type="checkbox" checked={showUnstable} onChange={(e) => setShowUnstable(e.target.checked)} /> Show test versions
          </label>
        </PopoverContent>
      </Popover>
      {versions.data?.stale && (
        <p className="text-xs text-warn">The source is not responding; list from {ageText(versions.data.fetchedAt, Date.now())}.</p>
      )}
    </div>
  );
}
