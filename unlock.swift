import CoreGraphics
import Foundation

func tap(_ keyCode: CGKeyCode, shift: Bool = false) {
    var flags: CGEventFlags = []
    if shift { flags = .maskShift }
    if let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true) {
        down.flags = flags
        down.post(tap: .cghidEventTap)
    }
    usleep(80000)
    if let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) {
        up.flags = flags
        up.post(tap: .cghidEventTap)
    }
    usleep(80000)
}

let charToKey: [Character: (CGKeyCode, Bool)] = [
    "a": (0,false), "b": (11,false), "c": (8,false), "d": (2,false),
    "e": (14,false), "f": (3,false), "g": (5,false), "h": (4,false),
    "i": (34,false), "j": (38,false), "k": (40,false), "l": (37,false),
    "m": (46,false), "n": (45,false), "o": (31,false), "p": (35,false),
    "q": (12,false), "r": (15,false), "s": (1,false), "t": (17,false),
    "u": (32,false), "v": (9,false), "w": (13,false), "x": (7,false),
    "y": (16,false), "z": (6,false),
    "A": (0,true), "B": (11,true), "C": (8,true), "D": (2,true),
    "E": (14,true), "F": (3,true), "G": (5,true), "H": (4,true),
    "I": (34,true), "J": (38,true), "K": (40,true), "L": (37,true),
    "M": (46,true), "N": (45,true), "O": (31,true), "P": (35,true),
    "Q": (12,true), "R": (15,true), "S": (1,true), "T": (17,true),
    "U": (32,true), "V": (9,true), "W": (13,true), "X": (7,true),
    "Y": (16,true), "Z": (6,true),
    "0": (29,false), "1": (18,false), "2": (19,false), "3": (20,false),
    "4": (21,false), "5": (23,false), "6": (22,false), "7": (26,false),
    "8": (28,false), "9": (25,false),
    "@": (19,true), "!": (18,true), "#": (20,true), "$": (21,true),
    "%": (23,true), "^": (22,true), "&": (26,true), "*": (28,true),
    "(": (25,true), ")": (29,true), "-": (27,false), "=": (24,false),
    "_": (27,true), "+": (24,true), "[": (33,false), "]": (30,false),
    "{": (33,true), "}": (30,true), "\\": (42,false), "|": (42,true),
    ";": (41,false), ":": (41,true), "'": (39,false), "\"": (39,true),
    ",": (43,false), "<": (43,true), ".": (47,false), ">": (47,true),
    "/": (44,false), "?": (44,true),
]

// Escape 清空密码框
tap(53)
Thread.sleep(forTimeInterval: 0.5)

// 点击激活密码框
if let d = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
    mouseCursorPosition: CGPoint(x: 960, y: 540), mouseButton: .left) {
    d.post(tap: .cghidEventTap)
}
usleep(50000)
if let u = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
    mouseCursorPosition: CGPoint(x: 960, y: 540), mouseButton: .left) {
    u.post(tap: .cghidEventTap)
}
Thread.sleep(forTimeInterval: 1)

// 从命令行参数读密码
let pwd = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
for c in pwd {
    if let (code, shift) = charToKey[c] { tap(code, shift: shift) }
}
Thread.sleep(forTimeInterval: 0.3)
tap(36) // Return
