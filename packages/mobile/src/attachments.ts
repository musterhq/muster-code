/** Photos and files the composer attaches (#326 phase 2). The screen gets a picker (the system photo library, camera and file
 *  picker on a device, a double in tests) and uploads what it returns through the session. */
export type AttachSource = 'photo' | 'camera' | 'file';
export interface PickedFile { name: string; mime: string; bytes: Uint8Array }
/** Resolves null when the person cancels. */
export type PickAttachment = (source: AttachSource) => Promise<PickedFile | null>;
