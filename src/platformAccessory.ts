import { Service, PlatformAccessory, CharacteristicValue, Characteristic } from 'homebridge';
import { debounceTime, firstValueFrom, Subject } from 'rxjs';
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

  private currentState: FanStatus = {
    isOn: false,
    fanIntensity: '0',
    isOscillating: false,
  };

  private requestedFanUpdate$: Subject<void> = new Subject();

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

    // Subscribe indefinitely - we never destroy this
    this.requestedFanUpdate$.pipe(debounceTime(50)).subscribe(async () => {
      this.currentState = await firstValueFrom(
        this.platform.alexaClient.getDeviceStatus(this.queryId));
      this.updateCharacteristics(this.currentState);
    });

    if (this.platform.config.enablePolling) {
      setInterval(async () => {
        this.requestedFanUpdate$.next();
      }, this.platform.config.pollInterval * 1000 /* seconds to milliseconds */);
    }
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Fan.
   */
  async setActive(value: CharacteristicValue) {
    const isOn = value === this.platform.Characteristic.Active.ACTIVE;
    await firstValueFrom(this.platform.alexaClient.sendDeviceAction(
      this.controlId, new FanPowerToggleCommand(isOn)));
    this.platform.log.debug('Set Characteristic On ->', value);
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Fan is on.
   *
   * GET requests should return as fast as possbile. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.Active, true)
   */
  async getActive(): Promise<CharacteristicValue> {
    // Trigger an update pass
    this.requestedFanUpdate$.next();

    const {isOn} = this.currentState;
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
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Intensity
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

  async getIntensity(): Promise<CharacteristicValue> {
    // Trigger an update pass
    this.requestedFanUpdate$.next();

    const {fanIntensity} = this.currentState;
    this.platform.log.debug('Get Characteristic Intensity ->', fanIntensity);

    if (fanIntensity == null) {
      // Couldn't get a status
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.fanIntensityToPercentage(fanIntensity);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Intensity
   */
  async setSwingMode(value: CharacteristicValue) {
    const isOscillating = value === this.platform.Characteristic.SwingMode.SWING_ENABLED ? true : false;
    await firstValueFrom(this.platform.alexaClient.sendDeviceAction(
      this.controlId, new FanOscillationToggleCommand(isOscillating)));
    this.platform.log.debug('Set Characteristic Oscillation On -> ', isOscillating);
  }

  async getSwingMode(): Promise<CharacteristicValue> {
    // Trigger an update pass
    this.requestedFanUpdate$.next();

    const {isOscillating} = this.currentState;
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
