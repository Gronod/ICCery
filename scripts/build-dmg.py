#!/usr/bin/env python3
"""
Headless macOS DMG Builder for ICCery.

Uses `dmgbuild` to package the .app bundle into a styled DMG with custom
background art, window bounds, and icon locations without requiring Finder
AppleScript automation or an interactive display session.
"""

import argparse
import os
import sys

def parse_args():
    parser = argparse.ArgumentParser(description="Build styled macOS DMG installer")
    parser.add_argument(
        "--app",
        required=True,
        help="Path to the .app application bundle",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Path to the output .dmg file",
    )
    parser.add_argument(
        "--volname",
        default="ICCery",
        help="Volume name for the mounted disk image (default: ICCery)",
    )
    parser.add_argument(
        "--background",
        default="src-tauri/icons/dmg-background.png",
        help="Path to background image (default: src-tauri/icons/dmg-background.png)",
    )
    parser.add_argument(
        "--icon",
        default="src-tauri/icons/icon.icns",
        help="Path to volume icon .icns (default: src-tauri/icons/icon.icns)",
    )
    parser.add_argument(
        "--window-size",
        nargs=2,
        type=int,
        default=[660, 400],
        metavar=("WIDTH", "HEIGHT"),
        help="Window width and height in points (default: 660 400)",
    )
    parser.add_argument(
        "--icon-size",
        type=int,
        default=100,
        help="Icon size in points (default: 100)",
    )
    parser.add_argument(
        "--app-pos",
        nargs=2,
        type=int,
        default=[180, 220],
        metavar=("X", "Y"),
        help="App icon location (default: 180 220)",
    )
    parser.add_argument(
        "--apps-link-pos",
        nargs=2,
        type=int,
        default=[480, 220],
        metavar=("X", "Y"),
        help="Applications symlink location (default: 480 220)",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    app_path = os.path.abspath(args.app)
    output_path = os.path.abspath(args.output)
    bg_path = os.path.abspath(args.background) if args.background else None
    icon_path = os.path.abspath(args.icon) if args.icon else None

    if not os.path.isdir(app_path):
        print(f"Error: Application bundle does not exist at '{app_path}'", file=sys.stderr)
        sys.exit(1)

    if bg_path and not os.path.isfile(bg_path):
        print(f"Error: Background image not found at '{bg_path}'", file=sys.stderr)
        sys.exit(1)

    try:
        import dmgbuild
    except ImportError:
        print("Error: 'dmgbuild' is required. Install via: pip install dmgbuild", file=sys.stderr)
        sys.exit(1)

    app_name = os.path.basename(app_path)
    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    if os.path.exists(output_path):
        os.remove(output_path)

    win_w, win_h = args.window_size
    app_x, app_y = args.app_pos
    apps_x, apps_y = args.apps_link_pos

    settings = {
        "files": [app_path],
        "symlinks": {"Applications": "/Applications"},
        "background": bg_path,
        "icon": icon_path if icon_path and os.path.isfile(icon_path) else None,
        "icon_size": args.icon_size,
        "window_rect": ((100, 100), (win_w, win_h)),
        "icon_locations": {
            app_name: (app_x, app_y),
            "Applications": (apps_x, apps_y),
        },
        "format": "UDZO",
    }

    print(f"Building DMG for {app_name}...")
    print(f"  Volume Name:   {args.volname}")
    print(f"  App Bundle:    {app_path}")
    print(f"  Background:    {bg_path}")
    print(f"  Window Size:   {win_w}x{win_h}")
    print(f"  App Position:  ({app_x}, {app_y})")
    print(f"  Apps Position: ({apps_x}, {apps_y})")
    print(f"  Output Path:   {output_path}")

    try:
        dmgbuild.build_dmg(output_path, args.volname, settings=settings)
    except Exception as e:
        print(f"Error: dmgbuild failed: {e}", file=sys.stderr)
        sys.exit(1)

    if not os.path.isfile(output_path):
        print(f"Error: Expected output DMG file '{output_path}' was not created", file=sys.stderr)
        sys.exit(1)

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"Successfully generated DMG ({size_mb:.2f} MB): {output_path}")


if __name__ == "__main__":
    main()
