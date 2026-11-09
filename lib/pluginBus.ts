// @ts-nocheck
/***
 * lib/pluginBus.ts
 *
 * A lightweight event bus that lets plugins talk to each other
 * without direct import coupling.
 *
 * PUBLISHING (e.g. attendance.ts):
 *   import bus from '../lib/pluginBus';
 *   bus.emit('attendance:submitted', { userId, name, dob });
 *
 * SUBSCRIBING (e.g. birthday.ts):
 *   import bus from '../lib/pluginBus';
 *   bus.on('attendance:submitted', async ({ userId, name, dob }) => { ... });
 */

import { EventEmitter } from 'events';

type Handler = (...args: any[]) => void | Promise<void>;

class PluginBus extends EventEmitter {
  constructor() {
    super();
    // Raise the default listener limit — plugins can have many subscriptions
    this.setMaxListeners(50);
  }

  /**
   * Same as .on() but automatically wraps the handler in try/catch so a
   * crashing subscriber never kills the publisher's flow.
   */
  on(event: string | symbol, handler: Handler): this {
    return super.on(event, async (...args: any[]) => {
      try {
        await handler(...args);
      } catch (err: any) {
        console.error(`[PluginBus] Error in listener for "${String(event)}": ${err.message}`);
      }
    });
  }
}

const bus = new PluginBus();
export default bus;
