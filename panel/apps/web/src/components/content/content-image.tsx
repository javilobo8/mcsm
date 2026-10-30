import { useState } from "react";
import { Box } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = { sm: "size-8", md: "size-10", lg: "size-16", xl: "size-24" } as const;

/** Only the panel's image proxy is ever loaded: the CSP allows `img-src 'self'` and no third-party URL may reach the browser. */
export const isProxiedImage = (src: string | null | undefined): src is string => typeof src === "string" && src.startsWith("/api/content/image?");

/**
 * Project icon or gallery image (`alt=""` when the name is already next to it). Anything that is not a proxied path (null, a stray upstream URL) or fails to load
 * shows a neutral block of the same size, so rows never jump.
 */
export function ContentImage({ src, alt, size = "md", className }: { src: string | null | undefined; alt: string; size?: keyof typeof SIZES; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = cn("shrink-0 overflow-hidden rounded-md border border-cobble bg-bedrock-2", SIZES[size], className);
  if (!isProxiedImage(src) || failed) {
    return (
      <span className={cn(box, "flex items-center justify-center text-cobble-2")} {...(alt ? { role: "img", "aria-label": alt } : { "aria-hidden": true })}>
        <Box className="size-1/2" aria-hidden="true" />
      </span>
    );
  }
  return <img src={src} alt={alt} loading="lazy" decoding="async" className={cn(box, "object-cover")} onError={() => setFailed(true)} />;
}
