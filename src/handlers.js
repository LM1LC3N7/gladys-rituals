// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());
  gladys.onConfigUpdated((config) => app.configUpdated(config));
  // The first connection starts; a reconnection sends again what Gladys lost.
  gladys.on('connected', async () => {
    try {
      await app.connected();
    } catch (err) {
      logger?.error(`Start failed (${err?.name})`);
    }
  });
}
