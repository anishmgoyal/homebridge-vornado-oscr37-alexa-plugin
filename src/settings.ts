import { PlatformConfig } from 'homebridge';

/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'VornadoOSCR37HomebridgePlugin';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = '@anishmgoyal/homebridge-vornado-oscr37-alexa-plugin';

// BEGIN configuration type definitions

export interface OSCR37Device extends Record<string, any> {
    displayName: string;
    controlId: string;
    queryId: string;
}

export interface OSCR37HomebridgePlatformConfig extends PlatformConfig {
    devices: OSCR37Device[];
    amazonPage: string;
    amazonProxyLang: string;
    alexaServiceHost: string;

    // We don't control the data encapsulated in this type, so we won't
    // bother enumerating it; this code shouldn't explicitly touch the
    // data in it.
    cookie: object;
}
