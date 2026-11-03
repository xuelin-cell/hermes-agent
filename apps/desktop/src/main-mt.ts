// desktop-mt: the entry point of the page. The cloud's browser build wires what the signed-in
// account can use (dev/browser-bridge.ts) before the rest of the app loads: bundled plugins start
// while their modules load (app/contrib/controller.tsx) and ask the bridge what is there. In Electron
// there is nothing to wait for.
import './dev/browser-bridge'

void Promise.resolve(window.hermesDesktop?.accountReady).then(() => import('./main'))
