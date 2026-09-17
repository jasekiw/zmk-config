#!/usr/bin/env python3
"""Dump the live ZMK Studio keymap and compare it to a .keymap file.

Uses https://github.com/srwi/zmk-studio-api for the Studio RPC connection.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import zmk_studio_api as zmk

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_KEYMAP = REPO_ROOT / "config" / "piantor_pro_bt.keymap"

FILE_BEHAVIOR = {
    "kp": "KeyPress",
    "kt": "KeyToggle",
    "lt": "LayerTap",
    "mt": "ModTap",
    "sk": "StickyKey",
    "sl": "StickyLayer",
    "mo": "MomentaryLayer",
    "tog": "ToggleLayer",
    "to": "ToLayer",
    "bt": "Bluetooth",
    "ext_power": "ExternalPower",
    "out": "OutputSelection",
    "bl": "Backlight",
    "rgb_ug": "Underglow",
    "mkp": "MouseKeyPress",
    "caps_word": "CapsWord",
    "key_repeat": "KeyRepeat",
    "sys_reset": "Reset",
    "reset": "Reset",
    "bootloader": "Bootloader",
    "soft_off": "SoftOff",
    "studio_unlock": "StudioUnlock",
    "gresc": "GraveEscape",
    "trans": "Transparent",
    "none": "None",
}

DISPLAY_TO_KIND = {
    "key press": "KeyPress",
    "key toggle": "KeyToggle",
    "layer tap": "LayerTap",
    "mod-tap": "ModTap",
    "mod tap": "ModTap",
    "sticky key": "StickyKey",
    "sticky layer": "StickyLayer",
    "momentary layer": "MomentaryLayer",
    "toggle layer": "ToggleLayer",
    "to layer": "ToLayer",
    "bluetooth": "Bluetooth",
    "external power": "ExternalPower",
    "output": "OutputSelection",
    "output selection": "OutputSelection",
    "backlight": "Backlight",
    "rgb underglow": "Underglow",
    "underglow": "Underglow",
    "mouse key press": "MouseKeyPress",
    "caps word": "CapsWord",
    "key repeat": "KeyRepeat",
    "reset": "Reset",
    "bootloader": "Bootloader",
    "enter bootloader": "Bootloader",
    "soft off": "SoftOff",
    "studio unlock": "StudioUnlock",
    "unlock studio": "StudioUnlock",
    "grave escape": "GraveEscape",
    "transparent": "Transparent",
    "none": "None",
}

KEYCODE_ALIASES = {
    "N1": "NUM_1",
    "N2": "NUM_2",
    "N3": "NUM_3",
    "N4": "NUM_4",
    "N5": "NUM_5",
    "N6": "NUM_6",
    "N7": "NUM_7",
    "N8": "NUM_8",
    "N9": "NUM_9",
    "N0": "NUM_0",
    "RET": "ENTER",
    "RETURN": "ENTER",
    "LSHFT": "LSHIFT",
    "LGUI": "LEFT_META",
    "RGUI": "RIGHT_META",
    "SPACE": "SPC",
    "SQT": "APOSTROPHE",
    "GRAVE": "GRAV",
    "TILDE": "TILD",
    "EQUAL": "EQL",
    "CARET": "CRRT",
}

BT_CMDS = {
    "BT_CLR": (0, 0),
    "BT_NXT": (1, 0),
    "BT_PRV": (2, 0),
    "BT_SEL": (3, None),
    "BT_CLR_ALL": (4, 0),
    "BT_DISC": (5, None),
}

RGB_CMDS = {
    "RGB_TOG": (0, 0),
    "RGB_ON": (1, 0),
    "RGB_OFF": (2, 0),
    "RGB_HUI": (3, 0),
    "RGB_HUD": (4, 0),
    "RGB_SAI": (5, 0),
    "RGB_SAD": (6, 0),
    "RGB_BRI": (7, 0),
    "RGB_BRD": (8, 0),
    "RGB_SPI": (9, 0),
    "RGB_SPD": (10, 0),
    "RGB_EFF": (11, 0),
    "RGB_EFR": (12, 0),
}


@dataclass(frozen=True)
class Binding:
    kind: str
    param1: int = 0
    param2: int = 0
    raw: str = ""

    def key(self) -> tuple[str, int, int]:
        return (self.kind, self.param1, self.param2)


@dataclass
class Layer:
    layer_id: int
    name: str
    bindings: list[Binding]


def _read_varint(data: bytes, i: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while i < len(data):
        byte = data[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if byte & 0x80 == 0:
            return value, i
        shift += 7
    raise ValueError("truncated varint")


def _unzigzag(n: int) -> int:
    return (n >> 1) ^ -(n & 1)


def _parse_fields(data: bytes) -> list[tuple[int, int, int | bytes]]:
    fields: list[tuple[int, int, int | bytes]] = []
    i = 0
    while i < len(data):
        key, i = _read_varint(data, i)
        field = key >> 3
        wire = key & 7
        if wire == 0:
            value, i = _read_varint(data, i)
            fields.append((field, wire, value))
        elif wire == 2:
            length, i = _read_varint(data, i)
            fields.append((field, wire, data[i : i + length]))
            i += length
        else:
            raise ValueError(f"unsupported proto wire type {wire}")
    return fields


def decode_device_info(data: bytes) -> str:
    name = ""
    for field, _wire, value in _parse_fields(data):
        if field == 1 and isinstance(value, bytes):
            name = value.decode("utf-8", "replace")
    return name


def decode_behavior_details(data: bytes) -> tuple[int, str]:
    behavior_id = 0
    display_name = ""
    for field, _wire, value in _parse_fields(data):
        if field == 1 and isinstance(value, int):
            behavior_id = value
        elif field == 2 and isinstance(value, bytes):
            display_name = value.decode("utf-8", "replace")
    return behavior_id, display_name


def decode_keymap(data: bytes) -> list[Layer]:
    layers: list[Layer] = []
    for field, _wire, value in _parse_fields(data):
        if field != 1 or not isinstance(value, bytes):
            continue
        layer_id = 0
        name = ""
        bindings: list[Binding] = []
        for lfield, _lwire, lvalue in _parse_fields(value):
            if lfield == 1 and isinstance(lvalue, int):
                layer_id = lvalue
            elif lfield == 2 and isinstance(lvalue, bytes):
                name = lvalue.decode("utf-8", "replace")
            elif lfield == 3 and isinstance(lvalue, bytes):
                behavior_id = 0
                param1 = 0
                param2 = 0
                for bfield, _bwire, bvalue in _parse_fields(lvalue):
                    if bfield == 1 and isinstance(bvalue, int):
                        behavior_id = _unzigzag(bvalue)
                    elif bfield == 2 and isinstance(bvalue, int):
                        param1 = bvalue
                    elif bfield == 3 and isinstance(bvalue, int):
                        param2 = bvalue
                bindings.append(
                    Binding(
                        kind=f"id:{behavior_id}",
                        param1=param1,
                        param2=param2,
                        raw=f"id:{behavior_id}",
                    )
                )
        layers.append(Layer(layer_id, name, bindings))
    return layers


def _keycode_usage(name: str) -> int | None:
    name = name.upper()
    mapped = KEYCODE_ALIASES.get(name, name)
    member = zmk.Keycode.__members__.get(mapped)
    if member is None:
        return None
    return int(member)


def _usage_name(usage: int) -> str | None:
    for member in zmk.Keycode:
        if int(member) == usage:
            return member.name
    return None


def _expand_file_params(kind: str, args: list[str]) -> tuple[int, int]:
    if not args:
        return 0, 0

    if kind == "Bluetooth" and args[0] in BT_CMDS:
        command, extra = BT_CMDS[args[0]]
        if extra is None:
            value = int(args[1]) if len(args) > 1 else 0
            return command, value
        return command, extra

    if kind == "Underglow" and args[0] in RGB_CMDS:
        return RGB_CMDS[args[0]]

    values: list[int] = []
    for arg in args:
        usage = _keycode_usage(arg)
        if usage is not None:
            values.append(usage)
            continue
        try:
            values.append(int(arg, 0))
        except ValueError:
            values.append(0)
    while len(values) < 2:
        values.append(0)
    return values[0], values[1]


def _parse_binding_list(binding_text: str) -> list[Binding]:
    binding_text = re.sub(r"//.*?$", "", binding_text, flags=re.M)
    tokens = re.findall(r"&[A-Za-z0-9_]+|[A-Za-z0-9_]+|0x[0-9A-Fa-f]+|-?\d+", binding_text)
    bindings: list[Binding] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if not token.startswith("&"):
            i += 1
            continue
        behavior = token[1:]
        i += 1
        args: list[str] = []
        while i < len(tokens) and not tokens[i].startswith("&"):
            args.append(tokens[i])
            i += 1
        kind = FILE_BEHAVIOR.get(behavior, behavior)
        param1, param2 = _expand_file_params(kind, args)
        raw = " ".join([f"&{behavior}", *args])
        bindings.append(Binding(kind, param1, param2, raw))
    return bindings


def parse_keymap_file(path: Path) -> list[Layer]:
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    layers: list[Layer] = []
    for index, match in enumerate(
        re.finditer(
            r'display-name\s*=\s*"(?P<name>[^"]+)"\s*;\s*(?://[^\n]*\n\s*)*bindings\s*=\s*<(?P<bindings>[^>]*)>',
            text,
            re.S,
        )
    ):
        layers.append(
            Layer(
                layer_id=index,
                name=match.group("name"),
                bindings=_parse_binding_list(match.group("bindings")),
            )
        )
    return layers


def format_binding(binding: Binding) -> str:
    if binding.raw:
        return binding.raw
    if binding.kind == "KeyPress":
        name = _usage_name(binding.param1)
        return f"&kp {name}" if name else f"&kp 0x{binding.param1:x}"
    if binding.kind == "MomentaryLayer":
        return f"&mo {binding.param1}"
    if binding.kind == "ToggleLayer":
        return f"&tog {binding.param1}"
    if binding.kind == "ToLayer":
        return f"&to {binding.param1}"
    if binding.kind == "Transparent":
        return "&trans"
    if binding.kind == "None":
        return "&none"
    if binding.kind == "Reset":
        return "&sys_reset"
    if binding.kind == "Bootloader":
        return "&bootloader"
    if binding.kind == "StudioUnlock":
        return "&studio_unlock"
    if binding.kind == "Bluetooth":
        return f"&bt {binding.param1} {binding.param2}"
    if binding.kind == "Underglow":
        return f"&rgb_ug {binding.param1} {binding.param2}"
    if binding.kind.startswith("id:"):
        return f"&{binding.kind} {binding.param1} {binding.param2}".rstrip()
    if binding.param1 == 0 and binding.param2 == 0:
        return f"&{binding.kind}"
    if binding.param2 == 0:
        return f"&{binding.kind} {binding.param1}"
    return f"&{binding.kind} {binding.param1} {binding.param2}"


def list_serial_ports() -> list[str]:
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    preferred = []
    other = []
    for port in list_ports.comports():
        blob = f"{port.device} {port.description} {port.hwid}".lower()
        if any(token in blob for token in ("zmk", "nrf", "cdc", "usb serial")):
            preferred.append(port.device)
        else:
            other.append(port.device)
    return preferred + other


def open_client(port: str | None) -> zmk.StudioClient:
    candidates = [port] if port else list_serial_ports()
    if not candidates:
        raise SystemExit("No serial port found. Pass --port COM3 (Windows) or /dev/ttyACM0.")
    errors: list[str] = []
    for candidate in candidates:
        try:
            return zmk.StudioClient.open_serial(candidate)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{candidate}: {exc}")
    raise SystemExit("Could not open a Studio serial port:\n  " + "\n  ".join(errors))


def fetch_device_layers(client: zmk.StudioClient) -> tuple[str, list[Layer]]:
    lock = client.get_lock_state()
    if "LOCKED" in lock.upper():
        print("Studio is locked. Press &studio_unlock (Lower + B on the stock map), then rerun.")
    try:
        info = decode_device_info(bytes(client.get_device_info_bytes()))
        layers = decode_keymap(bytes(client.get_keymap_bytes()))
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            f"Failed to read keymap ({exc}). Unlock the keyboard with &studio_unlock and retry."
        ) from exc

    names: dict[int, str] = {}
    used_ids = {int(binding.raw.split(":", 1)[1]) for layer in layers for binding in layer.bindings}
    for behavior_id in sorted(used_ids):
        _, display_name = decode_behavior_details(bytes(client.get_behavior_details_bytes(behavior_id)))
        names[behavior_id] = DISPLAY_TO_KIND.get(display_name.lower(), display_name or f"id:{behavior_id}")

    for layer in layers:
        for index, binding in enumerate(layer.bindings):
            behavior_id = int(binding.raw.split(":", 1)[1])
            kind = names.get(behavior_id, binding.kind)
            layer.bindings[index] = Binding(kind, binding.param1, binding.param2)
    return info or "ZMK keyboard", layers


def dump_layers(title: str, layers: list[Layer]) -> None:
    print(title)
    for layer in layers:
        print(f"  [{layer.layer_id}] {layer.name} ({len(layer.bindings)} keys)")
        for position, binding in enumerate(layer.bindings):
            print(f"    {position:3d}  {format_binding(binding)}")


def compare_layers(file_layers: list[Layer], device_layers: list[Layer]) -> int:
    diffs = 0
    count = max(len(file_layers), len(device_layers))
    for index in range(count):
        file_layer = file_layers[index] if index < len(file_layers) else None
        device_layer = device_layers[index] if index < len(device_layers) else None
        file_name = file_layer.name if file_layer else "(missing)"
        device_name = device_layer.name if device_layer else "(missing)"
        print(f"Layer {index}: file={file_name}  device={device_name}")
        if file_layer is None or device_layer is None:
            print("  DIFF  layer present on only one side")
            diffs += 1
            continue
        positions = max(len(file_layer.bindings), len(device_layer.bindings))
        for position in range(positions):
            file_binding = (
                file_layer.bindings[position] if position < len(file_layer.bindings) else None
            )
            device_binding = (
                device_layer.bindings[position] if position < len(device_layer.bindings) else None
            )
            file_text = format_binding(file_binding) if file_binding else "(missing)"
            device_text = format_binding(device_binding) if device_binding else "(missing)"
            same = (
                file_binding is not None
                and device_binding is not None
                and file_binding.key() == device_binding.key()
            )
            if same:
                continue
            diffs += 1
            print(f"  {position:3d}  file={file_text}  device={device_text}")
    return diffs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("dump", "compare"), help="dump device map or diff it")
    parser.add_argument("--port", help="Studio USB serial port, e.g. COM3")
    parser.add_argument(
        "--keymap",
        type=Path,
        default=DEFAULT_KEYMAP,
        help="Repo keymap file to compare (default: config/piantor_pro_bt.keymap)",
    )
    args = parser.parse_args()

    client = open_client(args.port)
    device_name, device_layers = fetch_device_layers(client)
    print(f"Device: {device_name}")
    print(f"Lock:   {client.get_lock_state()}")
    print()

    if args.command == "dump":
        dump_layers("Device keymap", device_layers)
        return 0

    if not args.keymap.exists():
        raise SystemExit(f"Keymap file not found: {args.keymap}")
    file_layers = parse_keymap_file(args.keymap)
    print(f"File:   {args.keymap}")
    print()
    diffs = compare_layers(file_layers, device_layers)
    print()
    if diffs == 0:
        print("No differences.")
        return 0
    print(f"{diffs} difference(s).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
