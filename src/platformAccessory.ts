import { Categories, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { firstValueFrom, Observable, of, Subject } from 'rxjs';
import { catchError, shareReplay, switchMap, throttleTime } from 'rxjs/operators';
import { FanPowerToggleCommand, FanIntensityChangeCommand, FanOscillationToggleCommand, FanStatus } from './alexaApi';
import { OSCR37FanService, OSCR37RotationSpeed } from './oscr37ServiceProvider';

import { OSCR37HomebridgePlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class OSCR37HomebridgePlatformAccessory {
  private service: Service;

  private displayName: string;
  private controlId: string;
  private queryId: string;

  private requestedFanUpdate$: Subject<void> = new Subject();

  private readonly CharName = this.platform.Characteristic.Name;
  private readonly CharActive = this.platform.Characteristic.Active;
  private readonly CharSwingMode = this.platform.Characteristic.SwingMode;

  // Let's try our best to group requests to get fan state, if
  // requests come in at the same time
  private fanStatus$ = this.requestedFanUpdate$.pipe(
    throttleTime(20),
    switchMap(() =>
      this.platform.alexaClient.getDeviceStatus(this.queryId).pipe(
        catchError(err => {
          this.platform.log.error(`Error getting status: ${err}`);
          return of({
            connected: false,
          } as FanStatus);
        }),
      )),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  private poller: {
    fanStatus$: Observable<FanStatus>,
    requestedFanUpdate$: Subject<void>,
    previous?: FanStatus,
    poll(): Promise<FanStatus | null>,
  } = {
      fanStatus$: this.fanStatus$,
      requestedFanUpdate$: this.requestedFanUpdate$,
      async poll() {
        // Create a subscriber for the fan status observable, to make sure that
        // the transforms are actually applied; otherwise, nothing will happen
        const newState = firstValueFrom(this.fanStatus$);
        this.requestedFanUpdate$.next();

        const current = await newState;
        let isChanged = false;
        if (this.previous == null) {
          isChanged = true;
        } else {
          isChanged = (current.isOn !== this.previous.isOn) ||
            (current.fanIntensity !== this.previous.fanIntensity) ||
            (current.isOscillating !== this.previous.isOscillating);
        }
        this.previous = current;
        if (isChanged) {
          return current;
        }
        return null;
      },
    };

  constructor(
    private readonly platform: OSCR37HomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.displayName = accessory.context.device.displayName;
    this.controlId = accessory.context.device.controlId;
    this.queryId = accessory.context.device.queryId;

    this.accessory.category = Categories.FAN;

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Vornado')
      .setCharacteristic(this.platform.Characteristic.Model, 'OSCR37')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.controlId);

    // Get or set the fan service, and set the fan's name
    this.service = this.accessory.getService(OSCR37FanService) || this.accessory.addService(OSCR37FanService);
    this.service.setCharacteristic(this.CharName, this.displayName);

    // Set fan characteristic methods
    this.service.getCharacteristic(this.CharActive)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));
    this.service.getCharacteristic(OSCR37RotationSpeed)
      .onSet(this.setIntensity.bind(this))
      .onGet(this.getIntensity.bind(this));
    this.service.getCharacteristic(this.CharSwingMode)
      .onSet(this.setSwingMode.bind(this))
      .onGet(this.getSwingMode.bind(this));

    if (this.platform.config.enablePolling) {
      setInterval(
        async () => {
          const state = await this.poller.poll();
          // We get a state back if anything changed; otherwise, we get null
          // back
          if (state != null) {
            this.updateCharacteristics(state);
          }
        },
        this.platform.config.pollInterval * 1000 /* seconds to milliseconds */);
    }
  }

  /**
   * Turns the fan on or off
   * @value ACTIVE to turn the fan on, INACTIVE to turn it off
   */
  async setActive(value: CharacteristicValue) {
    const isOn = value === this.CharActive.ACTIVE;
    await firstValueFrom(this.platform.alexaClient.sendDeviceAction(
      this.controlId, new FanPowerToggleCommand(isOn)));
    this.platform.log.debug('Set Characteristic Active -> ', isOn);
  }

  /**
   * Gets the current power state of the fan
   * @returns ACTIVE if the fan is on, INACTIVE if it is off
   */
  async getActive(): Promise<CharacteristicValue> {
    // Trigger an update pass. Subscribe to the observable first, to
    // ensure that transforms are applied.
    const newState = firstValueFrom(this.fanStatus$);
    this.requestedFanUpdate$.next();

    const { isOn } = await newState;
    if (isOn == null) {
      // Couldn't get a status
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const value = isOn ? this.CharActive.ACTIVE : this.CharActive.INACTIVE;
    this.platform.log.debug('Get Characteristic Active ->', value);
    return value;
  }

  /**
   * Sets the speed of the fan
   * @value Should be a number from 0 to 100. Fan has four modes, so it'll
   * choose one of those based on the provided percentage
   */
  async setIntensity(value: CharacteristicValue) {
    if (value === 0) {
      // Homekit will send a separate request to turn the fan off, so just ignore
      // this request.
      // It's important that 0 is a valid value, otherwise '25' will act as the
      // off switch.
      this.platform.log.debug('Refusing to set intensity to 0');
      return;
    }
    const intensity = Math.floor((value as number - 1) / 25);
    await firstValueFrom(this.platform.alexaClient.sendDeviceAction(
      this.controlId, new FanIntensityChangeCommand(
        intensity.toFixed(0) as '0' | '1' | '2' | '3')));
    this.platform.log.debug('Set Characteristic Intensity -> ', intensity);
  }

  /**
   * Gets the current rotation intensity for the fan, translating from the fan's modes to a
   * percentage. Uses a shared Observable.
   */
  async getIntensity(): Promise<CharacteristicValue> {
    // Trigger an update pass. Subscribe to the observable first, to
    // ensure that transforms are applied.
    const newState = firstValueFrom(this.fanStatus$);
    this.requestedFanUpdate$.next();

    const { fanIntensity } = await newState;
    this.platform.log.debug('Get Characteristic Intensity ->', fanIntensity);

    if (fanIntensity == null) {
      // Couldn't get a status
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.fanIntensityToPercentage(fanIntensity);
  }

  /**
   * Sets whether or not the fan is oscillating
   * @value Should be SWING_ENABLED / SWING_DISABLED
   */
  async setSwingMode(value: CharacteristicValue) {
    const isOscillating = value === this.platform.Characteristic.SwingMode.SWING_ENABLED ? true : false;
    await firstValueFrom(this.platform.alexaClient.sendDeviceAction(
      this.controlId, new FanOscillationToggleCommand(isOscillating)));
    this.platform.log.debug('Set Characteristic Oscillation On -> ', isOscillating);
  }

  /**
   * Checks if the fan is oscillating or not, using a shared Observable.
   */
  async getSwingMode(): Promise<CharacteristicValue> {
    // Trigger an update pass. Subscribe to the observable first, to
    // ensure that transforms are applied.
    const newState = firstValueFrom(this.fanStatus$);
    this.requestedFanUpdate$.next();

    const { isOscillating } = await newState;
    this.platform.log.debug('Get Characteristic Oscillation On ->', isOscillating);

    if (isOscillating == null) {
      // Couldn't get a status
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return isOscillating ?
      this.platform.Characteristic.SwingMode.SWING_ENABLED :
      this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }


  // Any time we check state for any characteristic of the fan, update all characteristics
  private updateCharacteristics(fanStatus: FanStatus) {
    if (fanStatus.isOn != null) {
      this.service.updateCharacteristic(
        this.CharActive,
        fanStatus.isOn ?
          this.platform.Characteristic.Active.ACTIVE :
          this.platform.Characteristic.Active.INACTIVE);
    }
    if (fanStatus.fanIntensity != null) {
      this.service.updateCharacteristic(
        OSCR37RotationSpeed,
        this.fanIntensityToPercentage(fanStatus.fanIntensity));
    }
    if (fanStatus.isOscillating != null) {
      this.service.updateCharacteristic(
        this.CharSwingMode,
        fanStatus.isOscillating ?
          this.platform.Characteristic.SwingMode.SWING_ENABLED :
          this.platform.Characteristic.SwingMode.SWING_DISABLED);
    }
  }

  private fanIntensityToPercentage(intensity: string) {
    switch (intensity) {
      case '0':
        return 25;
      case '1':
        return 50;
      case '2':
        return 75;
      case '3':
        return 100;
      default:
        throw new Error(`Unexpected intensity ${intensity} not supported`);
    }
  }

}
