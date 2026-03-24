module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/patterns'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
};
