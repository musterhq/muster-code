// A small app for the computer-use workflow tests: a text view, a counter button and a label that reports both.
import AppKit
final class Delegate: NSObject, NSApplicationDelegate {
  var window: NSPanel!, text: NSTextView!, label: NSTextField!, count = 0
  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 260), styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false); window.level = .floating; window.hidesOnDeactivate = false
    window.title = "Muster Fixture"; window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    let scroll = NSScrollView(frame: NSRect(x: 20, y: 90, width: 380, height: 150))
    text = NSTextView(frame: scroll.bounds); text.setAccessibilityLabel("Notes"); scroll.documentView = text
    let button = NSButton(title: "Add one", target: self, action: #selector(add)); button.frame = NSRect(x: 20, y: 40, width: 120, height: 32)
    label = NSTextField(labelWithString: "Count 0"); label.frame = NSRect(x: 160, y: 46, width: 240, height: 20)
    window.contentView!.addSubview(scroll); window.contentView!.addSubview(button); window.contentView!.addSubview(label)
    window.setFrameOrigin(NSPoint(x: 0, y: 0)); window.orderFront(nil); window.makeFirstResponder(text)
  }
  @objc func add() { count += 1; label.stringValue = "Count \(count)" }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
