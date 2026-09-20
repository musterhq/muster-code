#import <AppKit/AppKit.h>
#import <QuickLookUI/QuickLookUI.h>
#include <node_api.h>
#include <cmath>
#include <string>
#include <stdint.h>
#include <string.h>

static QLPreviewView *g_preview = nil;
static NSView *g_host = nil;
static NSURL *g_url = nil;

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

static bool number(napi_env env, napi_value value, double *out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  return napi_get_value_double(env, value, out) == napi_ok;
}

static void removePreview() {
  if (g_preview) {
    [g_preview close];
    [g_preview removeFromSuperview];
    g_preview = nil;
  }
  g_host = nil;
  g_url = nil;
}

static napi_value show(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return fail(env, "Quick Look must be called on the main thread.");
  size_t argc = 6;
  napi_value argv[6];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 6)
    return fail(env, "show expects handle Buffer, file path, x, y, width, and height.");

  bool isBuffer = false;
  if (napi_is_buffer(env, argv[0], &isBuffer) != napi_ok || !isBuffer) return fail(env, "Native window handle must be a Buffer.");
  void *handle = nullptr;
  size_t handleLength = 0;
  if (napi_get_buffer_info(env, argv[0], &handle, &handleLength) != napi_ok || !handle || handleLength < sizeof(void *))
    return fail(env, "Native window handle Buffer is invalid.");
  void *rawHost = nullptr;
  memcpy(&rawHost, handle, sizeof(rawHost));
  NSView *host = (__bridge NSView *)rawHost;
  if (!host || ![host isKindOfClass:[NSView class]]) return fail(env, "Native window handle is not an NSView.");

  napi_valuetype pathType;
  if (napi_typeof(env, argv[1], &pathType) != napi_ok || pathType != napi_string) return fail(env, "Quick Look path must be a string.");
  size_t pathLength = 0;
  if (napi_get_value_string_utf8(env, argv[1], nullptr, 0, &pathLength) != napi_ok || pathLength == 0 || pathLength > 4096)
    return fail(env, "Quick Look path is invalid.");
  std::string path(pathLength + 1, '\0');
  if (napi_get_value_string_utf8(env, argv[1], path.data(), path.size(), &pathLength) != napi_ok)
    return fail(env, "Quick Look path is invalid.");
  const size_t nul = path.find('\0');
  if (nul != std::string::npos && nul < pathLength) return fail(env, "Quick Look path is invalid.");
  path.resize(pathLength);

  double x, y, width, height;
  if (!number(env, argv[2], &x) || !number(env, argv[3], &y) || !number(env, argv[4], &width) || !number(env, argv[5], &height) ||
      !std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height) || width <= 0 || height <= 0 ||
      width > 100000 || height > 100000 || fabs(x) > 1000000 || fabs(y) > 1000000)
    return fail(env, "Quick Look geometry is invalid.");

  @try {
    @autoreleasepool {
      NSString *pathString = [NSString stringWithUTF8String:path.c_str()];
      NSURL *url = [NSURL fileURLWithPath:pathString];
      if (!url || !url.isFileURL) return fail(env, "Quick Look requires a local file URL.");
      NSRect bounds = host.bounds;
      CGFloat viewY = [host isFlipped] ? y : NSMaxY(bounds) - y - height;
      NSRect frame = NSMakeRect(x, viewY, width, height);
      if (NSMaxX(frame) < NSMinX(bounds) || NSMinX(frame) > NSMaxX(bounds) || NSMaxY(frame) < NSMinY(bounds) || NSMinY(frame) > NSMaxY(bounds))
        return fail(env, "Quick Look geometry is outside the host view.");

      if (g_preview && g_host == host && g_url && [g_url isEqual:url]) {
        [g_preview setFrame:frame];
      } else if (g_preview && g_host == host) {
        [g_preview setFrame:frame];
        g_url = url;
        g_preview.previewItem = url;
      } else {
        removePreview();
        g_host = host;
        g_url = url;
        g_preview = [[QLPreviewView alloc] initWithFrame:frame style:QLPreviewViewStyleNormal];
        if (!g_preview) { g_host = nil; g_url = nil; return fail(env, "Unable to create Quick Look preview."); }
        g_preview.autoresizingMask = NSViewNotSizable;
        g_preview.wantsLayer = YES;
        g_preview.layer.masksToBounds = YES;
        g_preview.previewItem = url;
        [host addSubview:g_preview positioned:NSWindowAbove relativeTo:nil];
      }
    }
  } @catch (NSException *exception) {
    removePreview();
    return fail(env, "Quick Look preview operation failed.");
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value hide(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return fail(env, "Quick Look must be called on the main thread.");
  @try { @autoreleasepool { removePreview(); } }
  @catch (NSException *exception) { return fail(env, "Quick Look cleanup failed."); }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value refresh(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return fail(env, "Quick Look must be called on the main thread.");
  @try { @autoreleasepool { if (g_preview) [g_preview refreshPreviewItem]; } }
  @catch (NSException *exception) { return fail(env, "Quick Look refresh failed."); }
  napi_value result;
  napi_get_boolean(env, g_preview != nil, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"show", nullptr, show, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"hide", nullptr, hide, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"refresh", nullptr, refresh, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
