/** #335: with the platform pinned to Linux the composer footer, Settings and Work locally name "This PC", never "Mac". */
process.env.MUSTER_DEVICE_PLATFORM='linux';
await import('./device-noun-dom-body');
export {};
