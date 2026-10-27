// Muster Computer Use, macOS host (#721). One JSON request per stdin line, one JSON reply per stdout line:
//   {"id":1,"cmd":"state","args":{...}} -> {"id":1,"ok":true,"result":{...}} | {"id":1,"ok":false,"error":"..."}
// The accessibility tree comes first and input goes to the target app (accessibility actions, text inserted at the
// caret, events posted to the app's process), so the person's pointer, focus and clipboard stay theirs. Element numbers
// stay stable while the element exists; a number whose element is gone is refused, never guessed. Secure text fields
// are never read. Nothing runs while the screen is locked.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

struct Failure: Error { let message: String; init(_ message: String) { self.message = message } }

// MARK: - Output

let out = FileHandle.standardOutput
func reply(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  out.write(data); out.write("\n".data(using: .utf8)!)
}

// MARK: - Accessibility helpers

func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func str(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = attr(element, name) else { return nil }
  if let text = value as? String { return text }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}
func bool(_ element: AXUIElement, _ name: String) -> Bool? { (attr(element, name) as? NSNumber)?.boolValue }
func children(_ element: AXUIElement) -> [AXUIElement] { (attr(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func frame(_ element: AXUIElement) -> CGRect? {
  guard let position = attr(element, kAXPositionAttribute), let size = attr(element, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero, extent = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
  return CGRect(origin: point, size: extent)
}
func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  return AXUIElementCopyActionNames(element, &names) == .success ? (names as? [String]) ?? [] : []
}
func clip(_ text: String, _ limit: Int) -> String {
  let flat = text.replacingOccurrences(of: "\n", with: "\\n")
  return flat.count > limit ? String(flat.prefix(limit)) + "…" : flat
}

// MARK: - Apps

struct AppRef { let app: NSRunningApplication; var pid: pid_t { app.processIdentifier } }

func runningApps() -> [NSRunningApplication] {
  NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }
}
func describe(_ app: NSRunningApplication) -> [String: Any] {
  var row: [String: Any] = ["name": app.localizedName ?? "", "pid": Int(app.processIdentifier), "active": app.isActive, "hidden": app.isHidden]
  if let id = app.bundleIdentifier { row["bundleId"] = id }
  if let url = app.bundleURL { row["path"] = url.path }
  return row
}
/** By pid, bundle id, path or name (exact, then case-insensitive, then prefix). */
func findApp(_ query: String) -> NSRunningApplication? {
  let apps = runningApps(), lower = query.lowercased()
  if let pid = Int32(query), let hit = apps.first(where: { $0.processIdentifier == pid }) { return hit }
  let path = query.hasPrefix("/") ? URL(fileURLWithPath: query).resolvingSymlinksInPath().path : nil
  if let hit = apps.first(where: { $0.bundleIdentifier == query || $0.localizedName == query || (path != nil && $0.bundleURL?.resolvingSymlinksInPath().path == path) }) { return hit }
  if let hit = apps.first(where: { $0.bundleIdentifier?.lowercased() == lower || $0.localizedName?.lowercased() == lower }) { return hit }
  return apps.first(where: { ($0.localizedName?.lowercased() ?? "").hasPrefix(lower) })
}
func appURL(_ query: String) -> URL? {
  if query.hasPrefix("/") { return FileManager.default.fileExists(atPath: query) ? URL(fileURLWithPath: query) : nil }
  if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) { return url }
  let name = query.hasSuffix(".app") ? query : query + ".app"
  for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", NSHomeDirectory() + "/Applications"] {
    let path = (dir as NSString).appendingPathComponent(name)
    if FileManager.default.fileExists(atPath: path) { return URL(fileURLWithPath: path) }
  }
  return nil
}
/** Opens an app without bringing it forward (the person keeps working where they are). */
func openApp(_ query: String, hidden: Bool) throws -> NSRunningApplication {
  if let app = findApp(query) { return app }
  guard let url = appURL(query) else { throw Failure("No app named “\(query)” was found. Use list_apps, or pass a bundle id or an .app path.") }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = false
  configuration.hides = hidden
  configuration.addsToRecentItems = false
  let done = DispatchSemaphore(value: 0)
  var launched: NSRunningApplication?, failure: Error?
  NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in launched = app; failure = error; done.signal() }
  while done.wait(timeout: .now() + 0.05) == .timedOut { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
  if let failure { throw Failure("Could not open \(url.lastPathComponent): \(failure.localizedDescription)") }
  guard let app = launched else { throw Failure("Could not open \(url.lastPathComponent).") }
  let deadline = Date().addingTimeInterval(10)
  while Date() < deadline { if !windows(AXUIElementCreateApplication(app.processIdentifier)).isEmpty { break }; RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
  return app
}
func windows(_ root: AXUIElement) -> [AXUIElement] { (attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? [] }

// MARK: - Stable element numbers

final class Registry {
  var byElement: [AXUIElement: Int] = [:]
  var elements: [Int: (element: AXUIElement, role: String, label: String)] = [:]
  var next = 1
  var state = 0
  func number(_ element: AXUIElement, role: String, label: String) -> Int {
    if let known = byElement[element], let row = elements[known], row.role == role { elements[known] = (element, role, label); return known }
    let index = next; next += 1
    byElement[element] = index; elements[index] = (element, role, label)
    return index
  }
  func prune(keeping live: Set<Int>) {
    for (index, row) in elements where !live.contains(index) { elements[index] = nil; byElement[row.element] = nil }
  }
}
var registries: [pid_t: Registry] = [:]
func registry(_ pid: pid_t) -> Registry { if let known = registries[pid] { return known }; let made = Registry(); registries[pid] = made; return made }

func element(_ app: AppRef, _ index: Int) throws -> AXUIElement {
  guard let row = registry(app.pid).elements[index] else { throw Failure("Element \(index) is not in the current state of \(app.app.localizedName ?? "the app"). Read the app's state again and use a number from it.") }
  guard let role = str(row.element, kAXRoleAttribute), role == row.role else { throw Failure("Element \(index) (\(row.label)) is gone: the window changed. Read the app's state again.") }
  return row.element
}

// MARK: - State

let SKIP_ROLES: Set<String> = ["AXUnknown"]
let BUSY_ROLES: Set<String> = ["AXBusyIndicator", "AXProgressIndicator"]

struct Walk { var lines: [String] = []; var count = 0; var busy = false; var signature = Hasher(); var live = Set<Int>() }

func label(_ element: AXUIElement, role: String) -> String {
  for name in [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel", kAXHelpAttribute, kAXPlaceholderValueAttribute] {
    if let text = str(element, name), !text.isEmpty { return clip(text, 80) }
  }
  return ""
}

func walk(_ element: AXUIElement, depth: Int, into state: inout Walk, registry: Registry?, limit: Int) {
  if state.count >= limit || depth > 40 { return }
  let role = str(element, kAXRoleAttribute) ?? "AXUnknown"
  if BUSY_ROLES.contains(role) { state.busy = true }
  let kids = children(element)
  let title = label(element, role: role)
  let secure = role == "AXSecureTextField" || str(element, kAXSubroleAttribute) == "AXSecureTextField"
  var value = ""
  if !secure, let raw = attr(element, kAXValueAttribute) {
    if let text = raw as? String { value = clip(text, 400) } else if let number = raw as? NSNumber { value = number.stringValue }
  }
  state.signature.combine(role); state.signature.combine(title); state.signature.combine(value)
  let interesting = !title.isEmpty || !value.isEmpty || secure || !actions(element).isEmpty || role.hasSuffix("TextField") || role == "AXTextArea"
  let structural = ["AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXUnknown"].contains(role) && title.isEmpty && value.isEmpty
  var nextDepth = depth
  if let registry, interesting && !structural && !SKIP_ROLES.contains(role) {
    state.count += 1
    let index = registry.number(element, role: role, label: title.isEmpty ? role : title)
    state.live.insert(index)
    var line = String(repeating: "  ", count: depth) + "[\(index)] \(role.replacingOccurrences(of: "AX", with: ""))"
    if !title.isEmpty { line += " \"\(title)\"" }
    if secure { line += " (secure, value hidden)" } else if !value.isEmpty { line += " value=\"\(value)\"" }
    if bool(element, kAXEnabledAttribute) == false { line += " disabled" }
    if bool(element, kAXFocusedAttribute) == true { line += " focused" }
    if bool(element, kAXSelectedAttribute) == true { line += " selected" }
    let extra = actions(element).filter { $0 != kAXPressAction as String && $0 != "AXScrollToVisible" && $0 != "AXShowDefaultUI" && $0 != "AXShowAlternateUI" }
    if !extra.isEmpty { line += " actions=" + extra.map { $0.replacingOccurrences(of: "AX", with: "") }.joined(separator: ",") }
    state.lines.append(line)
    nextDepth = depth + 1
  } else if registry == nil { state.count += 1 }
  for child in kids { walk(child, depth: nextDepth, into: &state, registry: registry, limit: limit) }
}

func snapshot(_ app: AppRef, limit: Int, registry: Registry?) -> (Walk, [[String: Any]]) {
  let root = AXUIElementCreateApplication(app.pid)
  AXUIElementSetMessagingTimeout(root, 2.0)
  var state = Walk(), list: [[String: Any]] = []
  let focusedWindow = attr(root, kAXFocusedWindowAttribute) as! AXUIElement?
  var ordered = windows(root)
  if let focusedWindow, let at = ordered.firstIndex(of: focusedWindow) { ordered.insert(ordered.remove(at: at), at: 0) }
  for window in ordered {
    var row: [String: Any] = ["title": str(window, kAXTitleAttribute) ?? ""]
    if let rect = frame(window) { row["frame"] = [rect.origin.x, rect.origin.y, rect.size.width, rect.size.height] }
    if let subrole = str(window, kAXSubroleAttribute) { row["subrole"] = subrole }
    if bool(window, kAXModalAttribute) == true { row["modal"] = true }
    list.append(row)
    walk(window, depth: 0, into: &state, registry: registry, limit: limit)
  }
  if let menu = attr(root, kAXMenuBarAttribute), registry != nil, CFGetTypeID(menu) == AXUIElementGetTypeID() {
    // Menu bar items only (not their menus): opening a menu is an action, and its items then appear in the next state.
    for item in children(menu as! AXUIElement) where state.count < limit {
      let title = str(item, kAXTitleAttribute) ?? ""
      if title.isEmpty || title == "Apple" { continue }
      state.count += 1
      let index = registry!.number(item, role: "AXMenuBarItem", label: title)
      state.live.insert(index)
      state.lines.append("[\(index)] MenuBarItem \"\(clip(title, 60))\"")
    }
  }
  return (state, list)
}

/** Waits until two consecutive reads of the tree match (or the limit passes): `min` ms normally, up to `max` while a
 *  busy or progress indicator is showing. The model never needs to sleep. */
func settle(_ app: AppRef, minMs: Int, maxMs: Int) {
  let start = Date()
  var last: Int?, stable = 0
  while true {
    let (state, _) = snapshot(app, limit: 1500, registry: nil)
    var hasher = state.signature
    hasher.combine(state.count)
    let signature = hasher.finalize()
    stable = signature == last ? stable + 1 : 0
    last = signature
    let elapsed = Int(Date().timeIntervalSince(start) * 1000)
    if stable >= 2 && elapsed >= minMs && !state.busy { return }
    if elapsed >= (state.busy ? maxMs : max(minMs, 1000)) { return }
    RunLoop.current.run(until: Date().addingTimeInterval(0.08))
  }
}

// MARK: - Input to the target app only

func keyCode(_ name: String) -> CGKeyCode? {
  let table: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  ]
  return table[name.lowercased()]
}
func pressKeys(_ app: AppRef, _ combo: String) throws {
  var flags: CGEventFlags = []
  var key: CGKeyCode?
  for part in combo.split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }) {
    switch part {
    case "cmd", "command", "super", "meta": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default:
      guard let code = keyCode(part) else { throw Failure("Unknown key “\(part)” in “\(combo)”. Use names like cmd+s, shift+tab, return, escape, left, f5.") }
      key = code
    }
  }
  guard let key else { throw Failure("No key in “\(combo)”.") }
  let source = CGEventSource(stateID: .privateState)
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { throw Failure("Could not make a key event.") }
    event.flags = flags
    event.postToPid(app.pid)
    usleep(8000)
  }
}
/** Text goes in at the caret through accessibility (no keys, no clipboard), which works with the app in the background;
 *  if the element refuses, unicode key events go to the app's process. */
