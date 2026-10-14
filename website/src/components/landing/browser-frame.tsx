import { cn } from "@/lib/utils";

export const screenshot = (name: string) => `${import.meta.env.BASE_URL}screenshots/${name}.webp`;

/**
 * A real panel screenshot in a browser window. The panel is reached by its LAN address, so that is what
 * the address bar shows.
 */
export function BrowserFrame({
  src,
  alt,
  width = 1440,
  height = 900,
  eager = false,
  className,
}: {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  eager?: boolean;
  className?: string;
}) {
  return (
    <figure className={cn("overflow-hidden rounded-xl border border-cobble-2 bg-bedrock shadow-[0_30px_80px_-20px_rgb(0_0_0/0.7)]", className)}>
      <div className="flex h-9 items-center gap-3 border-b border-cobble bg-[#1a1d22] px-3 sm:h-10 sm:px-4" aria-hidden="true">
        <span className="flex gap-1.5">
          <span className="size-2.5 bg-cobble-2" />
          <span className="size-2.5 bg-cobble-2" />
          <span className="size-2.5 bg-cobble-2" />
        </span>
        <span className="mx-auto flex h-6 w-full max-w-sm items-center justify-center rounded-md bg-deepslate px-3 font-mono text-[0.6875rem] text-fog sm:text-xs">
          192.168.1.10:8080
        </span>
        <span className="hidden w-[2.625rem] sm:block" />
      </div>
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        className="block h-auto w-full"
      />
    </figure>
  );
}
