import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Padding and rhythm of every page's root element. */
export const PAGE = "flex flex-col gap-6 p-4 sm:p-6 lg:p-8";

/** Title of a page (in the pixel face, like the website's headings), what it is about and its actions. */
export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      {/* At least 18rem: on a phone the actions wrap under the title instead of squeezing it. */}
      <div className="min-w-[min(100%,18rem)] flex-1">
        <h1 className="font-pixel text-[1.75rem] leading-[1.15] font-semibold tracking-tight break-words text-bone">{title}</h1>
        {description && <div className="mt-1.5 max-w-[48rem] text-sm leading-relaxed text-fog">{description}</div>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Heading of a block inside a page. */
export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("text-base font-semibold text-bone", className)}>{children}</h2>;
}