func typeText(_ app: AppRef, _ text: String, into target: AXUIElement?) throws -> String {
  let root = AXUIElementCreateApplication(app.pid)
  let field = target ?? (attr(root, kAXFocusedUIElementAttribute) as! AXUIElement?)
  if let field {
    if target != nil { AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
    var settable: DarwinBoolean = false
    if AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue,
       AXUIElementSetAttributeValue(field, kAXSelectedTextAttribute as CFString, text as CFString) == .success { return "inserted" }
  }
  let source = CGEventSource(stateID: .privateState)
  for chunk in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
    if chunk.offset > 0 { try pressKeys(app, "return") }
    var units = Array(String(chunk.element).utf16)
    while !units.isEmpty {
      let part = Array(units.prefix(16)); units.removeFirst(part.count)
      for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
        event.keyboardSetUnicodeString(stringLength: part.count, unicodeString: part)
        event.postToPid(app.pid)
      }
      usleep(6000)
    }
  }
  return "typed"
}
func center(_ element: AXUIElement) throws -> CGPoint {
  guard let rect = frame(element), rect.width > 0, rect.height > 0 else { throw Failure("That element has no position on screen; try perform_action, or scroll it into view first.") }
  return CGPoint(x: rect.midX, y: rect.midY)
}
func click(_ app: AppRef, at point: CGPoint, button: String, count: Int) {
  let source = CGEventSource(stateID: .privateState)
  let (downType, upType, mouse): (CGEventType, CGEventType, CGMouseButton) = button == "right" ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
  for n in 1...max(1, min(count, 3)) {
    for type in [downType, upType] {
      guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: mouse) else { continue }
      event.setIntegerValueField(.mouseEventClickState, value: Int64(n))
      event.postToPid(app.pid)
      usleep(10000)
    }
  }
}
func scroll(_ app: AppRef, at point: CGPoint?, dx: Int32, dy: Int32) {
  guard let event = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .privateState), units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return }
  if let point { event.location = point }
  event.postToPid(app.pid)
}

