'use strict';

/**
 * External Z2M converter for HOBEIAN ZG-204ZV-d (ZigbeeTLc custom firmware v0138+)
 * Hardware: TLSR8253F512ET32, XBR818 mmWave, WHT20 T&H, photo-resistor LUX, 2×AAA
 *
 * Property names intentionally match the factory ZG-204ZV Tuya device for familiarity.
 * Settings are read/written via standard ZCL custom attributes (not Tuya DPs).
 *
 * Writable attributes:
 *   msOccupancySensing     0x0010  pirOToUDelay       UINT16  fading_time (0-524 s, XBR818 hw cap)
 *   msOccupancySensing     0x0012  pirUToOThreshold   UINT8   sensitivity raw 0-255 <-> exposed 0-19
 *   hvacThermostatUiCfg    0x0107  measureInterval    UINT8   illuminance_interval (3-255 s)
 *   hvacThermostatUiCfg    0x0100  temp_offset        INT16   temperature_calibration (×0.01 °C)
 *   hvacThermostatUiCfg    0x0101  humi_offset        INT16   humidity_calibration (×0.01 %)
 *   genOnOff               on/off  LED                        indicator ON/OFF
 */

const {battery, illuminance, temperature, humidity} =
    require('zigbee-herdsman-converters/lib/modernExtend');
const e = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const ea = e.access;

/* Sensitivity scale: firmware thres 0-255 <-> Z2M 0-19 (matches factory ZG-204ZV range) */
const sensitivityToThres = (s) => Math.round(s * 255 / 19);
const thresToSensitivity = (t) => Math.round(t * 19 / 255);

const fzLocal = {
    presence: {
        cluster: 'msOccupancySensing',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.occupancy !== undefined)
                result.presence = msg.data.occupancy === 1;
            if (msg.data.pirOToUDelay !== undefined)
                result.fading_time = msg.data.pirOToUDelay;
            if (msg.data.pirUToOThreshold !== undefined)
                result.motion_detection_sensitivity = thresToSensitivity(msg.data.pirUToOThreshold);
            // Try to attach OTA info (latest source and short notes) if available
            try {
                if (global.__ZG_OTA_INFO && global.__ZG_OTA_INFO.url) {
                    result.latest_source = global.__ZG_OTA_INFO.url;
                    result.latest_release_notes = `fileVersion:${global.__ZG_OTA_INFO.fileVersion} ${global.__ZG_OTA_INFO.otaHeaderString || ''}`;
                }
            } catch (e) {
                // noop
            }
            return Object.keys(result).length ? result : undefined;
        },
    },
    indicator: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.onOff !== undefined)
                return {indicator: msg.data.onOff ? 'ON' : 'OFF'};
        },
    },
    thUiCfg: {
        cluster: 'hvacThermostatUiCfg',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data[0x0107] !== undefined)
                result.illuminance_interval = msg.data[0x0107];
            if (msg.data[0x0100] !== undefined)
                result.temperature_calibration = +(msg.data[0x0100] / 100).toFixed(2);
            if (msg.data[0x0101] !== undefined)
                result.humidity_calibration = +(msg.data[0x0101] / 100).toFixed(2);
            return Object.keys(result).length ? result : undefined;
        },
    },
};

