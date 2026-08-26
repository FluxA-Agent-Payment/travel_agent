import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The agent turn holds an SSE connection open while tools run; don't let the
  // dev overlay's fetch instrumentation buffer it.
  experimental: {
    proxyTimeout: 300_000,
  },
};

export default nextConfig;
