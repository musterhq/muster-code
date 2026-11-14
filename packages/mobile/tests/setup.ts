/** Native modules have no Node implementation: their own jest mocks stand in (animations run immediately). */
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
jest.mock('expo-haptics', () => ({impactAsync: jest.fn(), selectionAsync: jest.fn(), notificationAsync: jest.fn(), ImpactFeedbackStyle: {Light: 'light', Medium: 'medium'}, NotificationFeedbackType: {Success: 'success', Warning: 'warning', Error: 'error'}}));
require('react-native-gesture-handler/jestSetup');
// Reanimated's native initializer registers CSS handlers the JS fallback does not have.
jest.mock('react-native-reanimated/src/initializers', () => ({initializeReanimatedModule: () => undefined}));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
