/** Activated bootstrap/canonical barriers, plus default-disabled/offline/storage gates.
 * Chrome/HTTP/IDB and explicitly labelled models remain separate from native SDK proof. */
import './outbox-reconcile-browser.mjs';
await import('./outbox-reconcile-journals.mjs');
await import('./outbox-reconcile-capacity.mjs');
await import('./outbox-retention-browser.mjs');
await import('../../../tests/browser-native-outbox-pause.mjs');
await import('../../../tests/browser-native-session-logout.mjs');
