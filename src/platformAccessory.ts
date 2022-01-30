import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { firstValueFrom } from 'rxjs';
import { FanPowerToggleCommand, FanIntensityChangeCommand, FanOscillationToggleCommand } from './alexaApi';

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
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))                // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this));               // GET - bind to the `getOn` method below

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setIntensity.bind(this))
      .onGet(this.getIntensity.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onSet(this.setSwingMode.bind(this))
      .onGet(this.getSwingMode.bind(this));

    /**
     * Creating multiple services of the same type.
     *
     * To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
     * when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
     * this.accessory.getService('NAME') || this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE_ID');
     *
     * The USER_DEFINED_SUBTYPE must be unique to the platform accessory (if you platform exposes multiple accessories, each accessory
     * can use the same sub type id.)
     */

    // Example: add two "motion sensor" services to the accessory
    // const motionSensorOneService = this.accessory.getService('Motion Sensor One Name') ||
    //   this.accessory.addService(this.platform.Service.MotionSensor, 'Motion Sensor One Name', 'YourUniqueIdentifier-1');

    // const motionSensorTwoService = this.accessory.getService('Motion Sensor Two Name') ||
    //   this.accessory.addService(this.platform.Service.MotionSensor, 'Motion Sensor Two Name', 'YourUniqueIdentifier-2');

    /**
     * Updating characteristics values asynchronously.
     *
     * Example showing how to update the state of a Characteristic asynchronously instead
     * of using the `on('get')` handlers.
     * Here we change update the motion sensor trigger states on and off every 10 seconds
     * the `updateCharacteristic` method.
     *
     */
    // let motionDetected = false;
    // setInterval(() => {
    //   // EXAMPLE - inverse the trigger
    //   motionDetected = !motionDetected;

    //   // push the new value to HomeKit
    //   motionSensorOneService.updateCharacteristic(this.platform.Characteristic.MotionDetected, motionDetected);
    //   motionSensorTwoService.updateCharacteristic(this.platform.Characteristic.MotionDetected, !motionDetected);

    //   this.platform.log.debug('Triggering motionSensorOneService:', motionDetected);
    //   this.platform.log.debug('Triggering motionSensorTwoService:', !motionDetected);
    // }, 10000);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Fan.
   */
  async setOn(value: CharacteristicValue) {
    // implement your own code to turn your device on/off
    await firstValueFrom(this.platform.alexaClient.sendDeviceAction(
      this.controlId, new FanPowerToggleCommand(value as boolean)));
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
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getOn(): Promise<CharacteristicValue> {
    // implement your own code to check if the device is on
    const status =
      await firstValueFrom(this.platform.alexaClient.getDeviceStatus(this.queryId));
    const {isOn} = status;
    this.platform.log.debug('Get Characteristic On ->', isOn);

    if (isOn == null) {
      // Couldn't get a status
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return isOn as CharacteristicValue;
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Intensity
   */
  async setIntensity(value: CharacteristicValue) {
    const percentage = value as number;
    if (percentage === 0) {
      return this.setOn(false);
    }
    const intensity = percentage <= 25 ? '0' : percentage <= 50 ? '1' : percentage <= 75 ? '2' : '3';
    await firstValueFrom(this.platform.alexaClient.sendDeviceAction(
      this.controlId, new FanIntensityChangeCommand(intensity)));
    this.platform.log.debug('Set Characteristic Intensity -> ', intensity);
  }

  async getIntensity(): Promise<CharacteristicValue> {
    const status =
      await firstValueFrom(this.platform.alexaClient.getDeviceStatus(this.queryId));
    const {isOn, fanIntensity} = status;
    this.platform.log.debug('Get Characteristic Intensity ->', fanIntensity);

    if (isOn === false) {
      return 0; // intensity is 0 if we're off
    }

    if (fanIntensity == null) {
      // Couldn't get a status
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return fanIntensity === '0' ? 25 : fanIntensity === '1' ? 50 : fanIntensity === '2' ? 75 : 100;
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
    const status =
      await firstValueFrom(this.platform.alexaClient.getDeviceStatus(this.queryId));
    const {isOscillating} = status;
    this.platform.log.debug('Get Characteristic Oscillation On ->', isOscillating);

    if (isOscillating == null) {
      // Couldn't get a status
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return isOscillating ?
      this.platform.Characteristic.SwingMode.SWING_ENABLED :
      this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }

}
