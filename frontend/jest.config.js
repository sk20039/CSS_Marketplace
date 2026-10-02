// jest.config.js — Next.js 14 + Jest via next/jest (uses SWC, no ts-jest needed).
const nextJest = require('next/jest');

const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const customConfig = {
  testEnvironment: 'jest-environment-node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // next/jest sets up module name mapper from tsconfig paths automatically.
};

module.exports = createJestConfig(customConfig);