// MARK: - Window capture (works when the window is covered)

func capture(_ app: AppRef, maxWidth: Int) throws -> [String: Any] {
  guard CGPreflightScreenCaptureAccess() else { throw Failure("Screen Recording is off for Muster. Turn it on in System Settings → Privacy & Security → Screen Recording, or work from the accessibility tree.") }
  let done = DispatchSemaphore(value: 0)
  var result: Result<[String: Any], Error> = .failure(Failure("No window to capture."))
  let pid = app.pid
  Task.detached {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
      let mine = content.windows.filter { $0.owningApplication?.processID == pid && (0..<100).contains($0.windowLayer) && $0.frame.width > 40 && $0.frame.height > 40 }
      let ranked = mine.sorted { ($0.isOnScreen ? 1 : 0, ($0.title ?? "").isEmpty ? 0 : 1, $0.frame.width * $0.frame.height) > ($1.isOnScreen ? 1 : 0, ($1.title ?? "").isEmpty ? 0 : 1, $1.frame.width * $1.frame.height) }
      guard let window = ranked.first else { throw Failure("The app has no window to capture (it may be hidden or minimized).") }
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let configuration = SCStreamConfiguration()
      let scale = min(1.0, Double(maxWidth) / Double(window.frame.width))
      configuration.width = Int(window.frame.width * scale); configuration.height = Int(window.frame.height * scale)
      configuration.showsCursor = false
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
      let rep = NSBitmapImageRep(cgImage: image)
      guard let png = rep.representation(using: .png, properties: [:]) else { throw Failure("Could not encode the capture.") }
      result = .success(["png": png.base64EncodedString(), "width": image.width, "height": image.height, "frame": [window.frame.origin.x, window.frame.origin.y, window.frame.width, window.frame.height]])
    } catch { result = .failure(error) }
    done.signal()
  }
  while done.wait(timeout: .now() + 0.05) == .timedOut { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
  switch result { case .success(let row): return row; case .failure(let error): throw (error as? Failure) ?? Failure(error.localizedDescription) }
}

