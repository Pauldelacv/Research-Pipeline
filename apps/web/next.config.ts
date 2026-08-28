import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Internal packages are consumed as TypeScript source (the "just-in-time
  // packages" pattern), so there is no build step to order across the repo.
  transpilePackages: ['@frp/schemas'],
  eslint: { ignoreDuringBuilds: true },

  // `next start` cannot serve a standalone build, so it is opt-in: the Docker
  // image sets NEXT_OUTPUT=standalone and runs `server.js` directly, while a
  // local or CI build stays servable with `next start`.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),

  webpack(config) {
    // The shared packages are ESM TypeScript and import siblings with an
    // explicit `.js` extension, as the spec requires. Node and tsx resolve
    // that to the `.ts` source; webpack needs to be told.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default config;
