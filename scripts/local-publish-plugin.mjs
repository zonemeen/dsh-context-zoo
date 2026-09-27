/** Keep npm authentication and diagnostics connected to the caller's terminal. */
import { Plugin } from 'release-it';

export default class LocalPublish extends Plugin {
  async afterRelease() {
    // Git has disabled rollback before external plugins run this lifecycle method.
    await this.exec([process.execPath, 'scripts/publish-local.mjs'], { options: { interactive: true } });
  }
}
