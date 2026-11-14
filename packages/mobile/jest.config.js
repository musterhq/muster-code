/** Unit and component tests run in Node only (no simulators). The phone link code is shared with the desktop app and lives in
 *  packages/agent-app/src/shared/mobile, so it is transformed too. */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/tests/setup.ts'],
  testMatch: ['<rootDir>/tests/**/*.test.ts?(x)'],
  // The shared files sit outside this package; babel helpers they need resolve from this package's node_modules.
  modulePaths: ['<rootDir>/node_modules'],
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|expo-router|@noble/.*|@legendapp/.*|@testing-library/.*))'],
};
