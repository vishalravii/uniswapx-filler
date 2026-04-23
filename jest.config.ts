import type { Config } from 'jest';

const config: Config = {
  preset:              'ts-jest',
  testEnvironment:     'node',
  rootDir:             'src',
  testMatch:           ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  clearMocks:          true,
  collectCoverageFrom: ['**/*.ts', '!**/index.ts'],
};

export default config;
