import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BrandAmbient } from "@/components/layout/brand-ambient";
import { ThemeToggle } from "@/components/layout/theme-toggle";

// Shared metadata for auth pages (login / signup / forgot-password).
// None of these should be indexed — they'd compete with the marketing
// landing in SERPs and offer nothing to a searcher who hasn't already
// signed up. Each page still gets its own <title> via its own
// metadata.title override below the route group layout.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="crm-ambient relative isolate flex min-h-svh flex-col">
      <BrandAmbient />
      <div className="relative z-20 flex justify-end px-4 pt-4 sm:px-6">
        <ThemeToggle />
      </div>
      {children}
    </div>
  );
}
