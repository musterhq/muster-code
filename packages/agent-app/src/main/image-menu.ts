/** #788: the native right-click menu on a chat image (Copy image, Copy path, Reveal, Open with, Save as, Open in Canvas).
 *  Pure: Electron, the runtime and the file system come in through the host, so tests run without Electron.
 *  Every file action uses the absolute path the runtime located through the preview gates, never a renderer path. */
import type {MenuItemConstructorOptions} from 'electron';
import {basename, join} from 'node:path';
import type {Commands} from '../shared/protocol.ts';
import type {ImageRef, OpenWithApp} from '../shared/domains/files-protocol.ts';

export type {ImageRef};
export type ImageMenuCommand = {kind: 'copy-image'} | {kind: 'copy-path'} | {kind: 'reveal'} | {kind: 'open-with'; app: string} | {kind: 'save-as'} | {kind: 'canvas'};
export interface LocatedImage {path: string; name: string; exists: boolean}
interface ClipboardImage {isEmpty(): boolean}

export interface ImageMenuHost {
  locate(image: ImageRef): Promise<LocatedImage>;
  apps(path: string): Promise<OpenWithApp[]>;
  openWith(path: string, app: string): Promise<void>;
  /** Builds the template with `pick`, shows it at (x, y) in page pixels, and settles with the picked command or null. */
  popup(build: (pick: (command: ImageMenuCommand) => void) => MenuItemConstructorOptions[], x: number, y: number): Promise<ImageMenuCommand | null>;
  clipboard: {writeImage(image: ClipboardImage): void | Promise<void>; writeText(text: string): void | Promise<void>};
  imageFromPath(path: string): ClipboardImage;
  imageFromDataURL(url: string): ClipboardImage;
  reveal(path: string): void;
  /** Resolves with the chosen path, or null when cancelled. */
  saveDialog(defaultPath: string): Promise<string | null>;
  copyFile(from: string, to: string): Promise<void>;
  downloads: string;
  fileManager: string;
}

const MAX_DATA_URL = 64 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp|bmp);base64,/;
const optional = (value: unknown, max: number) => value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0'));

/** Throws unless the request names a chat image the runtime can check: a folder pair, a chat pair, or both. */
export function imageRef(value: unknown): ImageRef {
  const ref = value as ImageRef | null;
  if (!ref || typeof ref !== 'object' || !optional(ref.chatId, 256) || !optional(ref.path, 4096) || !optional(ref.folderId, 256) || !optional(ref.folderPath, 4096)) throw new Error('Invalid image request.');
  const folder = ref.folderId !== undefined && ref.folderPath !== undefined, chat = ref.chatId !== undefined && ref.path !== undefined;
  if (!folder && !chat) throw new Error('Invalid image request.');
  return {...(ref.chatId !== undefined ? {chatId: ref.chatId} : {}), ...(ref.path !== undefined ? {path: ref.path} : {}), ...(ref.folderId !== undefined ? {folderId: ref.folderId} : {}), ...(ref.folderPath !== undefined ? {folderPath: ref.folderPath} : {})};
}

export function imageMenuTemplate({image, apps, canvas, fileManager}: {image: LocatedImage; apps: readonly OpenWithApp[]; canvas: boolean; fileManager: string}, pick: (command: ImageMenuCommand) => void): MenuItemConstructorOptions[] {
  const onDisk = image.exists, why = onDisk ? undefined : `${image.name} is no longer on disk`;
  const fileItem = (item: MenuItemConstructorOptions, enabled = onDisk): MenuItemConstructorOptions => ({...item, enabled, ...(enabled || !why ? {} : {toolTip: why})});
  const choices = apps.filter(app => app.id !== 'finder');
  return [
    ...(why ? [{label: `${why}. Copy Image uses the picture shown in the chat.`, enabled: false}] : []),
    {label: 'Copy Image', click: () => pick({kind: 'copy-image'})},
    {label: 'Copy Path', click: () => pick({kind: 'copy-path'})},
    {type: 'separator'},
    fileItem({label: `Reveal in ${fileManager}`, click: () => pick({kind: 'reveal'})}),
    fileItem({label: 'Open With', submenu: choices.length ? choices.map(app => ({label: app.name, click: () => pick({kind: 'open-with', app: app.id})})) : [{label: 'No app found for this image', enabled: false}]}, onDisk && choices.length > 0),
    fileItem({label: 'Save As…', click: () => pick({kind: 'save-as'})}),
    {type: 'separator'},
    fileItem({label: 'Open in Canvas', click: () => pick({kind: 'canvas'})}, onDisk && canvas),
  ];
}

export function createImageMenu(host: ImageMenuHost) {
  /** Copies the file's picture; false when the file is gone or not an image the clipboard can hold. */
  const copyFromFile = async (image: LocatedImage): Promise<boolean> => {
    if (!image.exists) return false;
    const picture = host.imageFromPath(image.path);
    if (picture.isEmpty()) return false;
    await host.clipboard.writeImage(picture); return true;
  };
  async function run(command: ImageMenuCommand, image: LocatedImage): Promise<Commands['image.contextMenu']['output']> {
    switch (command.kind) {
      case 'copy-image': return await copyFromFile(image) ? null : 'copy-pixels';
      case 'copy-path': await host.clipboard.writeText(image.path); return null;
      case 'canvas': return 'canvas';
    }
    if (!image.exists) throw new Error(`${image.name} is no longer on disk.`);
    if (command.kind === 'reveal') host.reveal(image.path);
    else if (command.kind === 'open-with') await host.openWith(image.path, command.app);
    else {
      const target = await host.saveDialog(join(host.downloads, basename(image.path)));
      if (target) await host.copyFile(image.path, target);
    }
    return null;
  }
  return {
    async contextMenu(input: Commands['image.contextMenu']['input']): Promise<Commands['image.contextMenu']['output']> {
      if (!input || !Number.isFinite(input.x) || !Number.isFinite(input.y) || (input.canvas !== undefined && typeof input.canvas !== 'boolean')) throw new Error('Invalid image menu request.');
      const image = await host.locate(imageRef(input.image));
      const apps = image.exists ? await host.apps(image.path).catch(() => []) : [];
      const command = await host.popup(pick => imageMenuTemplate({image, apps, canvas: input.canvas === true, fileManager: host.fileManager}, pick), input.x, input.y);
      return command ? run(command, image) : null;
    },
    async copy(input: Commands['image.copy']['input']): Promise<Commands['image.copy']['output']> {
      if (!input) throw new Error('Invalid image copy request.');
      const ref = imageRef(input.image);
      if (input.dataUrl !== undefined) {
        if (typeof input.dataUrl !== 'string' || input.dataUrl.length > MAX_DATA_URL || !IMAGE_DATA_URL.test(input.dataUrl)) throw new Error('Only an image can be copied.');
        const picture = host.imageFromDataURL(input.dataUrl);
        if (picture.isEmpty()) throw new Error('This image could not be copied.');
        await host.clipboard.writeImage(picture); return {copied: true};
      }
      return {copied: await copyFromFile(await host.locate(ref))};
    },
  };
}
