/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '3002',
        pathname: '/photos/**',
      },
      {
        protocol: 'https',
        hostname: 'listing-service-production-3b3f.up.railway.app',
        pathname: '/photos/**',
      },
    ],
  },
};

module.exports = nextConfig;
