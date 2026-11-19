/**
 * #887: providers refuse a request larger than 32 MB (Anthropic's Messages API, and the routers in front of it), and every
 * round of a turn re-sends the conversation with its pictures as base64. A turn that reads or is given many screenshots
 * crosses that size and then every request fails the same way.
 *
 * Before a request goes out, the routes Muster runs itself measure it and, while it is over REQUEST_SIZE_TARGET, replace
 * the oldest pictures with a one-line note. The pictures of the message being answered are kept until no older picture is
 * left; only then, if they alone are too large, the oldest of them go too (and the notice says so). A replaced picture
 * stays replaced, so later rounds re-send the same, smaller request.
 */

/** The provider's request size limit. */
export const PROVIDER_REQUEST_LIMIT = 32 * 1024 * 1024;
/** What a request is kept under: the limit, less room for the parts measured loosely (headers, multi-byte text). */
export const REQUEST_SIZE_TARGET = 28 * 1024 * 1024;
/** Adapter event: pictures were left out of a request to keep it under the limit (`older`, `latest` counts). */
export const IMAGES_OMITTED_EVENT = 'muster/imagesOmitted';

export const OLDER_IMAGE_NOTE = '[An earlier image was left out here to keep the request under the provider’s 32 MB size limit.]';
export const LATEST_IMAGE_NOTE = '[An image attached to this message was left out: together with the others it is larger than the provider’s 32 MB size limit.]';

type Block = Record<string, unknown>;
interface Slot {holder: unknown[]; index: number; bytes: number; latest: boolean}

/** The base64 payload of an Anthropic image block or an OpenAI `image_url` part, if this is one. */
function pictureBytes(block: unknown): number | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const b = block as Block;
  if (b.type === 'image' && b.source && typeof b.source === 'object' && typeof (b.source as Block).data === 'string') return ((b.source as Block).data as string).length;
  if (b.type === 'image_url' && b.image_url && typeof b.image_url === 'object' && typeof (b.image_url as Block).url === 'string') return ((b.image_url as Block).url as string).length;
  return undefined;
}

/** Every picture in these messages, oldest first, including pictures inside tool results. */
function slots(messages: readonly unknown[], latest: (message: unknown) => boolean): Slot[] {
  const found: Slot[] = [];
  const walk = (content: unknown, isLatest: boolean) => {
    if (!Array.isArray(content)) return;
    content.forEach((block, index) => {
      const bytes = pictureBytes(block);
      if (bytes !== undefined) found.push({holder: content, index, bytes, latest: isLatest});
      else if (block && typeof block === 'object') walk((block as Block).content, isLatest);
    });
  };
  for (const message of messages) if (message && typeof message === 'object') walk((message as Block).content, latest(message));
  return found;
}

/**
 * Brings a request of `size` bytes under `target` by replacing pictures with a text note, oldest first, in place.
 * Pictures in a message for which `latest` is true go only after every older one. Returns how many of each were left out.
 */
export function fitRequestImages(messages: readonly unknown[], size: number, latest: (message: unknown) => boolean, target = REQUEST_SIZE_TARGET): {older: number; latest: number} {
  const left = {older: 0, latest: 0};
  if (size <= target) return left;
  const found = slots(messages, latest);
  for (const slot of [...found.filter(entry => !entry.latest), ...found.filter(entry => entry.latest)]) {
    if (size <= target) break;
    const note = slot.latest ? LATEST_IMAGE_NOTE : OLDER_IMAGE_NOTE;
    slot.holder[slot.index] = {type: 'text', text: note};
    // The block's JSON shrinks by about its data; the note adds its own length.
    size -= slot.bytes - note.length * 3;
    if (slot.latest) left.latest++; else left.older++;
  }
  return left;
}

/** Tells the chat once per turn that pictures were left out (the service writes the notice). */
export function imagesOmittedReporter(emit: (method: string, params: Record<string, unknown>) => void) {
  let told = false;
  return (left: {older: number; latest: number}) => {
    if (told || (!left.older && !left.latest)) return;
    told = true;
    emit(IMAGES_OMITTED_EVENT, {...left});
  };
}

/** The notice for a turn whose request had pictures left out. */
export function imagesOmittedNotice(older: number, latest: number): string {
  const parts: string[] = [];
  if (older) parts.push(`${older === 1 ? 'An older image was' : `${older} older images were`} left out of this request to keep it under the provider’s 32 MB size limit. The newest images were kept; ask again for an older one if it is still needed.`);
  if (latest) parts.push(`${latest === 1 ? 'One image' : `${latest} images`} attached to this message ${latest === 1 ? 'was' : 'were'} left out too: together they are larger than 32 MB. Send fewer or smaller images.`);
  return parts.join(' ');
}
