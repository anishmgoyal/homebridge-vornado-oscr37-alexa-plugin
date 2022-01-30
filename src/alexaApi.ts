import AlexaRemote from 'alexa-remote2';
import { InitOptions } from 'alexa-remote2';
import { Observable, of, ReplaySubject, throwError } from 'rxjs';
import { filter, first, switchMap, timeout } from 'rxjs/operators';
import { OSCR37HomebridgePlatformConfig } from './settings';

/**
 * Adds missing properties that are used by amazon-cookie to alexa-remote
 */
interface InitOptionsWithExtras extends Exclude<InitOptions, string> {
    amazonPageProxyLanguage: string;
    baseAmazonPage: string;
}

/**
 * All allowed fan commands for the OSCR37, via the Amazon API
 */
export type FanCommand = FanPowerToggleCommand | FanIntensityChangeCommand | FanOscillationToggleCommand;

/**
 * Turns a fan on or off
 */
export class FanPowerToggleCommand {
    readonly action: 'turnOn' | 'turnOff';
    constructor(isOn: boolean) {
        this.action = isOn ? 'turnOn' : 'turnOff';
    }

    toObject() {
        return {
            action: this.action,
        };
    }
}

/**
 * Sets the intensity for a fan
 */
export class FanIntensityChangeCommand {
    readonly action = 'setModeValue';
    readonly instance = '1';
    constructor(public readonly intensity: '0' | '1' | '2' | '3') {
    }

    toObject() {
        return {
            action: this.action,
            instance: this.instance,
            mode: this.intensity,
        };
    }
}

/**
 * Toggles whether or not the fan oscillates
 */
export class FanOscillationToggleCommand {
    readonly instance = '2';
    readonly action: 'turnOnToggle'|'turnOffToggle';
    constructor(isOscillating: boolean) {
        this.action = isOscillating ? 'turnOnToggle' : 'turnOffToggle';
    }

    toObject() {
        return {
            action: this.action,
            instance: this.instance,
        };
    }
}

export interface FanStatus {
    connected?: boolean;
    isOn?: boolean;
    fanIntensity?: '0' | '1' | '2' | '3' | '4';
    isOscillating?: boolean;
    shutdownTimer?: '0' | '1' | '2' | '3' | '4';
}

export class ApiConfig {
    /**
     * Set parameters for API related behavior
     * @param timeout Timeout for fan commands in milliseconds
     */
    constructor(public readonly timeout = 30 * 1000) {
    }
}

export class AlexaApi {

    remote = new AlexaRemote();

    initialized$ = new ReplaySubject<boolean>(1);

    initializedWithTimeout$ = this.initialized$.pipe(
        filter(initialized => initialized),
        timeout(this.apiConfig.timeout),
        first(),
    );

    /**
     * Initializes an Alexa client
     * @param config Configuration for the platform
     * @param apiConfig Configuration for API commands
     */
    constructor(public readonly config: OSCR37HomebridgePlatformConfig,
        public readonly apiConfig: ApiConfig) {
        const initOptions: InitOptionsWithExtras = {
            // The library didn't properly define types for the cookie
            // object, but a cookie with former registration data is supported.
            // Pass the cookie in as is.
            cookie: config.cookie as any,
            proxyOnly: true,
            proxyOwnIp: 'localhost',
            proxyPort: 3001,
            proxyLogLevel: 'info',
            bluetooth: true,
            logger: console.log,
            alexaServiceHost: config.alexaServiceHost,
            amazonPage: config.amazonPage,
            baseAmazonPage: config.amazonPage,
            amazonPageProxyLanguage: config.amazonProxyLang,
            useWsMqtt: true,
            cookieRefreshInterval: 7 * 24 * 60 * 60 * 1000,
        };

        const init = new Observable<boolean>(observer => {
            observer.next(false);
            this.remote.init(initOptions, err => {
                // Init will retry this function later if initialization succeeds,
                // so don't close an observable until we successfully connect
                if (err != null) {
                    observer.next(false);
                    console.error('Failed to initialize Alexa API:', err);
                } else {
                    observer.next(true);
                    observer.complete();
                }
            });
        });

        init.subscribe(this.initialized$);
    }

