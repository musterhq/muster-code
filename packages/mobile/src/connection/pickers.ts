/** The device pickers behind the composer's Attach menu: the photo library, the camera and the file picker. Photos come back
 *  as JPEG (the picker converts HEIC), read from the picker's cache copy. */
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {File} from 'expo-file-system';
import type {AttachSource, PickAttachment} from '../attachments';

async function read(uri: string): Promise<Uint8Array> { return new Uint8Array(await new File(uri).arrayBuffer()); }
const extension = (mime: string) => mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'jpg';

export const pickAttachment: PickAttachment = async (source: AttachSource) => {
  if (source === 'file') {
    const result = await DocumentPicker.getDocumentAsync({copyToCacheDirectory: true, multiple: false});
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return null;
    return {name: asset.name, mime: asset.mimeType || 'application/octet-stream', bytes: await read(asset.uri)};
  }
  if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error('Muster needs the camera to take a photo. Allow it in the phone’s settings.');
  const options: ImagePicker.ImagePickerOptions = {mediaTypes: ['images'], quality: 0.85, allowsMultipleSelection: false, exif: false};
  const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  const mime = asset.mimeType && /^image\/(jpeg|png|gif|webp)$/.test(asset.mimeType) ? asset.mimeType : 'image/jpeg';
  return {name: asset.fileName || `photo-${Date.now()}.${extension(mime)}`, mime, bytes: await read(asset.uri)};
};