// MARK: - Agent cursor (the person sees where Muster works)

// The same cursor as the in-app browser's: an orange arrow with a "Muster" pill that glides to the target on a gentle
// arc before each action, presses with a ripple, rings a field while typing and fades once the agent goes quiet. A soft
// orange outline marks the window Muster is using. The panels never take input, never activate, sit just above the
// target window (so a covered window keeps its cursor covered too), and are excluded from every screen capture, so the
// model never sees them (MUSTER_COMPUTER_CURSOR_RECORDING=1 lets a demo recording include them). Reduce motion turns glides into jumps. MUSTER_COMPUTER_CURSOR=0 turns the overlay off.

let ACCENT = CGColor(red: 210 / 255, green: 148 / 255, blue: 62 / 255, alpha: 1)
let CURSOR_IDLE = 1.6, CURSOR_FADE = 0.52, MIN_GLIDE = 0.14, MAX_GLIDE = 0.52
/** The arrow's tip inside the cursor panel, from the panel's top-left corner. Layers use AppKit's y-up space, so
 *  `TIP_LAYER` is the same point measured from the bottom. */
let TIP = CGPoint(x: 26, y: 26), CURSOR_PANEL = NSSize(width: 150, height: 80)
let TIP_LAYER = CGPoint(x: TIP.x, y: CURSOR_PANEL.height - TIP.y)
let overlayEnabled = ProcessInfo.processInfo.environment["MUSTER_COMPUTER_CURSOR"] != "0"
func reduceMotion() -> Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
/** Accessibility points (top-left origin) to AppKit points (bottom-left origin of the main screen). */
func flipY(_ y: CGFloat) -> CGFloat { (NSScreen.screens.first?.frame.height ?? 0) - y }
func cocoaRect(_ rect: CGRect) -> NSRect { NSRect(x: rect.minX, y: flipY(rect.maxY), width: rect.width, height: rect.height) }

/** cubic-bezier(x1,y1,x2,y2) easing, solved for x by Newton steps. */
func bezier(_ t: Double, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> Double {
  func curve(_ s: Double, _ a: Double, _ b: Double) -> Double { 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s }
  var s = t
  for _ in 0..<8 {
    let dx = curve(s, x1, x2) - t
    let slope = 3 * x1 * (1 - s) * (1 - s) + 6 * (x2 - x1) * s * (1 - s) + 3 * (1 - x2) * s * s
    if abs(dx) < 1e-5 || abs(slope) < 1e-6 { break }
    s = min(1, max(0, s - dx / slope))
  }
  return curve(s, y1, y2)
}

func overlayPanel(_ size: NSSize) -> NSPanel {
  let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
  panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
  panel.ignoresMouseEvents = true; panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false
  panel.sharingType = ProcessInfo.processInfo.environment["MUSTER_COMPUTER_CURSOR_RECORDING"] == "1" ? .readOnly : .none
  panel.animationBehavior = .none
  panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle, .transient]
  panel.alphaValue = 0
  let root = CALayer()
  panel.contentView!.layer = root; panel.contentView!.wantsLayer = true
  return panel
}

final class AgentCursor {
  let panel = overlayPanel(CURSOR_PANEL)
  let outline = overlayPanel(NSSize(width: 10, height: 10))
  let field = overlayPanel(NSSize(width: 10, height: 10))
  let arrow = CAShapeLayer(), ring = CALayer(), fieldRing = CALayer()
  var point: CGPoint?            // tip position, accessibility points
  var visible = false, lastGlide = 0.0
  var idle: Timer?, glideTimer: Timer?
  var above: CGWindowID = 0
  var scale: CGFloat { NSScreen.main?.backingScaleFactor ?? 2 }

