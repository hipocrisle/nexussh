import { useEffect, useState } from "react";

// Mobile = "narrow viewport". Threshold matches Tailwind's `md:` so the same
// breakpoint that toggles inline `hidden md:inline` classes also toggles our
// component-level mobile shell (drawer-sidebar, top bar, smart key bar).
const MOBILE_MAX_PX = 767;

function compute(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`).matches;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(compute);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}
