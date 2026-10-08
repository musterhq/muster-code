/** #335: with the platform pinned to Windows the composer footer, Settings and Work locally name "This PC", never "Mac". */
process.env.MUSTER_DEVICE_PLATFORM='win32';
await import('./device-noun-dom-body');
export {};