  init() {
    let root = panel.contentView!.layer!
    // The arrow is drawn top-down (tip at the top left) and flipped into the layer's y-up space, so it points up-left.
    let path = CGMutablePath(), down = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 22)
    path.move(to: CGPoint(x: 1.5, y: 1.5), transform: down)
    for corner in [CGPoint(x: 1.5, y: 17.1), CGPoint(x: 5.8, y: 13), CGPoint(x: 8.7, y: 19.4), CGPoint(x: 11.5, y: 18.2), CGPoint(x: 8.7, y: 11.9), CGPoint(x: 14.7, y: 11.9)] { path.addLine(to: corner, transform: down) }
    path.closeSubpath()
    arrow.path = path; arrow.fillColor = ACCENT; arrow.strokeColor = .white; arrow.lineWidth = 1.4; arrow.lineJoin = .round
    arrow.bounds = CGRect(x: 0, y: 0, width: 20, height: 22); arrow.anchorPoint = CGPoint(x: 1.5 / 20, y: 20.5 / 22)
    arrow.position = TIP_LAYER
    arrow.shadowColor = .black; arrow.shadowOpacity = 0.32; arrow.shadowRadius = 2; arrow.shadowOffset = CGSize(width: 0, height: -1.5)
    arrow.contentsScale = scale
    let text = CATextLayer()
    text.string = NSAttributedString(string: "Muster", attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor(red: 29 / 255, green: 20 / 255, blue: 6 / 255, alpha: 1), .kern: 0.1])
    text.contentsScale = scale; text.alignmentMode = .center
    let width = ceil(("Muster" as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold)]).width) + 16
    let pill = CALayer()
    pill.frame = CGRect(x: TIP_LAYER.x + 13.5, y: TIP_LAYER.y - 17.5 - 19, width: width, height: 19); pill.cornerRadius = 9.5; pill.backgroundColor = ACCENT
    pill.borderColor = CGColor(gray: 1, alpha: 0.28); pill.borderWidth = 1
    pill.shadowColor = .black; pill.shadowOpacity = 0.22; pill.shadowRadius = 5; pill.shadowOffset = CGSize(width: 0, height: -2)
    text.frame = CGRect(x: 0, y: 2, width: width, height: 15)
    pill.addSublayer(text)
    root.addSublayer(pill); root.addSublayer(arrow)
    for (layer, host, radius, width) in [(ring, outline, 12.0, 2.0), (fieldRing, field, 6.0, 2.0)] {
      layer.borderColor = ACCENT.copy(alpha: 0.9); layer.borderWidth = width; layer.cornerRadius = radius
      layer.shadowColor = ACCENT; layer.shadowOpacity = 0.55; layer.shadowRadius = 7; layer.shadowOffset = .zero
      host.contentView!.layer!.addSublayer(layer)
    }
  }

  /** Places a panel just above the target window so it moves in step with that window's stacking. */
  func order(_ host: NSPanel) {
    if above != 0 { host.level = .normal; host.order(.above, relativeTo: Int(above)) } else { host.level = .floating; host.orderFrontRegardless() }
  }
  func placeTip(_ tip: CGPoint) {
    point = tip
    panel.setFrameOrigin(NSPoint(x: tip.x - TIP.x, y: flipY(tip.y) - (panel.frame.height - TIP.y)))
  }
  func fade(_ host: NSPanel, to value: CGFloat, _ seconds: Double, done: (() -> Void)? = nil) {
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = seconds
      context.timingFunction = value > 0 ? CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1) : CAMediaTimingFunction(controlPoints: 0.4, 0, 0.6, 1)
      host.animator().alphaValue = value
    }, completionHandler: done)
  }
  func pump(_ seconds: Double) { let end = Date().addingTimeInterval(seconds); while Date() < end { RunLoop.current.run(mode: .default, before: min(end, Date().addingTimeInterval(1 / 120))) } }

  /** Marks the window Muster is using; nil hides the outline. */
  func mark(window rect: CGRect?, id: CGWindowID) {
    above = id
    guard let rect else { fade(outline, to: 0, 0.2); return }
    outline.setFrame(cocoaRect(rect.insetBy(dx: -3, dy: -3)), display: false)
    ring.frame = CGRect(origin: .zero, size: outline.frame.size).insetBy(dx: 1, dy: 1)
    order(outline)
    if outline.alphaValue < 1 { fade(outline, to: 1, 0.18) }
  }

  /** Glides the tip to `target` and waits for it to land, so the action happens under the cursor. */
  func move(to target: CGPoint) {
    idle?.invalidate(); glideTimer?.invalidate()
    let instant = reduceMotion()
    order(panel)
    if !visible || panel.alphaValue < 0.99 {
      placeTip(point == nil || instant ? target : point!)
      visible = true
      fade(panel, to: 1, instant ? 0.12 : 0.14)
      pump(instant ? 0.12 : 0.14)
    }
    let from = point ?? target, dx = target.x - from.x, dy = target.y - from.y, distance = hypot(dx, dy)
    lastGlide = 0
    if instant || distance < 2 { placeTip(target); return }
    let seconds = min(MAX_GLIDE, max(MIN_GLIDE, 0.11 + Double(distance) * 0.00042))
    let bend = min(40, distance * 0.08), mid = CGPoint(x: from.x + dx / 2 - dy / distance * bend, y: from.y + dy / 2 + dx / distance * bend)
    let start = Date()
    var landed = false
    let timer = Timer(timeInterval: 1 / 120, repeats: true) { [weak self] timer in
      guard let self else { timer.invalidate(); return }
      let t: Double = min(1, Date().timeIntervalSince(start) / seconds)
      let e = CGFloat(bezier(t, 0.3, 0.7, 0.2, 1)), u: CGFloat = 1 - e
      let a: CGFloat = u * u, b: CGFloat = 2 * u * e, c: CGFloat = e * e
      let x: CGFloat = a * from.x + b * mid.x + c * target.x
      let y: CGFloat = a * from.y + b * mid.y + c * target.y
      self.placeTip(CGPoint(x: x, y: y))
      if t >= 1 { timer.invalidate(); landed = true }
    }
    RunLoop.current.add(timer, forMode: .common); glideTimer = timer
    let deadline = Date().addingTimeInterval(seconds + 0.25)
    while !landed && Date() < deadline { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(1 / 120)) }
    placeTip(target); lastGlide = seconds
  }

  func press(double: Bool) {
    guard !reduceMotion() else { return }
    for n in 0..<(double ? 2 : 1) {
      let squeeze = CAKeyframeAnimation(keyPath: "transform.scale")
      squeeze.values = [1, 0.84, 1]; squeeze.keyTimes = [0, 0.33, 1]; squeeze.duration = 0.21; squeeze.beginTime = CACurrentMediaTime() + Double(n) * 0.17
      arrow.add(squeeze, forKey: "press\(n)")
      let ripple = CALayer()
      ripple.bounds = CGRect(x: 0, y: 0, width: 14, height: 14); ripple.position = TIP_LAYER; ripple.cornerRadius = 7
      ripple.borderColor = ACCENT; ripple.borderWidth = 2; ripple.opacity = 0
      panel.contentView!.layer!.insertSublayer(ripple, below: arrow)
      let grow = CABasicAnimation(keyPath: "transform.scale"); grow.fromValue = 0.4; grow.toValue = 2.6
      let fadeOut = CAKeyframeAnimation(keyPath: "opacity"); fadeOut.values = [0.9, 0.6, 0]; fadeOut.keyTimes = [0, 0.4, 1]
      let group = CAAnimationGroup(); group.animations = [grow, fadeOut]; group.duration = 0.42; group.beginTime = CACurrentMediaTime() + Double(n) * 0.17
      group.timingFunction = CAMediaTimingFunction(name: .easeOut)
      ripple.add(group, forKey: "ripple")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { ripple.removeFromSuperlayer() }
    }
  }

  /** Rings the field text goes into until the agent goes quiet. */
  func ringField(_ rect: CGRect?) {
    guard let rect else { return }
    field.setFrame(cocoaRect(rect.insetBy(dx: -4, dy: -4)), display: false)
    fieldRing.frame = CGRect(origin: .zero, size: field.frame.size).insetBy(dx: 1.5, dy: 1.5)
    order(field)
    fade(field, to: 1, 0.16)
  }

  /** After a quiet moment the cursor, outline and field ring fade together; the cursor returns from where it faded. */
  func rest() {
    idle?.invalidate()
    let timer = Timer(timeInterval: CURSOR_IDLE, repeats: false) { [weak self] _ in self?.fadeAll() }
    RunLoop.current.add(timer, forMode: .common); idle = timer
  }
  func fadeAll() {
    let seconds = reduceMotion() ? 0.16 : CURSOR_FADE
    visible = false
    for host in [panel, outline, field] { fade(host, to: 0, seconds) { if host.alphaValue < 0.01 { host.orderOut(nil) } } }
  }

  func debug() -> [String: Any] {
    ["visible": visible && panel.isVisible, "alpha": Double(panel.alphaValue), "x": Double(point?.x ?? -1), "y": Double(point?.y ?? -1), "glideMs": Int(lastGlide * 1000),
     "outline": ["alpha": Double(outline.alphaValue), "visible": outline.isVisible, "frame": [outline.frame.minX, flipY(outline.frame.maxY), outline.frame.width, outline.frame.height]],
     "field": ["alpha": Double(field.alphaValue), "visible": field.isVisible], "shareable": panel.sharingType != .none, "reduceMotion": reduceMotion()]
  }
}
let agentCursor: AgentCursor? = overlayEnabled ? AgentCursor() : nil

