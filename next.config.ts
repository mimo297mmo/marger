import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // distDir قابل للتجاوز بيئيًا — يُستخدم محليًا لبناء اختباري بمجلد منفصل دون تعطيل خادم التطوير
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: false,
  // التحقق من الأنواع مفروض في البناء (معيار قبول: tsc نظيف وnext build ينجح)
  typescript: {
    ignoreBuildErrors: false,
  },
  allowedDevOrigins: ["*.space-z.ai"],
};

export default nextConfig;
