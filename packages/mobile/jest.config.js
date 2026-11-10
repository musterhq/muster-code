/** Unit and component tests run in Node only (no simulators). The phone link code is shared with the desktop app and lives in
 *  packages/agent-app/src/shared/mobile, so it is transformed too. */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/tests/**/*.test.ts?(x)'],
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|expo-router|@noble/.*|@testing-library/.*))'],
};
