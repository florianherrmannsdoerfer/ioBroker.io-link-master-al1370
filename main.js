'use strict';

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// const fs = require("fs");
const axios = require('axios').default;
const {performance} = require('perf_hooks');
const CONFIG = require('./config.js');

class UnidentifiedSensorError extends Error {
	constructor(message, sensorName) {
		super(message);
		this.name = 'UnidentifiedSensorError';
		this.sensorName = sensorName;
	}
}

class IoLinkMasterAl1370 extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'io-link-master-al1370',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	sleep() {
		return new Promise(resolve => setTimeout(resolve, this.config.sleepTimer));
	}

	getRequestBody(adr) {
		return `{"code": "request", "cid": 1, "adr": "${adr}"}`;
	}

	async getValue(requestBody) {

		let data;

		await axios.post(`http://${this.config.ioLinkIp}`,
			requestBody
		).then(response => {
			data = response.data?.['data']?.['value'];
		}).catch(error => {
			this.log.error(error.response.data);
			this.log.error(error.response.status);
			this.log.error(error.response.headers);
		});
		return data;
	}

	async getSensorPortMap() {
		const sensorIdPortMap = new Map();
		for (let i = 1; i <= CONFIG.ports; i++) {
			const sensorPort = i;
			const productName = await this.getValue(this
				.getRequestBody(`/iolinkmaster/port[${sensorPort}]/iolinkdevice/productname/getdata`))
				.catch(error => {
					this.log.error(error);
					this.stop;
				});
			if (CONFIG.sensors.includes(productName))
				sensorIdPortMap.set(sensorPort, productName);
			else
				throw new UnidentifiedSensorError('Could not find Sensor: ' + productName + ' in Config!', productName);
		}
		return sensorIdPortMap;
	}

	roundNumberTwoDigits(number) {
		return Number((Math.round(number * 100) / 100).toFixed(2));
	}

	parseHexToInt16(number) {
		const int16 = parseInt(number, 16);
		if ((int16 & 0x8000) > 0) {
			return (int16 - 0x10000);
		}
		return int16;
	}

	async getValueForSensor135(sensorPort) {
		const hexString = await this.getValue(this
			.getRequestBody(`/iolinkmaster/port[${sensorPort}]/iolinkdevice/pdin/getdata`))
			.catch(error => {
				this.log.error(error);
				this.stop;
			});
		const humiditySub = hexString.substring(0, 4);
		let humidity = this.parseHexToInt16(humiditySub);
		humidity = humidity * 0.1;

		const tempSub = hexString.substring(8, 12);
		let temp = this.parseHexToInt16(tempSub);
		temp = temp * 0.1;

		return [humidity, temp];
	}

	async getValueForSensor6(sensorPort) {
		const hexString = await this.getValue(this
			.getRequestBody(`/iolinkmaster/port[${sensorPort}]/iolinkdevice/pdin/getdata`))
			.catch(error => {
				this.log.error(error);
				this.stop;
			});
		const temperatureFlow = this.parseHexToInt16(hexString);
		return (temperatureFlow * 0.1);
	}

	async getValueForSensor25(sensorPort) {
		const hexString = await this
			.getValue(this.getRequestBody(`/iolinkmaster/port[${sensorPort}]/iolinkdevice/pdin/getdata`))
			.catch(error => {
				this.log.error(error);
				this.stop;
			});
		const wordZero = parseInt(hexString.substring(0, 4), 16);
		return (wordZero >> 2);
	}

	async getValueForSensor48(sensorPort) {
		const hexString = await this.getValue(this
			.getRequestBody(`/iolinkmaster/port[${sensorPort}]/iolinkdevice/pdin/getdata`))
			.catch(error => {
				this.log.error(error);
				this.stop;
			});
		const flow = this.parseHexToInt16(hexString.substring(0, 4));
		const temperatureReturn = ((parseInt(hexString.substring(4, 8), 16)) >> 2) * 0.1;
		return [flow, temperatureReturn];
	}

	async checkIsHostAlive() {
		try {
			await this.getValue(this
				.getRequestBody(`/deviceinfo/productcode/getdata`)).catch(error => {
				this.log.error(error);
				this.stop;
			});
			return true;
		} catch (error) {
			return false;
		}
	}

	async initHost() {
		return await this.checkIsHostAlive().catch((error) => {
			this.log.error(error);
			this.stop;
		});
	}

	async createObjectTree() {
		await this.setObjectNotExistsAsync(CONFIG.prefixPorts, {
			type: 'channel',
			common: {
				name: 'Sensors',
			},
			native: {},
		});
	}

	async checkIfHostIsAlive() {

		await this.setObjectNotExistsAsync('isHostAlive', {
			type: 'state',
			common: {
				name: 'isHostAlive',
				type: 'boolean',
				role: 'value.isHostAlive',
				read: true,
				write: false,
			},
			native: {},
		});
		this.subscribeStates('isHostAlive');
		let isHostAlive = false;

		await this.checkIsHostAlive().then(() => {
			isHostAlive = true;
		}, () => {
			isHostAlive = false;
		}).catch(error =>
			this.log.error('Host unreachable! ' + error));

		if (isHostAlive) {
			const getLastState = await this.getStateAsync('isHostAlive');
			if (getLastState == null) {
				await this.setStateAsync('isHostAlive', {val: true, ack: true});
			} else {
				if (getLastState.val === false)
					await this.setStateAsync('isHostAlive', {val: true, ack: true});
			}
			return true;
		} else {
			await this.setStateAsync('isHostAlive', {val: false, ack: true});
			return false;
		}
	}

	async getValuesAndWriteValues() {
		let tempFlow = null;
		let tempReturn = null;
		await this.getSensorPortMap().then(async (sensorPortMap) => {
			for (const [sensorPort, productName] of sensorPortMap) {
				this.setObjectNotExists(`${CONFIG.prefixPorts}.Port${sensorPort}`, {
					type: 'device',
					common: {
						name: `Port${sensorPort}`,
						type: 'string',
						role: 'value.SensorName',
						read: true,
						write: false,
					},
					native: {},
				});
				this.setState(`${CONFIG.prefixPorts}.Port${sensorPort}`, {
					val: productName,
					ack: true
				});
				if (productName === 'AH002') {
					const resultSensor135 = await this.getValueForSensor135(1);
					const humidityRack = resultSensor135[0];
					const temperatureRack = resultSensor135[1];
					await this.setObjectNotExistsAsync('temperatureRack', {
						type: 'state',
						common: {
							name: 'temperatureRack',
							type: 'number',
							role: 'value.temperatureRack',
							unit: '°C',
							read: true,
							write: false,
						},
						native: {},
					});
					//TODO: identifier infront of all states to just subscribe to identifier.*
					this.subscribeStates('temperatureRack');
					await this.setStateAsync('temperatureRack', {
						val: this.roundNumberTwoDigits(temperatureRack),
						ack: true
					});

					await this.setObjectNotExistsAsync('humidityRack', {
						type: 'state',
						common: {
							name: 'humidityRack',
							type: 'number',
							role: 'value.humidityRack',
							unit: '%',
							read: true,
							write: false,
						},
						native: {},
					});
					this.subscribeStates('humidityRack');
					await this.setStateAsync('humidityRack', {val: this.roundNumberTwoDigits(humidityRack), ack: true});
				} else if (productName === 'AT001') {
					const temperatureFlow = await this.getValueForSensor6(sensorPort);
					tempFlow = temperatureFlow;
					await this.setObjectNotExistsAsync('temperatureFlow', {
						type: 'state',
						common: {
							name: 'temperatureFlow',
							type: 'number',
							role: 'value.temperatureFlow',
							unit: '°C',
							read: true,
							write: false,
						},
						native: {},
					});
					this.subscribeStates('temperatureFlow');
					await this.setStateAsync('temperatureFlow', {
						val: this.roundNumberTwoDigits(temperatureFlow),
						ack: true
					});
				} else if (productName === 'AP011') {
					const pressure = await this.getValueForSensor25(sensorPort);
					await this.setObjectNotExistsAsync('pressure', {
						type: 'state',
						common: {
							name: 'Pressure',
							type: 'number',
							role: 'value.pressure',
							unit: 'Bar',
							read: true,
							write: false,
						},
						native: {},
					});
					this.subscribeStates('pressure');
					await this.setStateAsync('pressure', {val: this.roundNumberTwoDigits(pressure), ack: true});
				} else if (productName === 'AS005_LIQU') {
					//TODO: handel ul ol thingy
					const resultSensor48 = await this.getValueForSensor48(sensorPort);
					const flow = resultSensor48[0];
					const temperatureReturn = resultSensor48[1];
					tempReturn = temperatureReturn;

					await this.setObjectNotExistsAsync('flow', {
						type: 'state',
						common: {
							name: 'flow',
							type: 'number',
							role: 'value.flow',
							unit: 'l/h',
							read: true,
							write: false,
						},
						native: {},
					});
					this.subscribeStates('flow');
					await this.setStateAsync('flow', {val: this.roundNumberTwoDigits(flow), ack: true});

					await this.setObjectNotExistsAsync('temperatureReturn', {
						type: 'state',
						common: {
							name: 'temperatureReturn',
							type: 'number',
							role: 'value.temperatureReturn',
							unit: '°C',
							read: true,
							write: false,
						},
						native: {},
					});
					this.subscribeStates('temperatureReturn');
					await this.setStateAsync('temperatureReturn', {
						val: this.roundNumberTwoDigits(temperatureReturn),
						ack: true
					});

				} else {
					throw new Error('unidentified sensor');
				}
			}

		}).catch(error => {
			this.log.error(error);
			this.stop;
		});

		if (tempFlow != null && tempReturn != null) {
			const temperatureDelta = tempReturn - tempFlow;

			await this.setObjectNotExistsAsync('temperatureDelta', {
				type: 'state',
				common: {
					name: 'temperatureDelta',
					type: 'number',
					role: 'value.temperatureDelta',
					unit: '°C',
					read: true,
					write: false,
				},
				native: {},
			});
			this.subscribeStates('temperatureDelta');
			await this.setStateAsync('temperatureDelta', {val: this.roundNumberTwoDigits(temperatureDelta), ack: true});
		}
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {

		const hostAlive = true;

		await this.createObjectTree().catch(error => {
			this.log.error(error);
			this.stop;
		});

		await this.initHost().catch(error => {
			this.log.error(error);
			this.stop;
		});

		while (hostAlive) {
			const start = performance.now();
			const checkHostAliveTries = 3;

			for (let i = 0; i < checkHostAliveTries; i++) {
				await this.checkIfHostIsAlive().then(() => {
					this.getValuesAndWriteValues();
					i = checkHostAliveTries;
				}).catch(() => {
					this.log.warn('Could not reach host!');
					this.log.warn('Try Nbr. ' + (i + 1) + 'of ' + checkHostAliveTries);
					this.sleep();
				});
				if (i === (checkHostAliveTries - 1)) {
					this.log.error('Could not reach Host, shutting Adapter down!');
					this.stop;
				}
			}


			const end = performance.now();
			this.log.info('Finished run in: ' + (end - start) + 'ms');
			this.log.info('Going to sleep now for: ' + this.config.sleepTimer + 'ms');
			await this.sleep().catch(error => {
				this.log.error(error);
				this.stop;
			});
		}

	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new IoLinkMasterAl1370(options);
} else {
	// otherwise start the instance directly
	new IoLinkMasterAl1370();
}