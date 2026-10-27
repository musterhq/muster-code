/* #710: no mutating syscall resolves a path through a previously checked parent name.
 * POSIX uses openat/mkdirat; Windows uses NtCreateFile with RootDirectory. Every
 * child is a single name, opened without following links/reparse points. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

static void fail(const char *reason) {
  fprintf(stderr, "Workspace write refused: %s.\n", reason);
  exit(1);
}

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>
typedef HANDLE Dir;
typedef wchar_t Char;
#define TEXT_(s) L##s
#define ENTRY wmain
#define equal(a,b) (wcscmp(a,b) == 0)

typedef NTSTATUS (NTAPI *CreateRelative)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
static CreateRelative createRelative;

static void close_dir(Dir dir) { CloseHandle(dir); }
static Dir child(Dir parent, const Char *name, int directory, int create) {
  size_t length = wcslen(name) * sizeof(wchar_t);
  if (length > 65534) fail("path part is too long");
  UNICODE_STRING unicode = {(USHORT)length, (USHORT)length, (PWSTR)name};
  OBJECT_ATTRIBUTES attrs;
  memset(&attrs, 0, sizeof(attrs));
  attrs.Length = sizeof(attrs); attrs.RootDirectory = parent;
  attrs.ObjectName = &unicode; attrs.Attributes = 0x40 /* OBJ_CASE_INSENSITIVE */;
  IO_STATUS_BLOCK status;
  HANDLE handle;
  NTSTATUS result = createRelative(&handle,
    SYNCHRONIZE | FILE_READ_ATTRIBUTES | (directory ? FILE_LIST_DIRECTORY | FILE_TRAVERSE : FILE_WRITE_DATA),
    &attrs, &status, NULL, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    create ? 3 /* FILE_OPEN_IF, never overwrite/truncate on open */ : 1 /* FILE_OPEN */,
    0x00200000 /* FILE_OPEN_REPARSE_POINT */ | 0x20 /* FILE_SYNCHRONOUS_IO_NONALERT */ |
      (directory ? 1 /* FILE_DIRECTORY_FILE */ : 0x40 /* FILE_NON_DIRECTORY_FILE */), NULL, 0);
  if (result < 0) fail("could not open a plain workspace path");
  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(handle, &info) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      (!!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != !!directory) ||
      (!directory && (GetFileType(handle) != FILE_TYPE_DISK || info.nNumberOfLinks > 1)))
    fail("links and non-regular files are not changed outside Full access");
  return handle;
}
static Dir root_dir(const Char *path) {
  createRelative = (CreateRelative)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile");
  if (!createRelative) fail("safe file operations are unavailable");
  wchar_t *copy = _wcsdup(path);
  if (!copy) fail("out of memory");
  // Start at the volume/share root; even ancestors of the workspace are walked without reparse processing.
  size_t prefix = 0;
  size_t length = wcslen(copy);
  if (length >= 3 && copy[1] == L':' && copy[2] == L'\\') prefix = 3;
  else if (length >= 3 && copy[0] == L'\\' && copy[1] == L'\\' && copy[2] != L'?' && copy[2] != L'.') {
    wchar_t *server = wcschr(copy + 2, L'\\');
    wchar_t *share = server ? wcschr(server + 1, L'\\') : NULL;
    prefix = share ? (size_t)(share - copy + 1) : wcslen(copy);
  }
  if (!prefix) fail("an absolute workspace folder is required");
  wchar_t saved = copy[prefix]; copy[prefix] = 0;
  Dir dir = CreateFileW(copy, FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  copy[prefix] = saved;
  if (dir == INVALID_HANDLE_VALUE) fail("could not open workspace volume");
  wchar_t *part = copy + prefix;
  while (*part) {
    wchar_t *end = wcschr(part, L'\\'); if (end) *end = 0;
    Dir next = child(dir, part, 1, 0); close_dir(dir); dir = next;
    if (!end) break;
    part = end + 1;
  }
  free(copy); return dir;
}
static void save(Dir file, const char *bytes, size_t size) {
  LARGE_INTEGER start; start.QuadPart = 0;
  if (!SetFilePointerEx(file, start, NULL, FILE_BEGIN) || !SetEndOfFile(file)) fail("could not truncate the file");
  while (size) {
    DWORD written, chunk = size > 0x40000000 ? 0x40000000 : (DWORD)size;
    if (!WriteFile(file, bytes, chunk, &written, NULL) || !written) fail("could not write the file");
    bytes += written; size -= written;
  }
}
#else
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
typedef int Dir;
typedef char Char;
#define TEXT_(s) s
#define ENTRY main
#define equal(a,b) (strcmp(a,b) == 0)
static void close_dir(Dir dir) { close(dir); }
static Dir child(Dir parent, const Char *name, int directory, int create) {
  int flags = O_NOFOLLOW | O_CLOEXEC | (directory ? O_RDONLY | O_DIRECTORY : O_WRONLY | O_NONBLOCK);
  int fd;
  if (directory) {
    fd = openat(parent, name, flags);
    if (fd < 0 && errno == ENOENT && create) {
      if (mkdirat(parent, name, 0755) < 0 && errno != EEXIST) fail(strerror(errno));
      fd = openat(parent, name, flags);
    }
  } else {
    fd = openat(parent, name, flags | O_CREAT | O_EXCL, 0644);
    if (fd < 0 && errno == EEXIST) fd = openat(parent, name, flags);
  }
  if (fd < 0) fail(strerror(errno));
  struct stat info;
  if (fstat(fd, &info) < 0) fail(strerror(errno));
  if (directory ? !S_ISDIR(info.st_mode) : !S_ISREG(info.st_mode) || info.st_nlink > 1)
    fail("links and non-regular files are not changed outside Full access");
  return fd;
}
static Dir root_dir(const Char *path) {
  if (path[0] != '/') fail("an absolute workspace folder is required");
  Dir dir = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (dir < 0) fail(strerror(errno));
  char *copy = strdup(path), *state = NULL;
  if (!copy) fail("out of memory");
  for (char *part = strtok_r(copy, "/", &state); part; part = strtok_r(NULL, "/", &state)) {
    Dir next = child(dir, part, 1, 0); close_dir(dir); dir = next;
  }
  free(copy); return dir;
}
static void save(Dir file, const char *bytes, size_t size) {
  if (ftruncate(file, 0) < 0) fail(strerror(errno));
  while (size) {
    size_t chunk = size > 0x40000000 ? 0x40000000 : size;
    ssize_t written = write(file, bytes, chunk);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) fail("could not write the file");
    bytes += written; size -= (size_t)written;
  }
}
#endif

