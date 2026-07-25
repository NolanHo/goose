// Web entry point.
//
// Order matters: the shim installs window.electron / window.appConfig before
// the renderer evaluates, so every IPC call resolves to a web implementation.

import './shim';

// Desktop renderer styles (Tailwind + base).
import '../../desktop/src/styles/main.css';

// Boot the actual React app — identical to the desktop renderer.
import '../../desktop/src/renderer';
