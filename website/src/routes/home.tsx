import { useEffect } from "react";
import { domAnimation, LazyMotion } from "motion/react";
import { Features } from "@/components/landing/features";
import { Footer } from "@/components/landing/footer";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Navbar } from "@/components/landing/navbar";
import { OpenSource } from "@/components/landing/open-source";
import { QuickStart } from "@/components/landing/quick-start";
import { Security } from "@/components/landing/security";
import { SkipLink } from "@/components/landing/skip-link";
import { Tour } from "@/components/landing/tour";
import { SITE_NAME } from "@/lib/site";

export function HomePage() {
  useEffect(() => {
    document.title = SITE_NAME;
  }, []);
  return (
    <LazyMotion features={domAnimation} strict>
      <div className="flex min-h-dvh flex-col">
        <SkipLink />
        <Navbar />
        <main id="main" className="flex-1">
          <Hero />
          <Features />
          <HowItWorks />
          <Tour />
          <QuickStart />
          <Security />
          <OpenSource />
        </main>
        <Footer />
      </div>
    </LazyMotion>
  );
}