static void plain_name(const Char *name) {
  if (!*name || equal(name, TEXT_(".")) || equal(name, TEXT_(".."))) fail("a plain file name is required");
  for (const Char *p = name; *p; p++) {
    if (*p == TEXT_('/')) fail("a single path part is required");
#ifdef _WIN32
    if (*p == L'\\' || *p == L':') fail("a single path part is required");
#endif
  }
}

int ENTRY(int argc, Char **argv) {
  if (argc < 3) fail("a workspace and file path are required");
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  for (int i = 2; i < argc; i++) plain_name(argv[i]);
  Dir parent = root_dir(argv[1]);
  for (int i = 2; i < argc - 1; i++) {
    Dir next = child(parent, argv[i], 1, 1); close_dir(parent); parent = next;
  }
  // The parent is now pinned. Receive the content before any file is opened/truncated.
  // This also lets the caller handle spawn errors without writing into a closed pipe.
  if (fputs("ready\n", stdout) < 0 || fflush(stdout)) fail("could not request content");
  char *bytes = NULL; size_t size = 0;
  for (;;) {
    char chunk[65536]; size_t got = fread(chunk, 1, sizeof(chunk), stdin);
    if (got) {
      if (size > (size_t)-1 - got) fail("file is too large");
      char *next = realloc(bytes, size + got);
      if (!next) fail("out of memory");
      bytes = next; memcpy(bytes + size, chunk, got); size += got;
    }
    if (got < sizeof(chunk)) { if (ferror(stdin)) fail("could not read content"); break; }
  }
  Dir file = child(parent, argv[argc - 1], 0, 1);
  save(file, bytes, size);
  close_dir(file); close_dir(parent); free(bytes);
  return 0;
}
