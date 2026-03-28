module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/patterns', '<rootDir>/scripts'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
};
