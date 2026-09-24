import { File, FileArchive, FileAudio, FileBraces, FileChartColumn, FileCode, FileCog, FileImage, FileSpreadsheet, FileTerminal, FileText, FileVideo, LockKeyhole, type LucideIcon } from 'lucide-react';

/** Spec C6: one icon and hue per file family; `null` hue means a neutral text token. */
const TABLE: Array<[string[], LucideIcon, number | null]> = [
  [['ts', 'tsx'], FileCode, 212], [['js', 'jsx', 'mjs', 'cjs'], FileCode, 50], [['py'], FileCode, 205],
  [['rs', 'go', 'java', 'kt', 'swift', 'c', 'cpp', 'cs', 'rb', 'php'], FileCode, 18], [['sh', 'zsh', 'bash'], FileTerminal, 152],
  [['json', 'jsonc'], FileBraces, 38], [['yml', 'yaml', 'toml', 'ini', 'env'], FileCog, 280], [['md', 'mdx', 'txt', 'rtf', 'log'], FileText, null],
  [['pdf'], FileText, 0], [['doc', 'docx'], FileText, 215], [['csv', 'tsv', 'xls', 'xlsx', 'numbers'], FileSpreadsheet, 145],
  [['ppt', 'pptx', 'key'], FileChartColumn, 18], [['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg'], FileImage, 16],
  [['mp4', 'mov', 'webm'], FileVideo, 330], [['mp3', 'wav', 'm4a'], FileAudio, 280], [['zip', 'gz', 'tar', '7z', 'rar'], FileArchive, 38],
  [['html', 'css'], FileCode, 12], [['lock'], LockKeyhole, null],
];
export function fileVisual(name: string, mime = ''): { Icon: LucideIcon; hue: number | null } {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const row = TABLE.find(([exts]) => exts.includes(ext));
  if (row) return { Icon: row[1], hue: row[2] };
  if (mime.startsWith('image/')) return { Icon: FileImage, hue: 16 };
  if (mime.startsWith('text/')) return { Icon: FileText, hue: null };
  return { Icon: File, hue: null };
}
