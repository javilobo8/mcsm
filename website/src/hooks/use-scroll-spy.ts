import { useEffect, useState } from "react";
import { activeHeading } from "@/lib/scroll-spy";

/** Id of the heading being read (see activeHeading); `line` is the distance from the top of the viewport. */
export function useScrollSpy(ids: string[], line = 120): string | undefined {
  const [active, setActive] = useState<string | undefined>();
  const key = ids.join(" ");

  useEffect(() => {
    if (ids.length === 0) {
      setActive(undefined);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const headings = ids.flatMap((id) => {
        const el = document.getElementById(id);
        return el ? [{ id, top: el.getBoundingClientRect().top }] : [];
      });
      const doc = document.documentElement;
      const atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 4 && window.scrollY > 0;
      setActive(activeHeading(headings, line, atBottom));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
    // `key` stands for `ids`.
  }, [key, line]);

  return active;
}
