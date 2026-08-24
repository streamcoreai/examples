import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This example sits inside a monorepo; without this Turbopack walks up and
  // picks the wrong package.json as the workspace root.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  transpilePackages: ["@streamcore/js-sdk"],
  async headers() {
    return [
      {
        // The prepared model is content-addressed by its build, not by name, so
        // it is safe to cache hard. Re-run prepare:model and the bytes change.
        source: "/models/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
