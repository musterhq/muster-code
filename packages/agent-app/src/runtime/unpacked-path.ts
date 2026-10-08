/** Windows and Linux pack the app into resources/app.asar (electron-builder.yml `asar: true`). Electron reads inside it
 *  transparently, but nothing else can: a shell, Codex, a .cmd, the file manager or a worker thread needs the real file,
 *  which electron-builder puts at the same path under app.asar.unpacked for everything listed in `asarUnpack`.
 *  Paths outside an archive (macOS, development, tests) come back unchanged. */
export function unpackedPath(file:string):string {
  return file.replace(/([\\/])app\.asar(?=[\\/])/,'$1app.asar.unpacked');
}
