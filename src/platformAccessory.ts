import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { firstValueFrom, Subject } from 'rxjs';
import { shareReplay, switchMap, tap, throttleTime } from 'rxjs/operators';
import { FanPowerToggleCommand, FanIntensityChangeCommand, FanOscillationToggleCommand, FanStatus } from './alexaApi';

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

  // Let's try our best to group requests to get fan state, if
  // requests come in at the same time
  private fanStatus$ = this.requestedFanUpdate$.pipe(
    throttleTime(100),
    switchMap(() => this.platform.alexaClient.getDeviceStatus(this.queryId)),
    tap(status => this.updateCharacteristics(status)),
    shareReplay({bufferSize: 1, refCount: true}),
  );

  constructor(
    private readonly platform: OSCR37HomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.displayName = accessory.context.device.displayName;
    this.controlId = accessory.context.device.controlId;
    this.queryId = accessory.context.device.queryId;

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Vornado')
      .setCharacteristic(this.platform.Characteristic.Model, 'OSCR37')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.controlId);

    // get the Fan service if it exists, otherwise create a new Fan service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Fanv2) || this.accessory.addService(this.platform.Service.Fanv2);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.displayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Fanv2

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))                // SET - bind to the `setActive` method below
      .onGet(this.getActive.bind(this));               // GET - bind to the `getActive` method below

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setIntensity.bind(this))
      .onGet(this.getIntensity.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onSet(this.setSwingMode.bind(this))
      .onGet(this.getSwingMode.bind(this));

    if (this.platform.config.enablePolling) {
      setInterval(async () => {
        // Create a subscriber for the fan status observable, to make sure that
        // the transforms are actually applied; otherwise, nothing will happen
        const newState = firstValueFrom(this.fanStatus$);
        this.requestedFanUpdate$.next();
        // We don't need to do anything with the state, because one side effect
        // of the observable is that we update the states
        await newState;
      }, this.platform.config.pollInterval * 1000 /* seconds to milliseconds */);
    }
  }

  /**
   * Sets whether or not the fan is active
   * @value Should be ACTIVE or INACTIVE
   */
  async setActive(value: CharacteristicValue) {
    const isOn = value === this.platform.Characteristic.Active.ACTIVE;
    await firstValueFrom(this.platform.alexaClient.sendDeviceAction(
      this.controlId, new FanPowerToggleCommand(isOn)));
    this.platform.log.debug('Set Characteristic On ->', value);
  }

  /**
   * Gets whether or not the fan is active, using a shared Observable.
   */
  async getActive(): Promise<CharacteristicValue> {
    // Trigger an update pass. Subscribe to the observable first, to
    // ensure that transforms are applied.
    const newState = firstValueFrom(this.fanStatus$);
    this.requestedFanUpdate$.next();

    const {isOn} = await newState;
    this.platform.log.debug('Get Characteristic On ->', isOn);

    if (isOn == null) {
      // Couldn't get a status
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return isOn ?
      this.platform.Characteristic.Active.ACTIVE :
      this.platform.Characteristic.Active.INACTIVE;
  }

  /**
   * Sets the speed of the fan
   * @value Should be a number from 0 to 100. Fan has four modes, so it'll
   * choose one of those based on the provided percentage
   */
  async setIntensity(value: CharacteristicValue) {
    const percentage = value as number;
    if (percentage === 0) {
      return this.setActive(false);
    }
    const intensity = percentage <= 25 ? '0' : percentage <= 50 ? '1' : percentage <= 75 ? '2' : '3';
    await firstValueFrom(this.platform.alexaClient.sendDeviceAction(
      this.controlId, new FanIntensityChangeCommand(intensity)));
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

    const {fanIntensity} = await newState;
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

    const {isOscillating} = await newState;
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
        this.platform.Characteristic.Active,
        fanStatus.isOn ?
          this.platform.Characteristic.Active.ACTIVE :
          this.platform.Characteristic.Active.INACTIVE);
    }
    if (fanStatus.fanIntensity != null) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed,
        this.fanIntensityToPercentage(fanStatus.fanIntensity));
    }
    if (fanStatus.isOscillating != null) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.SwingMode,
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
