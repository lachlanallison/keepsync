module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/shared/$1'
  },
  collectCoverageFrom: [
    'shared/**/*.js',
    'src/**/*.js',
    '!src/**/*.html',
    '!**/node_modules/**',
    '!dist/**'
  ]
};