    /**
     * Get information about a fan
     * @param queryId The id for the fan to query data for
     * @returns An observable that will emit the current state for
     * some features of the fan
     */
    getDeviceStatus(queryId: string): Observable<FanStatus> {
        return this.initializedWithTimeout$.pipe(
            switchMap(() => {
                return new Observable<DeviceQueryResult>(observer => {
                    this.remote.querySmarthomeDevices(
                        [queryId],
                        'APPLIANCE',
                        function (err, res) {
                            if (err != null) {
                                observer.error(err);
                            } else {
                                observer.next(res as unknown as DeviceQueryResult);
                                observer.complete();
                            }
                        }
                    );
                }).pipe(
                    switchMap(res => this.parseDeviceResponse(res)),
                );
            }),
        );
    }

    /**
     * Executes a command on the specified fan / fans
     * @param controlId The id for the fan, or fans, to control
     * @param command The command to send the fan (power toggle, intensity,
     * oscillate)
     */
    sendDeviceAction(controlId: string | string[],
        command: FanCommand): Observable<any> {
        const controlIds = Array.isArray(controlId) ? controlId : [controlId];
        return this.initializedWithTimeout$.pipe(
            switchMap(() => {
                return new Observable(observer => {
                    this.remote.executeSmarthomeDeviceAction(
                        controlIds,
                        command.toObject() as any,
                        'APPLIANCE',
                        (err, result) => {
                            if (err != null) {
                                observer.error(err);
                            } else {
                                observer.next(result);
                                observer.complete();
                            }
                        });
                });
            }),
        );
    }

    private parseDeviceResponse(res: DeviceQueryResult): Observable<FanStatus> {
        if (res.errors?.length ?? 0) {
            console.error('Got errors from device state request');
            console.error(res.errors);
        }
        if ((res.deviceStates?.length ?? 0) < 1) {
            return throwError(() => new Error('No device state received'));
        }
        const [deviceState] = res.deviceStates;
        if (deviceState.error) {
            console.error('Got reported error for device state');
            console.error(deviceState.error);
        }

        const states = deviceState.capabilityStates.map(
            state => JSON.parse(state)
        );

        return of<FanStatus>(this.parseCapabilityStates(states));
    }

    private parseCapabilityStates(states: DeviceCapabilityState[]): FanStatus {
        const fanStatus: FanStatus = {};
        for (const state of states) {
            console.log(state);
            if (state.namespace === 'Alexa.EndpointHealth') {
                fanStatus.connected = state.value?.value === 'OK';
            } else if (state.namespace === 'Alexa.PowerController') {
                if (state.value != null) {
                    fanStatus.isOn = state.value === 'ON';
                }
            } else if (state.namespace === 'Alexa.ModeController') {
                if (state.instance === '1' && state.value != null) {
                    // fan intensity
                    if (state.value !== '0' &&
                        state.value !== '1' &&
                        state.value !== '2' &&
                        state.value !== '3') {
                        throw new Error(`Unsupported state for fan intensity: ${state}`);
                    }
                    fanStatus.fanIntensity = state.value;
                } else if (state.instance === '3' && state.value != null) {
                    // fan shutdown timer
                    if (state.value !== '0' &&
                        state.value !== '1' &&
                        state.value !== '2' &&
                        state.value !== '3' &&
                        state.value !== '4') {
                        console.warn(`Ignoring unsupported value for shutdown timer: ${state}`);
                        continue;
                    }
                    fanStatus.shutdownTimer = state.value;
                } else {
                    console.warn(`Ignoring mode: ${state}`);
                }
            } else if (state.namespace === 'Alexa.ToggleController') {
                if (state.instance === '2' && state.value != null) {
                    fanStatus.isOscillating = state.value === 'ON';
                } else {
                    console.warn(`Ignoring toggle: ${state}`);
                }
            } else {
                console.warn(`Unexpected namespace on state: ${state}`);
            }
        }
        return fanStatus;
    }
}

// Private APIs defined here

interface DeviceQueryResult {
    deviceStates: {
        entity: {
            entityId: string;
            entityType: string;
        };
        capabilityStates: string[];
        error: any;
    }[];

    errors: any[];
}

type DeviceCapabilityState =
    DeviceHealthData | DevicePowerData | DeviceModeData | DeviceToggleData;

interface DeviceHealthData {
    namespace: 'Alexa.EndpointHealth';
    name: string;
    value: {
        value: string;
    };
}

interface DevicePowerData {
    namespace: 'Alexa.PowerController';
    name: string;
    value: 'ON'|'OFF';
}

interface DeviceModeData {
    namespace: 'Alexa.ModeController';
    name: string;
    instance: string;
    value: '0'|'1'|'2'|'3'|'4';
}

interface DeviceToggleData {
    namespace: 'Alexa.ToggleController';
    name: string;
    instance: string;
    value: 'ON'|'OFF';
}
