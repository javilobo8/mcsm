import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Section({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("mx-auto max-w-[1240px] px-4 sm:px-6 lg:px-8", className)}>
      {children}
    </section>
  );
}

export function SectionHeading({ id, title, children, className }: { id: string; title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("max-w-[42rem]", className)}>
      <h2 id={`${id}-title`} className="font-pixel text-[2rem] leading-[1.1] font-semibold tracking-tight text-bone text-balance sm:text-[2.5rem]">
        {title}
      </h2>
      {children && <p className="mt-4 text-[1.0625rem] leading-relaxed text-fog sm:text-lg">{children}</p>}
    </div>
  );
}
