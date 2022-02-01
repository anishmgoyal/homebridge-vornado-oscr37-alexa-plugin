import { Characteristic, Formats, Service, Perms, Units } from 'hap-nodejs';

/**
 * Rotation speed for the fan, which has 4 intensity modes, and one
 * off mode. Scale the percentage to the 4 supported states.
 */
export class OSCR37RotationSpeed extends Characteristic {
    public static readonly UUID = Characteristic.RotationSpeed.UUID;

    constructor() {
        super("Rotation Speed", OSCR37RotationSpeed.UUID, {
            format: Formats.FLOAT,
            perms: [Perms.NOTIFY, Perms.PAIRED_READ, Perms.PAIRED_WRITE],
            minValue: 0,
            maxValue: 100,
            minStep: 25,
            unit: Units.PERCENTAGE,
        });
        this.value = this.getDefaultValue();
    }
}

/**
 * Defines a fan service specific to the OSCR37, which has a custom
 * limitation on the rotation speed options
 */
export class OSCR37FanService extends Service {
    public static readonly UUID = Service.Fanv2.UUID;

    constructor(displayName?: string, subtype?: string) {
        super(displayName, OSCR37FanService.UUID, subtype);

        // Required Characteristics
        this.addCharacteristic(Characteristic.Name);
        this.addCharacteristic(Characteristic.Active);
        this.addCharacteristic(OSCR37RotationSpeed);
        this.addCharacteristic(Characteristic.SwingMode);
    }
}
