import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  skipTrailingSlashRedirect: true,
  transpilePackages: ['@ui-rater/contracts'],
  // The contracts workspace package lives one directory above the legacy
  // Next application. Turbopack otherwise treats it as outside the project
  // root and reports a false module-not-found during production builds.
  turbopack: {
    root: path.resolve(process.cwd(), ".."),
  },
};

export default nextConfig;