/** The window an element lives in (or the app's focused window), with its window-server number for stacking. */
func targetWindow(_ app: AppRef, _ element: AXUIElement?) -> (CGRect, CGWindowID)? {
  let root = AXUIElementCreateApplication(app.pid)
  let candidates: [AnyObject?] = [element.flatMap { attr($0, kAXWindowAttribute) }, attr(root, kAXFocusedWindowAttribute), attr(root, kAXMainWindowAttribute), windows(root).first as AnyObject?]
  for case let window? in candidates where CFGetTypeID(window) == AXUIElementGetTypeID() {
    guard let rect = frame(window as! AXUIElement), rect.width > 40, rect.height > 40 else { continue }
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let id = list.first { row in
      guard (row[kCGWindowOwnerPID as String] as? Int).map({ pid_t($0) == app.pid }) == true, (row[kCGWindowLayer as String] as? Int) == 0,
            let bounds = row[kCGWindowBounds as String] as? NSDictionary, let box = CGRect(dictionaryRepresentation: bounds) else { return false }
      return abs(box.minX - rect.minX) < 2 && abs(box.minY - rect.minY) < 2 && abs(box.width - rect.width) < 2
    }.flatMap { $0[kCGWindowNumber as String] as? Int }
    return (rect, CGWindowID(id ?? 0))
  }
  return nil
}
/** Shows the cursor on its way to `point` in the app's window before an action; never blocks or fails the action. */
func showCursor(_ app: AppRef, at point: CGPoint?, element: AXUIElement?, args: [String: Any]) {
  guard let cursor = agentCursor, (args["cursor"] as? Bool) != false else { return }
  let window = targetWindow(app, element)
  cursor.mark(window: window?.0, id: window?.1 ?? 0)
  if let point { cursor.move(to: point) } else if let window { cursor.move(to: CGPoint(x: window.0.midX, y: window.0.midY)) }
}
func cursorRest() { agentCursor?.rest() }

