// Preload for the test runs: existing assertions read "This Mac", so unless a run chooses otherwise the device noun is pinned to macOS.
process.env.MUSTER_DEVICE_PLATFORM ??= 'darwin';