const tzLocal = {
    fading_time: {
        key: ['fading_time'],
        convertSet: async (entity, key, value, meta) => {
            const v = Math.min(524, Math.max(0, Math.round(Number(value))));
            await entity.write('msOccupancySensing', {pirOToUDelay: v});
            return {state: {fading_time: v}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('msOccupancySensing', ['pirOToUDelay']);
        },
    },
    motion_detection_sensitivity: {
        key: ['motion_detection_sensitivity'],
        convertSet: async (entity, key, value, meta) => {
            const s = Math.min(19, Math.max(0, Math.round(Number(value))));
            const t = sensitivityToThres(s);
            await entity.write('msOccupancySensing', {pirUToOThreshold: t});
            return {state: {motion_detection_sensitivity: s}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('msOccupancySensing', ['pirUToOThreshold']);
        },
    },
    indicator: {
        key: ['indicator'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command('genOnOff', value === 'ON' ? 'on' : 'off', {});
            return {state: {indicator: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genOnOff', ['onOff']);
        },
    },
    sws_debug: {
        key: ['sws_debug'],
        convertSet: async (entity, key, value, meta) => {
            // write On/Off attribute to trigger runtime-only SWS debug in firmware
            await entity.write('genOnOff', {onOff: value === 'ON'});
            return {state: {sws_debug: value === 'ON'}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genOnOff', ['onOff']);
        },
    },
    illuminance_interval: {
        key: ['illuminance_interval'],
        convertSet: async (entity, key, value, meta) => {
            const v = Math.min(255, Math.max(3, Math.round(Number(value))));
            // some z2m/h herdsman builds may not expose the cluster name mapping;
            // try by name first, then fallback to numeric cluster id 0x0204 (516)
            if (entity.cluster && entity.cluster.hvacThermostatUiCfg) {
                await entity.write('hvacThermostatUiCfg', {[0x0107]: {value: v, type: 0x20}});
            } else {
                await entity.write(0x0204, {[0x0107]: {value: v, type: 0x20}});
            }
            return {state: {illuminance_interval: v}};
        },
        convertGet: async (entity, key, meta) => {
            if (entity.cluster && entity.cluster.hvacThermostatUiCfg) {
                await entity.read('hvacThermostatUiCfg', [0x0107]);
            } else {
                await entity.read(0x0204, [0x0107]);
            }
        },
    },
    temperature_calibration: {
        key: ['temperature_calibration'],
        convertSet: async (entity, key, value, meta) => {
            const v = Math.round(Number(value) * 100);
            if (entity.cluster && entity.cluster.hvacThermostatUiCfg) {
                await entity.write('hvacThermostatUiCfg', {[0x0100]: {value: v, type: 0x29}});
            } else {
                await entity.write(0x0204, {[0x0100]: {value: v, type: 0x29}});
            }
            return {state: {temperature_calibration: +(v / 100).toFixed(2)}};
        },
        convertGet: async (entity, key, meta) => {
            if (entity.cluster && entity.cluster.hvacThermostatUiCfg) {
                await entity.read('hvacThermostatUiCfg', [0x0100]);
            } else {
                await entity.read(0x0204, [0x0100]);
            }
        },
    },
    humidity_calibration: {
        key: ['humidity_calibration'],
        convertSet: async (entity, key, value, meta) => {
            const v = Math.round(Number(value) * 100);
            if (entity.cluster && entity.cluster.hvacThermostatUiCfg) {
                await entity.write('hvacThermostatUiCfg', {[0x0101]: {value: v, type: 0x29}});
            } else {
                await entity.write(0x0204, {[0x0101]: {value: v, type: 0x29}});
            }
            return {state: {humidity_calibration: +(v / 100).toFixed(2)}};
        },
        convertGet: async (entity, key, meta) => {
            if (entity.cluster && entity.cluster.hvacThermostatUiCfg) {
                await entity.read('hvacThermostatUiCfg', [0x0101]);
            } else {
                await entity.read(0x0204, [0x0101]);
            }
        },
    },
};

const definition = {
    zigbeeModel: ['ZG-204ZV-d'],
    model: 'ZG-204ZV-d',
    vendor: 'HOBEIAN',
    description: 'Millimeter wave motion + illuminance + T&H (ZigbeeTLc custom firmware)',
    icon: 'https://www.zigbee2mqtt.io/images/devices/ZG-204ZV.png',
    extend: [battery(), illuminance(), temperature(), humidity()],
    fromZigbee: [fzLocal.presence, fzLocal.indicator, fzLocal.thUiCfg],
    toZigbee: [
        tzLocal.fading_time,
        tzLocal.motion_detection_sensitivity,
        tzLocal.indicator,
        tzLocal.sws_debug,
        tzLocal.illuminance_interval,
        tzLocal.temperature_calibration,
        tzLocal.humidity_calibration,
    ],
    exposes: [
        e.binary('presence', ea.STATE, true, false)
            .withDescription('Indicates whether the device detected presence'),
        e.numeric('fading_time', ea.STATE_SET)
            .withValueMin(0).withValueMax(524).withValueStep(1)
            .withUnit('s').withDescription('Motion keep time'),
        e.binary('indicator', ea.STATE_SET, 'ON', 'OFF')
            .withDescription('LED indicator mode'),
        e.numeric('illuminance_interval', ea.STATE_SET)
            .withValueMin(3).withValueMax(255).withValueStep(1)
            .withUnit('s').withDescription('Illuminance measurement interval'),
        e.numeric('motion_detection_sensitivity', ea.STATE_SET)
            .withValueMin(0).withValueMax(19).withValueStep(1)
            .withDescription('Motion detection sensitivity (0=min, 19=max); default≈9'),
        e.numeric('temperature_calibration', ea.STATE_SET)
            .withValueMin(-10).withValueMax(10).withValueStep(0.1)
            .withUnit('°C').withDescription('Temperature calibration offset'),
        e.numeric('humidity_calibration', ea.STATE_SET)
            .withValueMin(-30).withValueMax(30).withValueStep(0.1)
            .withUnit('%').withDescription('Humidity calibration offset'),
        e.switch('sws_debug', ea.STATE_SET)
            .withDescription('SWS debug mode (runtime, auto-disable)'),
    ],
    configure: async (device, coordinatorEndpoint) => {
        const endpoint = device.getEndpoint(1);
        await reporting.bind(endpoint, coordinatorEndpoint, ['msOccupancySensing']);
        await reporting.occupancy(endpoint);
        // Fetch OTA index (cached) and store a best-match entry for this model.
        // Selection rules:
        // - If device model contains "-d", prefer env `ZG_OTA_INDEX_D_URL`.
        // - Else use env `ZG_OTA_INDEX_URL` or fall back to pvvx.
        try {
            const https = require('https');
            const modelId = device.modelID || device.model || (device.zigbeeModel && device.zigbeeModel[0]) || '';
            const defaultPvvx = 'https://raw.githubusercontent.com/pvvx/ZigbeeTLc/master/bin/index_v0138.json';
            const defaultMegusd = 'https://raw.githubusercontent.com/megusd/ZigbeeTLc/master/bin/index_v0138.json';
            let idxUrl = process.env.ZG_OTA_INDEX_URL || defaultPvvx;
            if (modelId.indexOf('-d') !== -1) {
                idxUrl = process.env.ZG_OTA_INDEX_D_URL || defaultMegusd || idxUrl;
                if (!process.env.ZG_OTA_INDEX_D_URL) {
                    // default to megusd raw index if user didn't set env var
                    // (this prevents pvvx index from being used for -d devices)
                    // eslint-disable-next-line no-console
                    console.info('ZG-204ZV-d: using default megusd OTA index', idxUrl);
                }
            }

            if (!global.__ZG_OTA_INFO) {
                global.__ZG_OTA_INFO = {};
                https.get(idxUrl, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        try {
                            const arr = JSON.parse(data);
                            // Prefer exact model match, then otaHeaderString, then first entry
                            const found = arr.find(e => (e.modelId && modelId && e.modelId === modelId)
                                || (e.otaHeaderString && modelId && e.otaHeaderString.indexOf(modelId) !== -1)
                                || (e.modelId && e.modelId.indexOf('ZG-204ZV') !== -1));
                            if (found) {
                                global.__ZG_OTA_INFO = found;
                            } else if (arr.length) {
                                global.__ZG_OTA_INFO = arr[0];
                            }
                        } catch (e) {}
                    });
                }).on('error', (/*err*/) => {});
            }
        } catch (e) {}
    },
    ota: true,
};

module.exports = definition;
