# Legacy Python/PySide6 Code

This directory contains the original Python/PySide6 implementation of XL Converter.

⚠️ **This code is deprecated and kept for reference only.**

## Migration Status

The project has been fully migrated to TypeScript/Electron. See the [MIGRATION.md](../MIGRATION.md) file in the root directory for details.

## Original Implementation

- **Language**: Python 3.13
- **UI Framework**: PySide6 (Qt6)
- **Image Processing**: External CLI tools (cjxl, avifenc, cwebp, ImageMagick, etc.)
- **Build Tool**: PyInstaller

## Current Implementation (TypeScript/Electron)

The new implementation is located in the `src/` directory at the project root:
- **Language**: TypeScript
- **Framework**: Electron
- **Image Processing**: Sharp library (with external cjxl for JPEG XL)

## Contents

- `main.py` - Original application entry point
- `core/` - Core conversion logic and workers
- `data/` - Data structures, configuration, logging
- `ui/` - Qt-based user interface
- `tests/` - Python test suites
- `misc/` - Build scripts and resources
- `build.py` - Original build system

## Why Keep This?

This code is preserved for:
1. Reference when implementing missing features
2. Understanding original business logic
3. Historical documentation
4. Potential fallback if critical issues arise

## Running the Old Code

If you need to run the legacy version:

```bash
cd old
python -m venv env
source env/bin/activate  # On Windows: env\Scripts\activate
pip install -r requirements.txt
python main.py
```

Note: You'll still need the external encoder binaries (cjxl, avifenc, etc.).

---

For the current version, see the main README.md in the project root.
