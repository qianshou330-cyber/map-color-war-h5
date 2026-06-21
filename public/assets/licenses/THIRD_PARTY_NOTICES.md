# Third-party asset notices

This project currently uses code-drawn UI details, Phaser-rendered combat icons, and Web Audio generated sound effects. No third-party image, icon, or audio file is bundled in this directory yet.

Planned safe asset sources:

- Kenney assets: CC0 / public domain. Good for future UI packs, small icons, and interface polish.
- Freesound: use only samples explicitly marked CC0 unless attribution is added here.
- OpenGameArt: use only assets explicitly marked CC0 unless attribution is added here.
- Game-icons.net: CC BY 3.0. Use only with attribution if an original icon file is copied into the project.

The crossed-blades combat marker in the current game is drawn in code and does not copy a third-party icon.

## Yulin-W/alternate-history-editor

- Source: https://github.com/Yulin-W/alternate-history-editor
- License: MIT License
- Usage: the built-in `1206 Rise of Mongolia` default map is generated from the repository's `Historic Scenarios/1206-Rise-of-Mongolia.json` scenario and `docs/module/map_admin.js` GeoJSON basemap. The game stores a compact derived `EditableMapData` JSON and does not import the original timeline, legend, UI, or Leaflet runtime.