// MARK: - Commands

func offSpaceWindows(_ pid: pid_t) -> Int {
  guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return 0 }
  return list.filter { row in
    (row[kCGWindowOwnerPID as String] as? Int).map { pid_t($0) == pid } == true && (row[kCGWindowLayer as String] as? Int) == 0 && (row[kCGWindowIsOnscreen as String] as? Bool) != true && !((row[kCGWindowName as String] as? String) ?? "").isEmpty
  }.count
}
func screenLocked() -> Bool {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return (session["CGSSessionScreenIsLocked"] as? Bool) == true || (session["CGSSessionScreenIsLocked"] as? Int) == 1
}
func appArg(_ args: [String: Any], open: Bool = false) throws -> AppRef {
  guard let name = args["app"] as? String, !name.isEmpty else { throw Failure("Name the app (name, bundle id, .app path or pid).") }
  if let app = findApp(name) { return AppRef(app: app) }
  guard open else { throw Failure("“\(name)” is not running. Read its state to open it in the background.") }
  return AppRef(app: try openApp(name, hidden: (args["hidden"] as? Bool) ?? false))
}
func int(_ value: Any?) -> Int? { (value as? NSNumber)?.intValue ?? (value as? String).flatMap { Int($0) } }

func handle(_ cmd: String, _ args: [String: Any]) throws -> Any {
  switch cmd {
  case "permissions":
    return ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "locked": screenLocked()]
  case "request_permissions":
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let ax = AXIsProcessTrustedWithOptions(options)
    let screen = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    return ["accessibility": ax, "screenRecording": screen]
  case "list_apps":
    return ["apps": runningApps().map(describe)]
  case "cursor_debug":
    return agentCursor?.debug() ?? ["enabled": false]
  default: break
  }
  guard AXIsProcessTrusted() else { throw Failure("Accessibility is off for Muster. Turn it on in System Settings → Privacy & Security → Accessibility, then try again.") }
  if screenLocked() { throw Failure("The screen is locked, so Muster does not act on apps. Ask the person to unlock the Mac.") }
  switch cmd {
  case "open_app":
    let app = AppRef(app: try openApp((args["app"] as? String) ?? "", hidden: (args["hidden"] as? Bool) ?? false))
    return describe(app.app)
  case "state":
    let app = try appArg(args, open: true)
    if let minMs = int(args["settleMs"]), minMs > 0 { settle(app, minMs: minMs, maxMs: int(args["settleMaxMs"]) ?? 5000) }
    if (args["reset"] as? Bool) == true { registries[app.pid] = Registry() }
    let registry = registry(app.pid)
    let (state, list) = snapshot(app, limit: int(args["limit"]) ?? 600, registry: registry)
    registry.prune(keeping: state.live)
    registry.state += 1
    var row: [String: Any] = ["state": registry.state, "app": describe(app.app), "windows": list, "lines": state.lines, "truncated": state.count >= (int(args["limit"]) ?? 600), "busy": state.busy]
    if list.isEmpty, case let away = offSpaceWindows(app.pid), away > 0 { row["offSpaceWindows"] = away; row["hint"] = "\(app.app.localizedName ?? "The app") has \(away) window(s) on another Space or behind a full-screen app. macOS only exposes windows on the current Space. Ask the person to bring it to this Space, or work through the menu bar." }
    if let focused = attr(AXUIElementCreateApplication(app.pid), kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(), let index = registry.byElement[focused as! AXUIElement] { row["focused"] = index }
    if (args["screenshot"] as? Bool) == true { do { row["screenshot"] = try capture(app, maxWidth: int(args["maxWidth"]) ?? 1280) } catch { row["screenshotError"] = (error as? Failure)?.message ?? error.localizedDescription } }
    return row
  case "screenshot":
    return try capture(try appArg(args), maxWidth: int(args["maxWidth"]) ?? 1280)
  case "click":
    let app = try appArg(args)
    let button = (args["button"] as? String) ?? "left", count = int(args["clicks"]) ?? 1
    if let index = int(args["element"]) {
      let target = try element(app, index)
      showCursor(app, at: try? center(target), element: target, args: args); agentCursor?.press(double: count > 1)
      if button == "left" && count == 1 && actions(target).contains(kAXPressAction as String) && AXUIElementPerformAction(target, kAXPressAction as CFString) == .success { return ["via": "press"] }
      if button == "right" && actions(target).contains("AXShowMenu") && AXUIElementPerformAction(target, "AXShowMenu" as CFString) == .success { return ["via": "menu"] }
      click(app, at: try center(target), button: button, count: count); return ["via": "event"]
    }
    guard let x = (args["x"] as? NSNumber)?.doubleValue, let y = (args["y"] as? NSNumber)?.doubleValue else { throw Failure("Give an element number, or x and y in screen points.") }
    showCursor(app, at: CGPoint(x: x, y: y), element: nil, args: args); agentCursor?.press(double: count > 1)
    click(app, at: CGPoint(x: x, y: y), button: button, count: count); return ["via": "event"]
  case "perform_action":
    let app = try appArg(args), target = try element(app, int(args["element"]) ?? -1)
    var name = (args["action"] as? String) ?? "AXPress"
    if !name.hasPrefix("AX") { name = "AX" + name }
    guard actions(target).contains(name) else { throw Failure("That element has no \(name) action. It has: \(actions(target).joined(separator: ", ")).") }
    showCursor(app, at: try? center(target), element: target, args: args); if name == "AXPress" { agentCursor?.press(double: false) }
    let code = AXUIElementPerformAction(target, name as CFString)
    guard code == .success else { throw Failure("The app refused \(name) (\(code.rawValue)).") }
    return ["via": name]
  case "set_value":
    let app = try appArg(args), target = try element(app, int(args["element"]) ?? -1)
    guard let value = args["value"] as? String else { throw Failure("Give the value as text.") }
    if str(target, kAXRoleAttribute) == "AXSecureTextField" { throw Failure("Muster does not fill password fields. Ask the person to enter it.") }
    showCursor(app, at: try? center(target), element: target, args: args); agentCursor?.ringField(frame(target))
    let code = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFString)
    guard code == .success else { throw Failure("The element did not accept a value (\(code.rawValue)). Click it and use type_text instead.") }
    return ["via": "value"]
  case "type_text":
    let app = try appArg(args)
    guard let text = args["text"] as? String else { throw Failure("Give the text to type.") }
    let target = try int(args["element"]).map { try element(app, $0) }
    if let target, str(target, kAXRoleAttribute) == "AXSecureTextField" { throw Failure("Muster does not type into password fields. Ask the person to enter it.") }
    let typingInto = target ?? (attr(AXUIElementCreateApplication(app.pid), kAXFocusedUIElementAttribute)).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    showCursor(app, at: typingInto.flatMap { try? center($0) }, element: typingInto, args: args); agentCursor?.ringField(typingInto.flatMap(frame))
    return ["via": try typeText(app, text, into: target)]
  case "press_key":
    let app = try appArg(args)
    try pressKeys(app, (args["keys"] as? String) ?? ""); return ["via": "event"]
  case "scroll":
    let app = try appArg(args)
    let amount = Int32(int(args["amount"]) ?? 5)
    let direction = (args["direction"] as? String) ?? "down"
    let (dx, dy): (Int32, Int32) = direction == "up" ? (0, amount) : direction == "left" ? (amount, 0) : direction == "right" ? (-amount, 0) : (0, -amount)
    let scrolled = try int(args["element"]).map { try element(app, $0) }
    let point = try scrolled.map { try center($0) }
    showCursor(app, at: point, element: scrolled, args: args)
    scroll(app, at: point, dx: dx, dy: dy); return ["via": "event"]
  default:
    throw Failure("Unknown command \(cmd).")
  }
}

// MARK: - Loop

// AppKit runs on the main thread (the cursor animates there); stdin is read on its own thread and each request runs to
// completion on the main thread before the next is read, so commands never overlap.
setvbuf(stdout, nil, _IOLBF, 0)
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
Thread.detachNewThread {
  let turn = DispatchSemaphore(value: 0)
  while let line = readLine(strippingNewline: true) {
    DispatchQueue.main.async {
      defer { turn.signal() }
      guard let data = line.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { reply(["id": NSNull(), "ok": false, "error": "Bad request."]); return }
      let id = request["id"] ?? NSNull(), cmd = (request["cmd"] as? String) ?? ""
      do { reply(["id": id, "ok": true, "result": try handle(cmd, (request["args"] as? [String: Any]) ?? [:])]) }
      catch let failure as Failure { reply(["id": id, "ok": false, "error": failure.message]) }
      catch { reply(["id": id, "ok": false, "error": error.localizedDescription]) }
      if cmd != "cursor_debug" && agentCursor?.visible == true { cursorRest() }
    }
    turn.wait()
  }
  exit(0)
}
application.run()
